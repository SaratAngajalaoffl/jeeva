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

/// Builds Jev's `state` context: a summary of the whole market-data
/// window (not just the latest sample) plus the current position
/// status and the most recent real funding rate, so the decision
/// source has as much signal as possible without being handed a raw
/// dump of every row. Pure so it's directly testable.
pub fn build_context_summary(
    symbol: &str,
    samples: &[MarketDataSample],
    position: Option<&OpenPosition>,
    funding: Option<&FundingRecord>,
) -> String {
    let Some(latest) = samples.last() else {
        return format!("{symbol}: no recent market data available");
    };

    let first_price = samples.first().unwrap().price;
    let price_change_pct = if first_price != 0.0 {
        (latest.price - first_price) / first_price * 100.0
    } else {
        0.0
    };

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
        let summary =
            build_context_summary("BTC", &[sample(100.0), sample(110.0)], None, None);
        assert!(summary.contains("+10.00%"));
    }

    #[test]
    fn computes_negative_percent_change() {
        let summary =
            build_context_summary("BTC", &[sample(100.0), sample(90.0)], None, None);
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
        let summary =
            build_context_summary("BTC", &[sample(100.0)], Some(&position), None);
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
}
