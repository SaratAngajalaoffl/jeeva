use std::sync::Arc;
use std::time::Duration;

use engine::config::{run_with_reconnect, ConfigStore};
use engine::market_data::{self, HyperliquidMarketDataClient, PostgresMarketDataWriter};

const SAMPLING_POLL_INTERVAL: Duration = Duration::from_secs(1);
const POSTGRES_CONNECT_RETRY_DELAY: Duration = Duration::from_secs(5);

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing required environment variable: {name}"))
}

async fn connect_postgres_with_retry(database_url: &str) -> PostgresMarketDataWriter {
    loop {
        match PostgresMarketDataWriter::connect(database_url).await {
            Ok(writer) => return writer,
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

    let market_data_client: Arc<dyn market_data::MarketDataClient> =
        Arc::new(HyperliquidMarketDataClient::default());
    let market_data_writer: Arc<dyn market_data::MarketDataWriter> =
        Arc::new(connect_postgres_with_retry(&database_url).await);

    tokio::select! {
        _ = run_with_reconnect(&mongo_url, store.clone()) => {},
        _ = market_data::run(store, market_data_client, market_data_writer, SAMPLING_POLL_INTERVAL) => {},
    }
}
