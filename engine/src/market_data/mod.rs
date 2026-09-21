mod client;
mod model;
mod retention;
mod supervisor;
mod writer;

pub use client::{HyperliquidMarketDataClient, MarketDataClient, MarketDataError};
pub use model::MarketDataSample;
pub use retention::{prune_expired, run as run_retention, ttl_days_from_env, DEFAULT_TTL_DAYS};
pub use supervisor::{desired_state, run};
pub use writer::{MarketDataWriter, PostgresMarketDataWriter};
