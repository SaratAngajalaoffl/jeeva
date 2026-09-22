use std::sync::Arc;
use std::time::Duration;

use engine::backtest;
use engine::config::{run_with_reconnect, ConfigStore};
use engine::decision::{
    self, DecisionMaker, DecisionMakerRegistry, OpenRouterJevDecisionMaker, PerpHealthTracker,
    PostgresDecisionLogWriter, PostgresMarketDataHistoryReader, PostgresSessionLifecycle,
    RandomDecisionMaker, TypeSafeJevDecisionMaker, UnconfiguredDecisionMaker,
};
use engine::funding::{
    self, HyperliquidFundingRateSource, PostgresFundingHistoryReader, PostgresFundingPaymentWriter,
};
use engine::market_data::{self, HyperliquidMarketDataClient, PostgresMarketDataWriter};
use engine::mode::{self as engine_mode, ModeStore};
use engine::session::{self, SessionStore};
use engine::wallets::WalletRegistry;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

const SAMPLING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const DECISION_POLL_INTERVAL: Duration = Duration::from_secs(1);
const SESSION_POLL_INTERVAL: Duration = Duration::from_secs(2);
const BACKTEST_POLL_INTERVAL: Duration = Duration::from_secs(2);
const WALLET_POLL_INTERVAL: Duration = Duration::from_secs(5);
const POSTGRES_CONNECT_RETRY_DELAY: Duration = Duration::from_secs(5);
// Deliberately much tighter than any session's decision_frequency_seconds
// (which defaults to 300s and is rarely configured below tens of
// seconds), so drift and a hard-close request are caught well before the
// next decision cycle would notice them.
const RECONCILE_POLL_INTERVAL: Duration = Duration::from_secs(5);
// Hyperliquid applies funding hourly.
const FUNDING_INTERVAL: Duration = Duration::from_secs(60 * 60);
// How often expired market data is pruned.
const MARKET_DATA_RETENTION_SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing required environment variable: {name}"))
}

/// Builds one `DecisionMaker` per `DecisionMakerKind`, so each trading
/// session can pick its decision maker independently via
/// `TradingSessionConfig::decision_maker` without restarting the engine.
/// `typesafe` falls back to an
/// `UnconfiguredDecisionMaker` when `TYPESAFE_API_KEY` isn't set, so the
/// engine still starts — it only fails once a PERP is actually switched
/// to `typesafe`. `openrouter` mirrors that wiring with
/// `OPENROUTER_API_KEY`.
fn decision_maker_registry() -> DecisionMakerRegistry {
    let random: Arc<dyn DecisionMaker> = Arc::new(RandomDecisionMaker::cycling());

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

    DecisionMakerRegistry::new(random, typesafe, openrouter)
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
    let market_data_ttl_days =
        market_data::ttl_days_from_env().unwrap_or_else(|error| panic!("{error}"));
    let min_confidence_to_shift =
        decision::min_confidence_to_shift_from_env().unwrap_or_else(|error| panic!("{error}"));
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
    let session_store = SessionStore::new();
    let session_lifecycle: Arc<dyn decision::SessionLifecycle> =
        Arc::new(PostgresSessionLifecycle::new(pool.clone()));

    let funding_rate_source: Arc<dyn funding::FundingRateSource> =
        Arc::new(HyperliquidFundingRateSource::default());
    let funding_payment_writer: Arc<dyn funding::FundingPaymentWriter> =
        Arc::new(PostgresFundingPaymentWriter::new(pool.clone()));
    let funding_history: Arc<dyn funding::FundingHistoryReader> =
        Arc::new(PostgresFundingHistoryReader::new(pool.clone()));

    let backtest_decision_makers = decision_makers.clone();
    let backtest_decision_maker_for: Arc<
        dyn Fn(decision::DecisionMakerKind) -> Arc<dyn DecisionMaker> + Send + Sync,
    > = Arc::new(move |kind| backtest_decision_makers.get(kind).clone());

    tokio::select! {
        _ = run_with_reconnect(&mongo_url, store.clone()) => {},
        _ = engine_mode::run_with_reconnect(&mongo_url, mode_store.clone()) => {},
        _ = market_data::run(store.clone(), market_data_client, market_data_writer, SAMPLING_POLL_INTERVAL) => {},
        _ = wallets.clone().run(WALLET_POLL_INTERVAL) => {},
        _ = session::run(pool.clone(), session_store.clone(), SESSION_POLL_INTERVAL) => {},
        _ = decision::run(session_store.clone(), min_confidence_to_shift, history.clone(), decision_makers, wallets.clone(), mode_store.clone(), funding_history, decision_log.clone(), health, session_lifecycle.clone(), DECISION_POLL_INTERVAL) => {},
        _ = funding::run(wallets.clone(), funding_rate_source, funding_payment_writer, FUNDING_INTERVAL) => {},
        _ = engine::reconcile::run(session_store, wallets, mode_store, history, decision_log, session_lifecycle, RECONCILE_POLL_INTERVAL) => {},
        _ = backtest::run(pool.clone(), backtest_decision_maker_for, BACKTEST_POLL_INTERVAL) => {},
        _ = market_data::run_retention(pool.clone(), market_data_ttl_days, MARKET_DATA_RETENTION_SWEEP_INTERVAL) => {},
    }
}
