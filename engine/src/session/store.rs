use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use super::model::TradingSessionConfig;

/// Thread-safe in-memory view of every non-closed trading session, kept
/// in sync with Postgres by the session poller (see `super::poller`).
/// Keyed by session id, not symbol — a symbol can have multiple
/// concurrent sessions.
#[derive(Debug, Clone, Default)]
pub struct SessionStore {
    inner: Arc<RwLock<HashMap<String, TradingSessionConfig>>>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, session_id: &str) -> Option<TradingSessionConfig> {
        self.inner.read().unwrap().get(session_id).cloned()
    }

    pub fn snapshot(&self) -> HashMap<String, TradingSessionConfig> {
        self.inner.read().unwrap().clone()
    }

    pub fn len(&self) -> usize {
        self.inner.read().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Replaces the entire set of known sessions (the poller reloads
    /// the full table on every tick rather than diffing individual
    /// rows, since Postgres has no native change-stream equivalent).
    pub fn replace_all(&self, sessions: HashMap<String, TradingSessionConfig>) {
        *self.inner.write().unwrap() = sessions;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::{DecisionMakerKind, HistoryFormat};
    use crate::session::model::TradingSessionStatus;

    fn sample(id: &str, symbol: &str) -> TradingSessionConfig {
        TradingSessionConfig {
            id: id.to_string(),
            symbol: symbol.to_string(),
            decision_maker: DecisionMakerKind::Random,
            decision_frequency_seconds: 300.0,
            leverage: 1.0,
            position_size_usd: 100.0,
            history_window_samples: 500,
            history_format: HistoryFormat::Raw,
            wallet_id: None,
            status: TradingSessionStatus::Active,
        }
    }

    #[test]
    fn tracks_multiple_sessions_on_the_same_symbol_independently() {
        let store = SessionStore::new();
        store.replace_all(HashMap::from([
            ("s1".to_string(), sample("s1", "BTC")),
            ("s2".to_string(), sample("s2", "BTC")),
        ]));

        assert_eq!(store.len(), 2);
        assert_eq!(store.get("s1").unwrap().id, "s1");
        assert_eq!(store.get("s2").unwrap().id, "s2");
    }

    #[test]
    fn replace_all_drops_sessions_no_longer_present() {
        let store = SessionStore::new();
        store.replace_all(HashMap::from([("s1".to_string(), sample("s1", "BTC"))]));
        store.replace_all(HashMap::new());

        assert!(store.is_empty());
        assert_eq!(store.get("s1"), None);
    }
}
