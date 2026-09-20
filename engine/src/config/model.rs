use serde::{Deserialize, Serialize};

/// Mirrors the trimmed `perpConfigs` document shape written by the
/// Express API (see api/src/perps/repository.ts): market-level settings
/// only. Trading config (decision maker, frequency, sizing, wallet)
/// lives per trading session now (see `crate::session`), not here.
/// Unknown/extra fields (e.g. Mongo's `_id`) are ignored during
/// deserialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSettings {
    pub symbol: String,
    pub sampling_enabled: bool,
    pub sampling_frequency_seconds: f64,
}
