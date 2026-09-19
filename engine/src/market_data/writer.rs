use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

use crate::pg::execute_idempotent;

use super::client::MarketDataError;
use super::model::MarketDataSample;

/// Persists market-data samples. The real implementation writes to a
/// TimescaleDB hypertable; tests use a fake implementation to avoid a
/// database dependency where they don't need one.
#[async_trait]
pub trait MarketDataWriter: Send + Sync {
    async fn write(&self, sample: &MarketDataSample) -> Result<(), MarketDataError>;
}

pub struct PostgresMarketDataWriter {
    pool: PgPool,
}

impl PostgresMarketDataWriter {
    /// Connects its own pool and runs the migration. Used where nothing
    /// else shares the database connection (engine tests).
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        Self::migrate(&pool).await?;
        Ok(Self { pool })
    }

    /// Builds on an already-connected, already-migrated shared pool.
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
        execute_idempotent(pool, "CREATE EXTENSION IF NOT EXISTS timescaledb").await?;

        execute_idempotent(
            pool,
            r#"
            CREATE TABLE IF NOT EXISTS market_data (
                time TIMESTAMPTZ NOT NULL,
                symbol TEXT NOT NULL,
                price DOUBLE PRECISION NOT NULL,
                open_interest DOUBLE PRECISION NOT NULL,
                volume DOUBLE PRECISION NOT NULL,
                spread DOUBLE PRECISION NOT NULL,
                mid_price DOUBLE PRECISION NOT NULL
            )
            "#,
        )
        .await?;

        execute_idempotent(
            pool,
            "SELECT create_hypertable('market_data', 'time', if_not_exists => TRUE)",
        )
        .await?;

        Ok(())
    }
}

#[async_trait]
impl MarketDataWriter for PostgresMarketDataWriter {
    async fn write(&self, sample: &MarketDataSample) -> Result<(), MarketDataError> {
        sqlx::query(
            r#"
            INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price)
            VALUES (now(), $1, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(&sample.symbol)
        .bind(sample.price)
        .bind(sample.open_interest)
        .bind(sample.volume)
        .bind(sample.spread)
        .bind(sample.mid_price)
        .execute(&self.pool)
        .await
        .map_err(|e| MarketDataError(format!("failed to write market data sample: {e}")))?;

        Ok(())
    }
}
