use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::decision::{read_window, HistoryError, HistorySample, MarketDataHistoryReader};
use crate::market_data::MarketDataSample;

use super::clock::SimClock;

/// Reads market-data history bounded by the replay's simulated "now"
/// instead of the wall clock, so a backtest cycle only ever sees data
/// at or before the moment it's replaying — no lookahead into the
/// future of the backtest range.
pub struct ReplayMarketDataHistoryReader {
    pool: PgPool,
    clock: Arc<SimClock>,
}

impl ReplayMarketDataHistoryReader {
    pub fn new(pool: PgPool, clock: Arc<SimClock>) -> Self {
        Self { pool, clock }
    }
}

#[async_trait]
impl MarketDataHistoryReader for ReplayMarketDataHistoryReader {
    async fn recent_samples(
        &self,
        symbol: &str,
        limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError> {
        let as_of = self.clock.get();

        let rows = sqlx::query_as::<_, (String, f64, f64, f64, f64, f64)>(
            r#"
            SELECT symbol, price, open_interest, volume, spread, mid_price
            FROM market_data
            WHERE symbol = $1 AND time <= $2
            ORDER BY time DESC
            LIMIT $3
            "#,
        )
        .bind(symbol)
        .bind(as_of)
        .bind(i64::from(limit))
        .fetch_all(&self.pool)
        .await
        .map_err(|e| HistoryError(format!("failed to read replay market data history: {e}")))?;

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
        // `to` is already the replay's simulated "now"; capping it at the
        // clock anyway keeps the no-lookahead guarantee local to this
        // reader rather than trusting every caller.
        let to = to.min(self.clock.get());
        read_window(&self.pool, symbol, from, to).await
    }
}
