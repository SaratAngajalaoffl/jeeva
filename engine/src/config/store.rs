use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use super::model::PerpConfig;

/// Thread-safe in-memory view of every PERP's current config, kept in
/// sync with MongoDB by the change-stream watcher.
#[derive(Debug, Clone, Default)]
pub struct ConfigStore {
    inner: Arc<RwLock<HashMap<String, PerpConfig>>>,
}

impl ConfigStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, symbol: &str) -> Option<PerpConfig> {
        self.inner.read().unwrap().get(symbol).cloned()
    }

    pub fn snapshot(&self) -> HashMap<String, PerpConfig> {
        self.inner.read().unwrap().clone()
    }

    pub fn len(&self) -> usize {
        self.inner.read().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Inserts or replaces a PERP's config, returning the prior value
    /// (if any) so the caller can log what changed.
    pub fn upsert(&self, config: PerpConfig) -> Option<PerpConfig> {
        self.inner
            .write()
            .unwrap()
            .insert(config.symbol.clone(), config)
    }

    pub fn remove(&self, symbol: &str) -> Option<PerpConfig> {
        self.inner.write().unwrap().remove(symbol)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(symbol: &str) -> PerpConfig {
        PerpConfig {
            symbol: symbol.to_string(),
            trading_enabled: false,
            sampling_enabled: false,
            decision_frequency_seconds: 300.0,
            sampling_frequency_seconds: 60.0,
            leverage: 1.0,
            position_size_usd: 100.0,
        }
    }

    #[test]
    fn upsert_returns_none_for_a_new_symbol() {
        let store = ConfigStore::new();
        assert_eq!(store.upsert(sample("BTC")), None);
        assert_eq!(store.get("BTC"), Some(sample("BTC")));
    }

    #[test]
    fn upsert_returns_the_previous_value_for_an_existing_symbol() {
        let store = ConfigStore::new();
        store.upsert(sample("BTC"));

        let mut updated = sample("BTC");
        updated.trading_enabled = true;

        let previous = store.upsert(updated.clone());
        assert_eq!(previous, Some(sample("BTC")));
        assert_eq!(store.get("BTC"), Some(updated));
    }

    #[test]
    fn remove_deletes_a_symbol() {
        let store = ConfigStore::new();
        store.upsert(sample("BTC"));
        assert_eq!(store.remove("BTC"), Some(sample("BTC")));
        assert_eq!(store.get("BTC"), None);
    }

    #[test]
    fn tracks_multiple_symbols_independently() {
        let store = ConfigStore::new();
        store.upsert(sample("BTC"));
        store.upsert(sample("ETH"));
        assert_eq!(store.len(), 2);
        assert_eq!(store.get("BTC").unwrap().symbol, "BTC");
        assert_eq!(store.get("ETH").unwrap().symbol, "ETH");
    }
}
