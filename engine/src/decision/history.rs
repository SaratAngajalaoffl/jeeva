use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
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

/// Bounds on how far back (in seconds) a session's history window may
/// reach. Mirror the API's `MIN/MAX_HISTORY_WINDOW_SECONDS`, which reject
/// out-of-range configs at the edge; this is the engine-side backstop.
pub const MIN_HISTORY_WINDOW_SECONDS: u32 = 60;
pub const MAX_HISTORY_WINDOW_SECONDS: u32 = 30 * 24 * 60 * 60;

/// Upper bound on how many samples a window read returns, and therefore
/// on how large the raw series handed to a decision maker can get. A
/// window holding more samples than this is downsampled evenly across
/// its span (see `read_window`), so the whole window is still covered.
pub const MAX_HISTORY_SAMPLES: u32 = 1000;

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

/// Clamps a configured window (in seconds) into the range the engine
/// will actually read, so a hand-edited or out-of-range row can't ask
/// for an unbounded history. Mirrors
/// `trading_sessions.history_window_seconds`'s CHECK.
pub fn effective_history_window(seconds: u32) -> u32 {
    seconds.clamp(MIN_HISTORY_WINDOW_SECONDS, MAX_HISTORY_WINDOW_SECONDS)
}

/// One market-data sample together with the moment it was recorded.
#[derive(Debug, Clone, PartialEq)]
pub struct HistorySample {
    pub time: DateTime<Utc>,
    pub sample: MarketDataSample,
}

