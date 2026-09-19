use std::fmt;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::market_data::MarketDataSample;

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

/// Builds a human-readable summary of recent market conditions to send
/// as Jev's `state` context: the most recent sample's full detail plus
/// a short price trend across the window. Pure so it's directly
/// testable.
pub fn build_context_summary(symbol: &str, samples: &[MarketDataSample]) -> String {
    let Some(latest) = samples.last() else {
        return format!("{symbol}: no recent market data available");
    };

    let first_price = samples.first().unwrap().price;
    let price_change_pct = if first_price != 0.0 {
        (latest.price - first_price) / first_price * 100.0
    } else {
        0.0
    };

    format!(
        "{symbol}: price={:.2} (change over last {} samples: {:+.2}%), open_interest={:.2}, volume={:.2}, spread={:.4}, mid_price={:.2}",
        latest.price,
        samples.len(),
        price_change_pct,
        latest.open_interest,
        latest.volume,
        latest.spread,
        latest.mid_price,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn summarizes_no_data_explicitly() {
        let summary = build_context_summary("BTC", &[]);
        assert_eq!(summary, "BTC: no recent market data available");
    }

    #[test]
    fn includes_latest_price_and_derived_fields() {
        let summary = build_context_summary("BTC", &[sample(100.0)]);
        assert!(summary.contains("price=100.00"));
        assert!(summary.contains("open_interest=100.00"));
        assert!(summary.contains("mid_price=100.25"));
    }

    #[test]
    fn computes_percent_change_across_the_window() {
        let summary = build_context_summary("BTC", &[sample(100.0), sample(110.0)]);
        assert!(summary.contains("+10.00%"));
    }

    #[test]
    fn computes_negative_percent_change() {
        let summary = build_context_summary("BTC", &[sample(100.0), sample(90.0)]);
        assert!(summary.contains("-10.00%"));
    }
}
