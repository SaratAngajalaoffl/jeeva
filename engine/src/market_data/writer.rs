use async_trait::async_trait;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

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
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        Self::migrate(&pool).await?;
        Ok(Self { pool })
    }

    /// Runs a migration statement, tolerating the duplicate-object errors
    /// Postgres can raise when two connections run a `CREATE ... IF NOT
    /// EXISTS` concurrently (its existence check and creation aren't
    /// atomic together) — this lets every writer safely run its own
    /// migration on `connect()` without a distributed lock.
    async fn execute_idempotent(pool: &PgPool, sql: &'static str) -> Result<(), sqlx::Error> {
        match sqlx::query(sql).execute(pool).await {
            Ok(_) => Ok(()),
            Err(sqlx::Error::Database(db_err))
                if matches!(db_err.code().as_deref(), Some("23505") | Some("42P07")) =>
            {
                Ok(())
            }
            Err(e) => Err(e),
        }
    }

    async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
        Self::execute_idempotent(pool, "CREATE EXTENSION IF NOT EXISTS timescaledb").await?;

        Self::execute_idempotent(
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

        Self::execute_idempotent(
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
