use serde::{Deserialize, Serialize};

/// Mirrors the `perpConfigs` document shape written by the Express API
/// (see api/src/perps/repository.ts). Unknown/extra fields (e.g. Mongo's
/// `_id`) are ignored during deserialization.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerpConfig {
    pub symbol: String,
    pub trading_enabled: bool,
    pub sampling_enabled: bool,
    pub decision_frequency_seconds: f64,
    pub sampling_frequency_seconds: f64,
    pub leverage: f64,
    pub position_size_usd: f64,
}
