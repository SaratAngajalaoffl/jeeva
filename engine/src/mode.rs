use std::sync::{Arc, RwLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::TryStreamExt;
use mongodb::change_stream::event::OperationType;
use mongodb::options::{ChangeStreamOptions, FullDocumentType};
use mongodb::{bson::doc, Client, Collection};
use serde::{Deserialize, Serialize};

use crate::decision::Direction;
use crate::decision::{ExecutionAdapter, ExecutionError, OpenPosition};

const COLLECTION_NAME: &str = "engineConfig";
const SINGLETON_ID: &str = "singleton";
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

/// The engine-wide trading mode. Never mixed per PERP — switching
/// applies immediately to every PERP's decision loop, funding sweep,
/// and position query, because `ModeSwitchedExecutionAdapter` reads the
/// current mode on every call rather than being constructed once with
/// one fixed adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineMode {
    Mock,
    Live,
}

impl EngineMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            EngineMode::Mock => "mock",
            EngineMode::Live => "live",
        }
    }
}

/// Thread-safe, shared engine-wide mode, kept in sync with MongoDB by
/// the change-stream watcher below. Defaults to `Mock` so a fresh
/// engine never trades real funds without an explicit switch.
#[derive(Debug, Clone)]
pub struct ModeStore {
    inner: Arc<RwLock<EngineMode>>,
}

impl Default for ModeStore {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(EngineMode::Mock)),
        }
    }
}

impl ModeStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self) -> EngineMode {
        *self.inner.read().unwrap()
    }

    pub fn set(&self, mode: EngineMode) {
        *self.inner.write().unwrap() = mode;
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ModeDocument {
    #[serde(rename = "_id")]
    pub id: String,
    pub mode: EngineMode,
}

impl ModeDocument {
    pub fn singleton(mode: EngineMode) -> Self {
        Self {
            id: SINGLETON_ID.to_string(),
            mode,
        }
    }
}

pub fn collection_name() -> &'static str {
    COLLECTION_NAME
}

pub async fn load_initial(
    collection: &Collection<ModeDocument>,
    store: &ModeStore,
) -> mongodb::error::Result<()> {
    if let Some(document) = collection.find_one(doc! { "_id": SINGLETON_ID }).await? {
        store.set(document.mode);
    }
    Ok(())
}

pub async fn watch_changes(
    collection: Collection<ModeDocument>,
    store: ModeStore,
) -> mongodb::error::Result<()> {
    let options = ChangeStreamOptions::builder()
        .full_document(Some(FullDocumentType::UpdateLookup))
        .build();
    let mut change_stream = collection.watch().with_options(options).await?;

    while let Some(event) = change_stream.try_next().await? {
        if event.operation_type == OperationType::Delete {
            continue;
        }
        if let Some(document) = event.full_document {
            if document.id == SINGLETON_ID {
                tracing::warn!(mode = document.mode.as_str(), "engine mode switched");
                store.set(document.mode);
            }
        }
    }

    Ok(())
}

async fn connect_and_watch(mongo_url: &str, store: ModeStore) -> mongodb::error::Result<()> {
    let client = Client::with_uri_str(mongo_url).await?;
    let db = client
        .default_database()
        .unwrap_or_else(|| client.database("jeeva"));
    let collection = db.collection::<ModeDocument>(COLLECTION_NAME);

    load_initial(&collection, &store).await?;
    tracing::info!(mode = store.get().as_str(), "loaded initial engine mode");

    watch_changes(collection, store).await
}

