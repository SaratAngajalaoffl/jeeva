use std::fmt;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::decision::Direction;
use crate::pg::execute_idempotent;

#[derive(Debug)]
pub struct FundingWriteError(pub String);

impl fmt::Display for FundingWriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FundingWriteError {}

/// Records a funding payment distinctly from decision-driven position
/// P&L, so it's separately visible/auditable in the wallet's history.
#[async_trait]
pub trait FundingPaymentWriter: Send + Sync {
    #[allow(clippy::too_many_arguments)]
    async fn write(
        &self,
        symbol: &str,
        direction: Direction,
        funding_rate: f64,
        notional_usd: f64,
        amount_usd: f64,
    ) -> Result<(), FundingWriteError>;
}

pub struct PostgresFundingPaymentWriter {
    pool: PgPool,
}

impl PostgresFundingPaymentWriter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
        execute_idempotent(
            pool,
            r#"
            CREATE TABLE IF NOT EXISTS funding_payments (
                time TIMESTAMPTZ NOT NULL DEFAULT now(),
                symbol TEXT NOT NULL,
                direction TEXT NOT NULL,
                funding_rate DOUBLE PRECISION NOT NULL,
                notional_usd DOUBLE PRECISION NOT NULL,
                amount_usd DOUBLE PRECISION NOT NULL
            )
            "#,
        )
        .await?;

        execute_idempotent(
            pool,
            "SELECT create_hypertable('funding_payments', 'time', if_not_exists => TRUE)",
        )
        .await?;

        Ok(())
    }
}

#[async_trait]
impl FundingPaymentWriter for PostgresFundingPaymentWriter {
    async fn write(
        &self,
        symbol: &str,
        direction: Direction,
        funding_rate: f64,
        notional_usd: f64,
        amount_usd: f64,
    ) -> Result<(), FundingWriteError> {
        sqlx::query(
            r#"
            INSERT INTO funding_payments (time, symbol, direction, funding_rate, notional_usd, amount_usd)
            VALUES (now(), $1, $2, $3, $4, $5)
            "#,
        )
        .bind(symbol)
        .bind(direction.as_str())
        .bind(funding_rate)
        .bind(notional_usd)
        .bind(amount_usd)
        .execute(&self.pool)
        .await
        .map_err(|e| FundingWriteError(format!("failed to write funding payment: {e}")))?;

        Ok(())
    }
}
