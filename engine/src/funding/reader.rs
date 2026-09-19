use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

#[derive(Debug)]
pub struct FundingHistoryError(pub String);

impl fmt::Display for FundingHistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FundingHistoryError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FundingRecord {
    pub rate: f64,
    pub time: DateTime<Utc>,
}

/// Reads back funding payments the sweep (`run_funding_cycle`) already
/// recorded, so the decision loop can include the most recent real
/// funding rate for a PERP in Jev's context. A PERP with no open
/// position yet (or one that hasn't seen a funding cycle) simply has
/// no record.
#[async_trait]
pub trait FundingHistoryReader: Send + Sync {
    async fn latest(&self, symbol: &str) -> Result<Option<FundingRecord>, FundingHistoryError>;
}

pub struct PostgresFundingHistoryReader {
    pool: PgPool,
}

impl PostgresFundingHistoryReader {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl FundingHistoryReader for PostgresFundingHistoryReader {
    async fn latest(&self, symbol: &str) -> Result<Option<FundingRecord>, FundingHistoryError> {
        let row = sqlx::query_as::<_, (f64, DateTime<Utc>)>(
            r#"
            SELECT funding_rate, time
            FROM funding_payments
            WHERE symbol = $1
            ORDER BY time DESC
            LIMIT 1
            "#,
        )
        .bind(symbol)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| FundingHistoryError(format!("failed to read latest funding: {e}")))?;

        Ok(row.map(|(rate, time)| FundingRecord { rate, time }))
    }
}
