use std::sync::{Arc, RwLock};
use std::time::Duration;

use futures_util::TryStreamExt;
use mongodb::change_stream::event::OperationType;
use mongodb::options::{ChangeStreamOptions, FullDocumentType};
use mongodb::{bson::doc, Client, Collection};
use serde::{Deserialize, Serialize};

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
