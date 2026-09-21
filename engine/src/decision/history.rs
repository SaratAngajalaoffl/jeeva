use std::fmt;

use async_trait::async_trait;
use chrono::Utc;
use sqlx::PgPool;

use crate::funding::FundingRecord;
use crate::market_data::MarketDataSample;

use super::execution::{realized_pnl_usd, OpenPosition};

#[derive(Debug)]
pub struct HistoryError(pub String);

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HistoryError {}

/// Upper bound on how much price history a session may request, and
/// therefore on how large the raw series handed to a decision maker can
/// get. Mirrors the API's `MAX_HISTORY_WINDOW_SAMPLES`, which rejects
/// out-of-range configs at the edge; this is the engine-side backstop.
pub const MAX_HISTORY_WINDOW_SAMPLES: u32 = 1000;

/// How a session's history window is rendered into the decision
/// maker's context. Mirrors `trading_sessions.history_format`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryFormat {
    /// Per-field min/max/average across the window.
    Summary,
    /// Every raw sample in the window, oldest first.
    Raw,
}

impl HistoryFormat {
    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "summary" => Some(Self::Summary),
            "raw" => Some(Self::Raw),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Raw => "raw",
        }
    }
}

/// Clamps a configured window into the range the engine will actually
/// read, so a hand-edited or out-of-range row can't ask for an unbounded
/// history. Mirrors `trading_sessions.history_window_samples`'s CHECK.
pub fn effective_history_window(samples: u32) -> u32 {
    samples.clamp(1, MAX_HISTORY_WINDOW_SAMPLES)
}