/// Reads recent market-data history for a PERP to build Jev's decision
/// context. The real implementation reads the TimescaleDB hypertable
/// the sampling loop (#8) writes to; tests use a fake implementation.
#[async_trait]
pub trait MarketDataHistoryReader: Send + Sync {
    /// Returns up to `limit` most recent samples for `symbol`, oldest
    /// first, however old they are. Only for "what's the latest known
    /// price" lookups — decision context must use `samples_in_window`,
    /// which never reaches back past the session's window.
    async fn recent_samples(
        &self,
        symbol: &str,
        limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError>;

    /// Returns the samples for `symbol` recorded in `(from, to]`, oldest
    /// first, downsampled to at most `MAX_HISTORY_SAMPLES`. Empty when
    /// nothing was sampled in that span — e.g. sampling was turned off —
    /// rather than falling back to older data.
    async fn samples_in_window(
        &self,
        symbol: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<HistorySample>, HistoryError>;
}

type SampleRow = (DateTime<Utc>, String, f64, f64, f64, f64, f64);

fn row_to_history_sample(
    (time, symbol, price, open_interest, volume, spread, mid_price): SampleRow,
) -> HistorySample {
    HistorySample {
        time,
        sample: MarketDataSample {
            symbol,
            price,
            open_interest,
            volume,
            spread,
            mid_price,
        },
    }
}

/// Reads `(from, to]` for `symbol`, oldest first. The span is split into
/// `MAX_HISTORY_SAMPLES` equal buckets and only the latest sample in each
/// is kept, so a long window at a high sampling frequency is thinned
/// evenly instead of truncated to its most recent end. A window that
/// already fits (one sample per bucket at most) comes back untouched.
/// Shared by the live reader and the backtest replay reader, which
/// differ only in what `to` is.
pub async fn read_window(
    pool: &PgPool,
    symbol: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<HistorySample>, HistoryError> {
    let span_seconds = (to - from).num_milliseconds().max(1) as f64 / 1000.0;
    let bucket_seconds = span_seconds / f64::from(MAX_HISTORY_SAMPLES);

    let rows = sqlx::query_as::<_, SampleRow>(
        r#"
        SELECT time, symbol, price, open_interest, volume, spread, mid_price
        FROM (
            SELECT DISTINCT ON (bucket)
                   time, symbol, price, open_interest, volume, spread, mid_price
            FROM (
                SELECT *,
                       LEAST(
                           floor(extract(epoch FROM (time - $2)) / $4),
                           $5 - 1
                       ) AS bucket
                FROM market_data
                WHERE symbol = $1 AND time > $2 AND time <= $3
            ) bucketed
            ORDER BY bucket, time DESC
        ) thinned
        ORDER BY time ASC
        "#,
    )
    .bind(symbol)
    .bind(from)
    .bind(to)
    .bind(bucket_seconds)
    .bind(f64::from(MAX_HISTORY_SAMPLES))
    .fetch_all(pool)
    .await
    .map_err(|e| HistoryError(format!("failed to read market data history: {e}")))?;

    Ok(rows.into_iter().map(row_to_history_sample).collect())
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

    async fn samples_in_window(
        &self,
        symbol: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
    ) -> Result<Vec<HistorySample>, HistoryError> {
        read_window(&self.pool, symbol, from, to).await
    }
}

/// Renders a window length compactly in its largest whole unit, e.g.
/// `5400` -> `90m`, `21600` -> `6h`, `604800` -> `7d`.
pub fn format_window(seconds: u32) -> String {
    const DAY: u32 = 24 * 60 * 60;
    const HOUR: u32 = 60 * 60;
    if seconds >= DAY && seconds.is_multiple_of(DAY) {
        format!("{}d", seconds / DAY)
    } else if seconds >= HOUR && seconds.is_multiple_of(HOUR) {
        format!("{}h", seconds / HOUR)
    } else if seconds >= 60 && seconds.is_multiple_of(60) {
        format!("{}m", seconds / 60)
    } else {
        format!("{seconds}s")
    }
}

fn timestamp(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Secs, true)
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
/// unrealized P&L against the latest mid price. `as_of` is "now" for
/// this purpose — the live decision loop passes the wall clock, and a
/// backtest replay passes its simulated time, so held-duration always
/// reflects what the decision maker would actually have seen.
fn position_summary(
    position: Option<&OpenPosition>,
    latest_mid_price: f64,
    as_of: DateTime<Utc>,
) -> String {
    match position {
        None => "position=flat".to_string(),
        Some(position) => {
            let held_for = as_of.signed_duration_since(position.opened_at);
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
fn price_change_pct(samples: &[HistorySample]) -> f64 {
    let first_price = samples.first().unwrap().sample.price;
    if first_price == 0.0 {
        return 0.0;
    }
    let latest = samples.last().unwrap().sample.price;
    (latest - first_price) / first_price * 100.0
}

/// What every context opens with: which window was read, as of when,
/// what it actually covers and how old its freshest sample is — so the
/// decision maker can tell a live series from a stale or gappy one.
fn window_header(samples: &[HistorySample], window_seconds: u32, as_of: DateTime<Utc>) -> String {
    let oldest = samples.first().unwrap().time;
    let latest = samples.last().unwrap().time;
    format!(
        "window=last {} (as_of={}, {} samples from {} to {}, latest_sample_age_seconds={})",
        format_window(window_seconds),
        timestamp(as_of),
        samples.len(),
        timestamp(oldest),
        timestamp(latest),
        as_of.signed_duration_since(latest).num_seconds().max(0),
    )
}

fn no_data(symbol: &str, window_seconds: u32, as_of: DateTime<Utc>) -> String {
    format!(
        "{symbol}: no market data in the last {} (as_of={})",
        format_window(window_seconds),
        timestamp(as_of),
    )
}

/// Builds Jev's `state` context in whichever form the session is
/// configured for, over the samples read for the session's
/// `window_seconds`. Pure so it's directly testable; `Summary` is the
/// min/max/average rendering, `Raw` hands over every sample in the
/// window as an individual, timestamped data point.
pub fn build_context(
    symbol: &str,
    samples: &[HistorySample],
    window_seconds: u32,
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
    format: HistoryFormat,
    as_of: DateTime<Utc>,
) -> String {
    match format {
        HistoryFormat::Summary => {
            build_context_summary(symbol, samples, window_seconds, position, funding, as_of)
        }
        HistoryFormat::Raw => {
            build_context_series(symbol, samples, window_seconds, position, funding, as_of)
        }
    }
}

/// Renders the whole window as one line per field: min, max and average
/// across every sample (not just the latest), plus the current position
/// status and the most recent real funding rate. The compact default —
/// as much signal as possible without handing over a raw dump of every
/// row (see `build_context_series` for that).
pub fn build_context_summary(
    symbol: &str,
    samples: &[HistorySample],
    window_seconds: u32,
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
    as_of: DateTime<Utc>,
) -> String {
    let Some(latest) = samples.last() else {
        return no_data(symbol, window_seconds, as_of);
    };
    let latest = &latest.sample;

    let price_change_pct = price_change_pct(samples);

    let price_stats = field_stats(samples.iter().map(|s| s.sample.price));
    let oi_stats = field_stats(samples.iter().map(|s| s.sample.open_interest));
    let volume_stats = field_stats(samples.iter().map(|s| s.sample.volume));
    let spread_stats = field_stats(samples.iter().map(|s| s.sample.spread));

    format!(
        "{symbol}: {}; price={:.2} (change over window: {:+.2}%, min={:.2}, max={:.2}, avg={:.2}), \
         open_interest={:.2} (min={:.2}, max={:.2}, avg={:.2}), \
         volume={:.2} (min={:.2}, max={:.2}, avg={:.2}), \
         spread={:.4} (min={:.4}, max={:.4}, avg={:.4}), \
         mid_price={:.2}; {}; {}",
        window_header(samples, window_seconds, as_of),
        latest.price,
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
        position_summary(position, latest.mid_price, as_of),
        funding_summary(funding),
    )
}

fn series_point(point: &HistorySample) -> String {
    let sample = &point.sample;
    format!(
        "t={},price={:.2},mid_price={:.2},open_interest={:.2},volume={:.2},spread={:.4}",
        timestamp(point.time),
        sample.price,
        sample.mid_price,
        sample.open_interest,
        sample.volume,
        sample.spread,
    )
}

/// Renders every sample in the window as a raw, timestamped data point,
/// oldest first. Averaging the window away (see `build_context_summary`)
/// is cheap but discards shape — trend, spikes, order of moves, gaps —
/// that the decision maker may be able to reason over. Size is bounded
/// by `MAX_HISTORY_SAMPLES` (see `read_window`).
pub fn build_context_series(
    symbol: &str,
    samples: &[HistorySample],
    window_seconds: u32,
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
    as_of: DateTime<Utc>,
) -> String {
    let Some(latest) = samples.last() else {
        return no_data(symbol, window_seconds, as_of);
    };

    let price_change_pct = price_change_pct(samples);
    let series = samples
        .iter()
        .map(series_point)
        .collect::<Vec<_>>()
        .join("; ");

    format!(
        "{symbol}: {}; price_history=raw (oldest first, change {:+.2}%): [{series}]; {}; {}",
        window_header(samples, window_seconds, as_of),
        price_change_pct,
        position_summary(position, latest.sample.mid_price, as_of),
        funding_summary(funding),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::model::Direction;
    use chrono::{Duration, TimeZone};

    const HOUR: u32 = 60 * 60;

    fn as_of() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 25, 12, 0, 0).unwrap()
    }

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

    /// One sample per minute, the last recorded exactly at `as_of()`.
    fn window(prices: &[f64]) -> Vec<HistorySample> {
        let count = prices.len() as i64;
        prices
            .iter()
            .enumerate()
            .map(|(i, price)| HistorySample {
                time: as_of() - Duration::minutes(count - 1 - i as i64),
                sample: sample(*price),
            })
            .collect()
    }

    fn open_position(direction: Direction, entry_price: f64, minutes_ago: i64) -> OpenPosition {
        OpenPosition {
            direction,
            entry_price,
            notional_usd: 1000.0,
            opened_at: as_of() - Duration::minutes(minutes_ago),
        }
    }

    #[test]
    fn summarizes_no_data_explicitly_naming_the_window() {
        let summary = build_context_summary("BTC", &[], HOUR, None, None, as_of());
        assert_eq!(
            summary,
            "BTC: no market data in the last 1h (as_of=2026-10-25T12:00:00Z)"
        );
    }

    #[test]
    fn includes_latest_price_and_derived_fields() {
        let summary = build_context_summary("BTC", &window(&[100.0]), HOUR, None, None, as_of());
        assert!(summary.contains("price=100.00"));
        assert!(summary.contains("open_interest=100.00"));
        assert!(summary.contains("mid_price=100.25"));
    }

    #[test]
    fn describes_the_window_and_how_fresh_it_is() {
        let mut samples = window(&[100.0, 101.0]);
        for point in &mut samples {
            point.time -= Duration::seconds(90);
        }
        let summary = build_context_summary("BTC", &samples, 6 * HOUR, None, None, as_of());
        assert!(summary.contains(
            "window=last 6h (as_of=2026-10-25T12:00:00Z, 2 samples from 2026-10-25T11:57:30Z to 2026-10-25T11:58:30Z, latest_sample_age_seconds=90)"
        ));
    }

    #[test]
    fn computes_percent_change_across_the_window() {
        let summary =
            build_context_summary("BTC", &window(&[100.0, 110.0]), HOUR, None, None, as_of());
        assert!(summary.contains("+10.00%"));
    }

    #[test]
    fn computes_negative_percent_change() {
        let summary =
            build_context_summary("BTC", &window(&[100.0, 90.0]), HOUR, None, None, as_of());
        assert!(summary.contains("-10.00%"));
    }

    #[test]
    fn reports_min_max_avg_across_the_whole_window() {
        let summary = build_context_summary(
            "BTC",
            &window(&[90.0, 100.0, 110.0]),
            HOUR,
            None,
            None,
            as_of(),
        );
        assert!(summary.contains("min=90.00"));
        assert!(summary.contains("max=110.00"));
        assert!(summary.contains("avg=100.00"));
    }

    #[test]
    fn reports_flat_when_there_is_no_open_position() {
        let summary = build_context_summary("BTC", &window(&[100.0]), HOUR, None, None, as_of());
        assert!(summary.contains("position=flat"));
    }

    #[test]
    fn reports_position_status_and_unrealized_pnl() {
        let position = open_position(Direction::Long, 90.0, 42);
        let summary = build_context_summary(
            "BTC",
            &window(&[100.0]),
            HOUR,
            Some(&position),
            None,
            as_of(),
        );
        assert!(summary.contains("position=long"));
        assert!(summary.contains("held_for_minutes=42.0"));
        assert!(summary.contains("entry_price=90.00"));
        // mid_price is 100.25, entry 90.0, notional 1000 -> (10.25/90)*1000
        assert!(summary.contains("unrealized_pnl_usd=+113.89"));
    }

    #[test]
    fn reports_funding_when_absent_and_present() {
        let none_summary =
            build_context_summary("BTC", &window(&[100.0]), HOUR, None, None, as_of());
        assert!(none_summary.contains("funding=unknown"));

        let record = FundingRecord {
            rate: 0.0001,
            time: as_of(),
        };
        let with_funding =
            build_context_summary("BTC", &window(&[100.0]), HOUR, None, Some(&record), as_of());
        assert!(with_funding.contains("funding_rate=0.000100"));
    }

    #[test]
    fn raw_context_includes_every_sample_oldest_first_with_its_timestamp() {
        let series = build_context_series(
            "BTC",
            &window(&[90.0, 100.0, 110.0]),
            HOUR,
            None,
            None,
            as_of(),
        );
        assert!(series.contains("window=last 1h"));
        assert!(series.contains("price_history=raw (oldest first, change +22.22%)"));
        let first = series.find("t=2026-10-25T11:58:00Z,price=90.00").unwrap();
        let second = series.find("t=2026-10-25T11:59:00Z,price=100.00").unwrap();
        let third = series.find("t=2026-10-25T12:00:00Z,price=110.00").unwrap();
        assert!(first < second && second < third);
    }

    #[test]
    fn raw_context_keeps_position_and_funding() {
        let position = open_position(Direction::Long, 90.0, 42);
        let record = FundingRecord {
            rate: 0.0001,
            time: as_of(),
        };
        let series = build_context_series(
            "BTC",
            &window(&[100.0]),
            HOUR,
            Some(&position),
            Some(&record),
            as_of(),
        );
        assert!(series.contains("position=long"));
        assert!(series.contains("unrealized_pnl_usd=+113.89"));
        assert!(series.contains("funding_rate=0.000100"));
    }

    #[test]
    fn raw_context_is_explicit_about_no_data() {
        assert_eq!(
            build_context_series("BTC", &[], 7 * 24 * HOUR, None, None, as_of()),
            "BTC: no market data in the last 7d (as_of=2026-10-25T12:00:00Z)"
        );
    }

    #[test]
    fn build_context_dispatches_on_the_configured_format() {
        let samples = window(&[90.0, 110.0]);
        assert_eq!(
            build_context(
                "BTC",
                &samples,
                HOUR,
                None,
                None,
                HistoryFormat::Summary,
                as_of()
            ),
            build_context_summary("BTC", &samples, HOUR, None, None, as_of())
        );
        assert_eq!(
            build_context(
                "BTC",
                &samples,
                HOUR,
                None,
                None,
                HistoryFormat::Raw,
                as_of()
            ),
            build_context_series("BTC", &samples, HOUR, None, None, as_of())
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
        assert_eq!(effective_history_window(0), MIN_HISTORY_WINDOW_SECONDS);
        assert_eq!(effective_history_window(60), 60);
        assert_eq!(effective_history_window(HOUR), HOUR);
        assert_eq!(
            effective_history_window(MAX_HISTORY_WINDOW_SECONDS),
            MAX_HISTORY_WINDOW_SECONDS
        );
        assert_eq!(
            effective_history_window(u32::MAX),
            MAX_HISTORY_WINDOW_SECONDS
        );
    }

    #[test]
    fn format_window_uses_the_largest_whole_unit() {
        assert_eq!(format_window(45), "45s");
        assert_eq!(format_window(90), "90s");
        assert_eq!(format_window(5400), "90m");
        assert_eq!(format_window(6 * HOUR), "6h");
        assert_eq!(format_window(36 * HOUR), "36h");
        assert_eq!(format_window(7 * 24 * HOUR), "7d");
    }
}
