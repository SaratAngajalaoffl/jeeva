use std::sync::Arc;
use std::time::Duration;

use engine::config::{run_with_reconnect, ConfigStore};
use engine::decision::{
    self, DecisionMaker, DecisionMakerRegistry, FakeDecisionMaker, OpenRouterJevDecisionMaker,
    PerpHealthTracker, PostgresDecisionLogWriter, PostgresMarketDataHistoryReader,
    TypeSafeJevDecisionMaker, UnconfiguredDecisionMaker,
};
use engine::funding::{
    self, HyperliquidFundingRateSource, PostgresFundingHistoryReader, PostgresFundingPaymentWriter,
};
use engine::market_data::{self, HyperliquidMarketDataClient, PostgresMarketDataWriter};
use engine::mode::{self as engine_mode, ModeStore};
use engine::wallets::WalletRegistry;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

const SAMPLING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DECISION_POLL_INTERVAL: Duration = Duration::from_secs(1);
const WALLET_POLL_INTERVAL: Duration = Duration::from_secs(5);
const POSTGRES_CONNECT_RETRY_DELAY: Duration = Duration::from_secs(5);
// Hyperliquid applies funding hourly.
const FUNDING_INTERVAL: Duration = Duration::from_secs(60 * 60);

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing required environment variable: {name}"))
}

/// Builds one `DecisionMaker` per `DecisionMakerKind`, so each PERP can
/// pick its decision maker independently via `PerpConfig::decision_maker`
/// without restarting the engine. `typesafe` falls back to an
/// `UnconfiguredDecisionMaker` when `TYPESAFE_API_KEY` isn't set, so the
/// engine still starts — it only fails once a PERP is actually switched
/// to `typesafe`. `openrouter` mirrors that wiring with
/// `OPENROUTER_API_KEY`.
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

    let openrouter: Arc<dyn DecisionMaker> = if std::env::var("OPENROUTER_API_KEY").is_ok() {
        Arc::new(OpenRouterJevDecisionMaker::from_env())
    } else {
        tracing::warn!(
            "OPENROUTER_API_KEY not set; the openrouter decision maker will reject every call until configured"
        );
        Arc::new(UnconfiguredDecisionMaker { name: "openrouter" })
    };

    DecisionMakerRegistry::new(fake, typesafe, openrouter)
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

    let market_data_client: Arc<dyn market_data::MarketDataClient> =
        Arc::new(HyperliquidMarketDataClient::default());
    let market_data_writer: Arc<dyn market_data::MarketDataWriter> =
        Arc::new(PostgresMarketDataWriter::new(pool.clone()));

    let history: Arc<dyn decision::MarketDataHistoryReader> =
        Arc::new(PostgresMarketDataHistoryReader::new(pool.clone()));
    let decision_makers = Arc::new(decision_maker_registry());
    let wallets = WalletRegistry::new(pool.clone());
    let mode_store = ModeStore::new();
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
        _ = engine_mode::run_with_reconnect(&mongo_url, mode_store.clone()) => {},
        _ = market_data::run(store.clone(), market_data_client, market_data_writer, SAMPLING_POLL_INTERVAL) => {},
        _ = wallets.clone().run(WALLET_POLL_INTERVAL) => {},
        _ = decision::run(store, history, decision_makers, wallets.clone(), mode_store, funding_history, decision_log, health, DECISION_POLL_INTERVAL) => {},
        _ = funding::run(wallets, funding_rate_source, funding_payment_writer, FUNDING_INTERVAL) => {},
    }
}