/// Reads recent market-data history for a PERP to build Jev's decision
/// context. The real implementation reads the TimescaleDB hypertable
/// the sampling loop (#8) writes to; tests use a fake implementation.
#[async_trait]
pub trait MarketDataHistoryReader: Send + Sync {
    /// Returns up to `limit` most recent samples for `symbol`, oldest
    /// first.
    async fn recent_samples(
        &self,
        symbol: &str,
        limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError>;
}

pub struct PostgresMarketDataHistoryReader {
    pool: PgPool,
}

impl PostgresMarketDataHistoryReader {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl MarketDataHistoryReader for PostgresMarketDataHistoryReader {
    async fn recent_samples(
        &self,
        symbol: &str,
        limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError> {
        let rows = sqlx::query_as::<_, (String, f64, f64, f64, f64, f64)>(
            r#"
            SELECT symbol, price, open_interest, volume, spread, mid_price
            FROM market_data
            WHERE symbol = $1
            ORDER BY time DESC
            LIMIT $2
            "#,
        )
        .bind(symbol)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await
        .map_err(|e| HistoryError(format!("failed to read market data history: {e}")))?;

        Ok(rows
            .into_iter()
            .rev()
            .map(
                |(symbol, price, open_interest, volume, spread, mid_price)| MarketDataSample {
                    symbol,
                    price,
                    open_interest,
                    volume,
                    spread,
                    mid_price,
                },
            )
            .collect())
    }
}

struct FieldStats {
    min: f64,
    max: f64,
    avg: f64,
}

fn field_stats(values: impl Iterator<Item = f64> + Clone) -> FieldStats {
    let count = values.clone().count().max(1) as f64;
    let sum: f64 = values.clone().sum();
    let min = values.clone().fold(f64::INFINITY, f64::min);
    let max = values.fold(f64::NEG_INFINITY, f64::max);
    FieldStats {
        min,
        max,
        avg: sum / count,
    }
}

/// Renders the current open-position status (or its absence) and,
/// when there's an open position, how long it's been held and its
/// unrealized P&L against the latest mid price.
fn position_summary(position: Option<&OpenPosition>, latest_mid_price: f64) -> String {
    match position {
        None => "position=flat".to_string(),
        Some(position) => {
            let held_for = Utc::now().signed_duration_since(position.opened_at);
            let held_minutes = held_for.num_seconds() as f64 / 60.0;
            let unrealized_pnl_usd = realized_pnl_usd(
                position.direction,
                position.entry_price,
                latest_mid_price,
                position.notional_usd,
            );
            format!(
                "position={} (opened_at={}, held_for_minutes={:.1}, entry_price={:.2}, notional_usd={:.2}, unrealized_pnl_usd={:+.2})",
                position.direction.as_str(),
                position.opened_at.to_rfc3339(),
                held_minutes,
                position.entry_price,
                position.notional_usd,
                unrealized_pnl_usd,
            )
        }
    }
}

/// Renders the most recent real funding rate seen for this PERP, or
/// its absence when no funding payment has been recorded yet.
fn funding_summary(funding: Option<&FundingRecord>) -> String {
    match funding {
        None => "funding=unknown".to_string(),
        Some(record) => format!(
            "funding_rate={:.6} (as_of={})",
            record.rate,
            record.time.to_rfc3339(),
        ),
    }
}

/// Percentage change from the first sample in the window to the latest.
fn price_change_pct(samples: &[MarketDataSample]) -> f64 {
    let first_price = samples.first().unwrap().price;
    if first_price == 0.0 {
        return 0.0;
    }
    let latest = samples.last().unwrap().price;
    (latest - first_price) / first_price * 100.0
}

/// Builds Jev's `state` context in whichever form the session is
/// configured for. Pure so it's directly testable; `Summary` is the
/// original min/max/average rendering, `Raw` hands over the whole
/// configured window as individual data points.
pub fn build_context(
    symbol: &str,
    samples: &[MarketDataSample],
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
    format: HistoryFormat,
) -> String {
    match format {
        HistoryFormat::Summary => build_context_summary(symbol, samples, position, funding),
        HistoryFormat::Raw => build_context_series(symbol, samples, position, funding),
    }
}

/// Renders the whole window as one line per field: min, max and average
/// across every sample (not just the latest), plus the current position
/// status and the most recent real funding rate. The compact default —
/// as much signal as possible without handing over a raw dump of every
/// row (see `build_context_series` for that).
pub fn build_context_summary(
    symbol: &str,
    samples: &[MarketDataSample],
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
) -> String {
    let Some(latest) = samples.last() else {
        return format!("{symbol}: no recent market data available");
    };

    let price_change_pct = price_change_pct(samples);

    let price_stats = field_stats(samples.iter().map(|s| s.price));
    let oi_stats = field_stats(samples.iter().map(|s| s.open_interest));
    let volume_stats = field_stats(samples.iter().map(|s| s.volume));
    let spread_stats = field_stats(samples.iter().map(|s| s.spread));

    format!(
        "{symbol}: price={:.2} (change over last {} samples: {:+.2}%, min={:.2}, max={:.2}, avg={:.2}), \
         open_interest={:.2} (min={:.2}, max={:.2}, avg={:.2}), \
         volume={:.2} (min={:.2}, max={:.2}, avg={:.2}), \
         spread={:.4} (min={:.4}, max={:.4}, avg={:.4}), \
         mid_price={:.2}; {}; {}",
        latest.price,
        samples.len(),
        price_change_pct,
        price_stats.min,
        price_stats.max,
        price_stats.avg,
        latest.open_interest,
        oi_stats.min,
        oi_stats.max,
        oi_stats.avg,
        latest.volume,
        volume_stats.min,
        volume_stats.max,
        volume_stats.avg,
        latest.spread,
        spread_stats.min,
        spread_stats.max,
        spread_stats.avg,
        latest.mid_price,
        position_summary(position, latest.mid_price),
        funding_summary(funding),
    )
}

fn series_point(sample: &MarketDataSample) -> String {
    format!(
        "price={:.2},mid_price={:.2},open_interest={:.2},volume={:.2},spread={:.4}",
        sample.price, sample.mid_price, sample.open_interest, sample.volume, sample.spread,
    )
}

/// Renders every sample in the window as a raw data point, oldest
/// first. Averaging the window away (see `build_context_summary`) is
/// cheap but discards shape — trend, spikes, order of moves — that the
/// decision maker may be able to reason over. Size is bounded by the
/// session's configured window (`MAX_HISTORY_WINDOW_SAMPLES`).
pub fn build_context_series(
    symbol: &str,
    samples: &[MarketDataSample],
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
) -> String {
    let Some(latest) = samples.last() else {
        return format!("{symbol}: no recent market data available");
    };

    let price_change_pct = price_change_pct(samples);
    let series = samples
        .iter()
        .map(series_point)
        .collect::<Vec<_>>()
        .join("; ");

    format!(
        "{symbol}: price_history=raw (oldest first, {} samples, change {:+.2}%): [{series}]; {}; {}",
        samples.len(),
        price_change_pct,
        position_summary(position, latest.mid_price),
        funding_summary(funding),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::model::Direction;
    use chrono::Duration;

    fn sample(price: f64) -> MarketDataSample {
        MarketDataSample {
            symbol: "BTC".to_string(),
            price,
            open_interest: 100.0,
            volume: 1000.0,
            spread: 0.5,
            mid_price: price + 0.25,
        }
    }

    fn open_position(direction: Direction, entry_price: f64, minutes_ago: i64) -> OpenPosition {
        OpenPosition {
            direction,
            entry_price,
            notional_usd: 1000.0,
            opened_at: Utc::now() - Duration::minutes(minutes_ago),
        }
    }

    #[test]
    fn summarizes_no_data_explicitly() {
        let summary = build_context_summary("BTC", &[], None, None);
        assert_eq!(summary, "BTC: no recent market data available");
    }

    #[test]
    fn includes_latest_price_and_derived_fields() {
        let summary = build_context_summary("BTC", &[sample(100.0)], None, None);
        assert!(summary.contains("price=100.00"));
        assert!(summary.contains("open_interest=100.00"));
        assert!(summary.contains("mid_price=100.25"));
    }

    #[test]
    fn computes_percent_change_across_the_window() {
        let summary = build_context_summary("BTC", &[sample(100.0), sample(110.0)], None, None);
        assert!(summary.contains("+10.00%"));
    }

    #[test]
    fn computes_negative_percent_change() {
        let summary = build_context_summary("BTC", &[sample(100.0), sample(90.0)], None, None);
        assert!(summary.contains("-10.00%"));
    }

    #[test]
    fn reports_min_max_avg_across_the_whole_window() {
        let summary = build_context_summary(
            "BTC",
            &[sample(90.0), sample(100.0), sample(110.0)],
            None,
            None,
        );
        assert!(summary.contains("min=90.00"));
        assert!(summary.contains("max=110.00"));
        assert!(summary.contains("avg=100.00"));
    }

    #[test]
    fn reports_flat_when_there_is_no_open_position() {
        let summary = build_context_summary("BTC", &[sample(100.0)], None, None);
        assert!(summary.contains("position=flat"));
    }

    #[test]
    fn reports_position_status_and_unrealized_pnl() {
        let position = open_position(Direction::Long, 90.0, 42);
        let summary = build_context_summary("BTC", &[sample(100.0)], Some(&position), None);
        assert!(summary.contains("position=long"));
        assert!(summary.contains("held_for_minutes=42.0"));
        assert!(summary.contains("entry_price=90.00"));
        // mid_price is 100.25, entry 90.0, notional 1000 -> (10.25/90)*1000
        assert!(summary.contains("unrealized_pnl_usd=+113.89"));
    }

    #[test]
    fn reports_funding_when_absent_and_present() {
        let none_summary = build_context_summary("BTC", &[sample(100.0)], None, None);
        assert!(none_summary.contains("funding=unknown"));

        let record = FundingRecord {
            rate: 0.0001,
            time: Utc::now(),
        };
        let with_funding = build_context_summary("BTC", &[sample(100.0)], None, Some(&record));
        assert!(with_funding.contains("funding_rate=0.000100"));
    }

    #[test]
    fn raw_context_includes_every_sample_oldest_first() {
        let series = build_context_series(
            "BTC",
            &[sample(90.0), sample(100.0), sample(110.0)],
            None,
            None,
        );
        assert!(series.contains("price_history=raw (oldest first, 3 samples, change +22.22%)"));
        let first = series.find("price=90.00").unwrap();
        let second = series.find("price=100.00").unwrap();
        let third = series.find("price=110.00").unwrap();
        assert!(first < second && second < third);
    }

    #[test]
    fn raw_context_keeps_position_and_funding() {
        let position = open_position(Direction::Long, 90.0, 42);
        let record = FundingRecord {
            rate: 0.0001,
            time: Utc::now(),
        };
        let series = build_context_series("BTC", &[sample(100.0)], Some(&position), Some(&record));
        assert!(series.contains("position=long"));
        assert!(series.contains("unrealized_pnl_usd=+113.89"));
        assert!(series.contains("funding_rate=0.000100"));
    }

    #[test]
    fn raw_context_is_explicit_about_no_data() {
        assert_eq!(
            build_context_series("BTC", &[], None, None),
            "BTC: no recent market data available"
        );
    }

    #[test]
    fn build_context_dispatches_on_the_configured_format() {
        let samples = [sample(90.0), sample(110.0)];
        assert_eq!(
            build_context("BTC", &samples, None, None, HistoryFormat::Summary),
            build_context_summary("BTC", &samples, None, None)
        );
        assert_eq!(
            build_context("BTC", &samples, None, None, HistoryFormat::Raw),
            build_context_series("BTC", &samples, None, None)
        );
    }

    #[test]
    fn history_format_round_trips_its_database_spelling() {
        assert_eq!(
            HistoryFormat::from_db("summary"),
            Some(HistoryFormat::Summary)
        );
        assert_eq!(HistoryFormat::from_db("raw"), Some(HistoryFormat::Raw));
        assert_eq!(HistoryFormat::from_db("everything"), None);
        assert_eq!(HistoryFormat::Summary.as_str(), "summary");
        assert_eq!(HistoryFormat::Raw.as_str(), "raw");
    }

    #[test]
    fn effective_history_window_clamps_to_the_readable_range() {
        assert_eq!(effective_history_window(0), 1);
        assert_eq!(effective_history_window(1), 1);
        assert_eq!(effective_history_window(250), 250);
        assert_eq!(effective_history_window(MAX_HISTORY_WINDOW_SAMPLES), 1000);
        assert_eq!(effective_history_window(u32::MAX), 1000);
    }
}