/// Runs the engine-mode watcher forever, reconnecting after a fixed
/// delay whenever the connection fails or the change stream ends.
pub async fn run_with_reconnect(mongo_url: &str, store: ModeStore) -> ! {
    loop {
        match connect_and_watch(mongo_url, store.clone()).await {
            Ok(()) => {
                tracing::warn!("engine mode change stream ended; reconnecting");
            }
            Err(error) => {
                tracing::error!(%error, "engine mode watcher error; retrying");
            }
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// An `ExecutionAdapter` that dispatches every call to either its mock
/// or live delegate based on `ModeStore`'s *current* value, read fresh
/// on every call — not fixed at construction time — so a mode switch
/// takes effect on the very next decision cycle, engine-wide, with no
/// restart and no per-PERP override.
pub struct ModeSwitchedExecutionAdapter {
    mock: Arc<dyn ExecutionAdapter>,
    live: Arc<dyn ExecutionAdapter>,
    mode: ModeStore,
}

impl ModeSwitchedExecutionAdapter {
    pub fn new(
        mock: Arc<dyn ExecutionAdapter>,
        live: Arc<dyn ExecutionAdapter>,
        mode: ModeStore,
    ) -> Self {
        Self { mock, live, mode }
    }

    fn current(&self) -> &Arc<dyn ExecutionAdapter> {
        match self.mode.get() {
            EngineMode::Mock => &self.mock,
            EngineMode::Live => &self.live,
        }
    }
}

#[async_trait]
impl ExecutionAdapter for ModeSwitchedExecutionAdapter {
    async fn get_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        self.current().get_position(symbol).await
    }

    async fn open(
        &self,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        self.current()
            .open(symbol, direction, position_size_usd, leverage, mid_price)
            .await
    }

    async fn close(&self, symbol: &str, mid_price: f64) -> Result<(), ExecutionError> {
        self.current().close(symbol, mid_price).await
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        self.current().list_open_positions().await
    }

    async fn apply_funding(&self, symbol: &str, amount_usd: f64) -> Result<(), ExecutionError> {
        self.current().apply_funding(symbol, amount_usd).await
    }
}

/// The `live` delegate used when the engine has no
/// `HYPERLIQUID_PRIVATE_KEY` configured — switching `ModeStore` to
/// `Live` without a signing key configured fails loudly on the next
/// call rather than silently trading (or silently doing nothing).
pub struct UnconfiguredLiveExecutionAdapter;

#[async_trait]
impl ExecutionAdapter for UnconfiguredLiveExecutionAdapter {
    async fn get_position(&self, _symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        Err(unconfigured_error())
    }

    async fn open(
        &self,
        _symbol: &str,
        _direction: Direction,
        _position_size_usd: f64,
        _leverage: f64,
        _mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        Err(unconfigured_error())
    }

    async fn close(&self, _symbol: &str, _mid_price: f64) -> Result<(), ExecutionError> {
        Err(unconfigured_error())
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        Err(unconfigured_error())
    }

    async fn apply_funding(&self, _symbol: &str, _amount_usd: f64) -> Result<(), ExecutionError> {
        Err(unconfigured_error())
    }
}

fn unconfigured_error() -> ExecutionError {
    ExecutionError(
        "live mode is not configured on this engine (HYPERLIQUID_PRIVATE_KEY not set)".to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct CountingAdapter {
        name: &'static str,
        calls: AtomicUsize,
    }

    impl CountingAdapter {
        fn new(name: &'static str) -> Self {
            Self {
                name,
                calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ExecutionAdapter for CountingAdapter {
        async fn get_position(
            &self,
            _symbol: &str,
        ) -> Result<Option<OpenPosition>, ExecutionError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }

        async fn open(
            &self,
            _symbol: &str,
            _direction: Direction,
            _position_size_usd: f64,
            _leverage: f64,
            _mid_price: f64,
        ) -> Result<OpenPosition, ExecutionError> {
            Err(ExecutionError(format!(
                "{} does not support open in this test",
                self.name
            )))
        }

        async fn close(&self, _symbol: &str, _mid_price: f64) -> Result<(), ExecutionError> {
            Ok(())
        }

        async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
            Ok(vec![])
        }

        async fn apply_funding(
            &self,
            _symbol: &str,
            _amount_usd: f64,
        ) -> Result<(), ExecutionError> {
            Ok(())
        }
    }

    #[test]
    fn defaults_to_mock() {
        let store = ModeStore::new();
        assert_eq!(store.get(), EngineMode::Mock);
    }

    #[test]
    fn set_updates_the_stored_mode() {
        let store = ModeStore::new();
        store.set(EngineMode::Live);
        assert_eq!(store.get(), EngineMode::Live);
    }

    #[tokio::test]
    async fn dispatches_to_mock_by_default() {
        let mock = Arc::new(CountingAdapter::new("mock"));
        let live = Arc::new(CountingAdapter::new("live"));
        let mode = ModeStore::new();
        let adapter = ModeSwitchedExecutionAdapter::new(mock.clone(), live.clone(), mode);

        adapter.get_position("BTC").await.unwrap();

        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(live.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn dispatches_to_live_once_the_mode_is_switched() {
        let mock = Arc::new(CountingAdapter::new("mock"));
        let live = Arc::new(CountingAdapter::new("live"));
        let mode = ModeStore::new();
        let adapter = ModeSwitchedExecutionAdapter::new(mock.clone(), live.clone(), mode.clone());

        mode.set(EngineMode::Live);
        adapter.get_position("BTC").await.unwrap();

        assert_eq!(mock.calls.load(Ordering::SeqCst), 0);
        assert_eq!(live.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unconfigured_live_adapter_fails_every_call_instead_of_trading_silently() {
        let adapter = UnconfiguredLiveExecutionAdapter;
        assert!(adapter.get_position("BTC").await.is_err());
        assert!(adapter.close("BTC", 100.0).await.is_err());
        assert!(adapter.list_open_positions().await.is_err());
        assert!(adapter.apply_funding("BTC", 1.0).await.is_err());
        assert!(adapter
            .open("BTC", Direction::Long, 100.0, 1.0, 100.0)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn switching_back_to_mock_takes_effect_immediately() {
        let mock = Arc::new(CountingAdapter::new("mock"));
        let live = Arc::new(CountingAdapter::new("live"));
        let mode = ModeStore::new();
        let adapter = ModeSwitchedExecutionAdapter::new(mock.clone(), live.clone(), mode.clone());

        mode.set(EngineMode::Live);
        adapter.get_position("BTC").await.unwrap();
        mode.set(EngineMode::Mock);
        adapter.get_position("BTC").await.unwrap();

        assert_eq!(mock.calls.load(Ordering::SeqCst), 1);
        assert_eq!(live.calls.load(Ordering::SeqCst), 1);
    }
}
