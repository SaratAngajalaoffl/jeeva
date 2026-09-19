use std::sync::Arc;
use std::time::Duration;

use engine::config::{run_with_reconnect, ConfigStore};
use engine::decision::{
    self, DecisionMaker, DecisionMakerRegistry, ExecutionAdapter, FakeDecisionMaker,
    LiveExecutionAdapter, MockExecutionAdapter, OpenRouterJevDecisionMaker, PerpHealthTracker,
    PostgresDecisionLogWriter, PostgresMarketDataHistoryReader, PrivateKey,
    TypeSafeJevDecisionMaker, UnconfiguredDecisionMaker,
};
use engine::funding::{
    self, HyperliquidFundingRateSource, PostgresFundingHistoryReader, PostgresFundingPaymentWriter,
};
use engine::market_data::{self, HyperliquidMarketDataClient, PostgresMarketDataWriter};
use engine::mode::{
    self as engine_mode, ModeStore, ModeSwitchedExecutionAdapter, UnconfiguredLiveExecutionAdapter,
};
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

/// Builds one `DecisionMaker` per `DecisionMakerKind`, so each PERP can
/// pick its decision maker independently via `PerpConfig::decision_maker`
/// without restarting the engine. `typesafe` falls back to an
/// `UnconfiguredDecisionMaker` when `TYPESAFE_API_KEY` isn't set, so the
/// engine still starts — it only fails once a PERP is actually switched
/// to `typesafe`. `openrouter` is always unimplemented for now.
fn decision_maker_registry() -> DecisionMakerRegistry {
    let fake: Arc<dyn DecisionMaker> = Arc::new(FakeDecisionMaker::cycling());

    let typesafe: Arc<dyn DecisionMaker> = if std::env::var("TYPESAFE_API_KEY").is_ok() {
        Arc::new(TypeSafeJevDecisionMaker::from_env())
    } else {
        tracing::warn!(
            "TYPESAFE_API_KEY not set; the typesafe decision maker will reject every call until configured"
        );
        Arc::new(UnconfiguredDecisionMaker { name: "typesafe" })
    };

    let openrouter: Arc<dyn DecisionMaker> = Arc::new(OpenRouterJevDecisionMaker::unimplemented());

    DecisionMakerRegistry::new(fake, typesafe, openrouter)
}

/// Builds the `live` delegate for `ModeSwitchedExecutionAdapter`. When
/// `HYPERLIQUID_PRIVATE_KEY` isn't set, the engine still starts (so
/// mock-only deployments don't need Hyperliquid credentials at all),
/// but switching `mode` to `live` will fail every call loudly instead
/// of trading.
async fn live_execution_adapter(pool: &PgPool) -> Arc<dyn ExecutionAdapter> {
    match std::env::var("HYPERLIQUID_PRIVATE_KEY") {
        Ok(key_hex) => {
            let key = PrivateKey::from_hex(&key_hex)
                .unwrap_or_else(|e| panic!("Invalid HYPERLIQUID_PRIVATE_KEY: {e}"));
            let is_mainnet = std::env::var("HYPERLIQUID_TESTNET").as_deref() != Ok("true");
            let base_url = if is_mainnet {
                "https://api.hyperliquid.xyz".to_string()
            } else {
                "https://api.hyperliquid-testnet.xyz".to_string()
            };
            let adapter = LiveExecutionAdapter::new(base_url, key, is_mainnet);
            adapter
                .publish_public_address(pool)
                .await
                .expect("failed to publish live wallet public address");
            tracing::info!("live execution adapter configured");
            Arc::new(adapter)
        }
        Err(_) => {
            tracing::warn!(
                "HYPERLIQUID_PRIVATE_KEY not set; live mode will reject every call until configured"
            );
            Arc::new(UnconfiguredLiveExecutionAdapter)
        }
    }
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
    PerpHealthTracker::migrate(pool)
        .await
        .expect("failed to migrate perp_health table");
    LiveExecutionAdapter::migrate(pool)
        .await
        .expect("failed to migrate engine_wallet table");
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
    let decision_makers = Arc::new(decision_maker_registry());
    let mock_execution: Arc<dyn decision::ExecutionAdapter> =
        Arc::new(MockExecutionAdapter::new(pool.clone(), slippage_bps()));
    let live_execution = live_execution_adapter(&pool).await;
    let mode_store = ModeStore::new();
    let execution: Arc<dyn decision::ExecutionAdapter> = Arc::new(
        ModeSwitchedExecutionAdapter::new(mock_execution, live_execution, mode_store.clone()),
    );
    let decision_log: Arc<dyn decision::DecisionLogWriter> =
        Arc::new(PostgresDecisionLogWriter::new(pool.clone()));
    let health: Arc<dyn decision::FailureTracker> = Arc::new(PerpHealthTracker::new(pool.clone()));

    let funding_rate_source: Arc<dyn funding::FundingRateSource> =
        Arc::new(HyperliquidFundingRateSource::default());
    let funding_payment_writer: Arc<dyn funding::FundingPaymentWriter> =
        Arc::new(PostgresFundingPaymentWriter::new(pool.clone()));
    let funding_history: Arc<dyn funding::FundingHistoryReader> =
        Arc::new(PostgresFundingHistoryReader::new(pool.clone()));

    tokio::select! {
        _ = run_with_reconnect(&mongo_url, store.clone()) => {},
        _ = engine_mode::run_with_reconnect(&mongo_url, mode_store) => {},
        _ = market_data::run(store.clone(), market_data_client, market_data_writer, SAMPLING_POLL_INTERVAL) => {},
        _ = decision::run(store, history, decision_makers, execution.clone(), funding_history, decision_log, health, DECISION_POLL_INTERVAL) => {},
        _ = funding::run(execution, funding_rate_source, funding_payment_writer, FUNDING_INTERVAL) => {},
    }
}
