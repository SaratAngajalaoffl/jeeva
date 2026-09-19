use engine::config::{run_with_reconnect, ConfigStore};

fn require_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Missing required environment variable: {name}"))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tracing::info!("jeeva engine starting");

    let mongo_url = require_env("MONGO_URL");
    let store = ConfigStore::new();

    run_with_reconnect(&mongo_url, store).await;
}
