use std::sync::Arc;
use std::time::Duration;

use engine::config::{run_with_reconnect, ConfigStore};
use engine::decision::{
    self, FakeJevAdapter, MockExecutionAdapter, PostgresDecisionLogWriter,
    PostgresMarketDataHistoryReader,
};
use engine::funding::{
    self, HyperliquidFundingRateSource, PostgresFundingHistoryReader, PostgresFundingPaymentWriter,
};
use engine::market_data::{self, HyperliquidMarketDataClient, PostgresMarketDataWriter};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

const SAMPLING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DECISION_POLL_INTERVAL: Duration = Duration::from_secs(1);
const POSTGRES_CONNECT_RETRY_DELAY: Duration = Duration::from_secs(5);
const DEFAULT_SLIPPAGE_BPS: f64 = 5.0;
// Hyperliquid applies funding hourly.
const FUNDING_INTERVAL: Duration = Duration::from_secs(60 * 60);

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing required environment variable: {name}"))
}

fn slippage_bps() -> f64 {
    std::env::var("MOCK_SLIPPAGE_BPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_SLIPPAGE_BPS)
}

async fn connect_postgres_with_retry(database_url: &str) -> PgPool {
    loop {
        match PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
        {
            Ok(pool) => return pool,
            Err(error) => {
                tracing::error!(%error, "failed to connect to TimescaleDB; retrying");
                tokio::time::sleep(POSTGRES_CONNECT_RETRY_DELAY).await;
            }
        }
    }
}

async fn migrate(pool: &PgPool) {
    PostgresMarketDataWriter::migrate(pool)
        .await
        .expect("failed to migrate market_data table");
    MockExecutionAdapter::migrate(pool)
        .await
        .expect("failed to migrate mock_positions table");
    PostgresDecisionLogWriter::migrate(pool)
        .await
        .expect("failed to migrate decisions table");
    PostgresFundingPaymentWriter::migrate(pool)
        .await
        .expect("failed to migrate funding_payments table");
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tracing::info!("jeeva engine starting");

    let mongo_url = require_env("MONGO_URL");
    let database_url = require_env("DATABASE_URL");
    let store = ConfigStore::new();

    let pool = connect_postgres_with_retry(&database_url).await;
    migrate(&pool).await;

    let market_data_client: Arc<dyn market_data::MarketDataClient> =
        Arc::new(HyperliquidMarketDataClient::default());
    let market_data_writer: Arc<dyn market_data::MarketDataWriter> =
        Arc::new(PostgresMarketDataWriter::new(pool.clone()));

    let history: Arc<dyn decision::MarketDataHistoryReader> =
        Arc::new(PostgresMarketDataHistoryReader::new(pool.clone()));
    let jev: Arc<dyn decision::JevDecisionSource> = Arc::new(FakeJevAdapter::cycling());
    let execution: Arc<dyn decision::ExecutionAdapter> =
        Arc::new(MockExecutionAdapter::new(pool.clone(), slippage_bps()));
    let decision_log: Arc<dyn decision::DecisionLogWriter> =
        Arc::new(PostgresDecisionLogWriter::new(pool.clone()));

    let funding_rate_source: Arc<dyn funding::FundingRateSource> =
        Arc::new(HyperliquidFundingRateSource::default());
    let funding_payment_writer: Arc<dyn funding::FundingPaymentWriter> =
        Arc::new(PostgresFundingPaymentWriter::new(pool.clone()));
    let funding_history: Arc<dyn funding::FundingHistoryReader> =
        Arc::new(PostgresFundingHistoryReader::new(pool.clone()));

    tokio::select! {
        _ = run_with_reconnect(&mongo_url, store.clone()) => {},
        _ = market_data::run(store.clone(), market_data_client, market_data_writer, SAMPLING_POLL_INTERVAL) => {},
        _ = decision::run(store, history, jev, execution.clone(), funding_history, decision_log, DECISION_POLL_INTERVAL) => {},
        _ = funding::run(execution, funding_rate_source, funding_payment_writer, FUNDING_INTERVAL) => {},
    }
}
