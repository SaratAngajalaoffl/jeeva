use std::time::Duration;

use futures_util::TryStreamExt;
use mongodb::change_stream::event::OperationType;
use mongodb::options::{ChangeStreamOptions, FullDocumentType};
use mongodb::{Client, Collection};

use super::diff::{log_change, log_removed};
use super::model::PerpConfig;
use super::store::ConfigStore;

const COLLECTION_NAME: &str = "perpConfigs";
const RECONNECT_DELAY: Duration = Duration::from_secs(5);

/// Loads every existing PERP config into the store. Used on startup and
/// whenever we reconnect, so the store is always caught up before we
/// start tailing new changes.
pub async fn load_initial(
    collection: &Collection<PerpConfig>,
    store: &ConfigStore,
) -> mongodb::error::Result<()> {
    let mut cursor = collection.find(mongodb::bson::doc! {}).await?;
    while let Some(config) = cursor.try_next().await? {
        store.upsert(config);
    }
    Ok(())
}

/// Tails the collection's change stream, applying every insert/update/
/// replace to the store and logging what changed. Returns when the
/// stream ends (the caller is expected to reconnect).
pub async fn watch_changes(
    collection: Collection<PerpConfig>,
    store: ConfigStore,
) -> mongodb::error::Result<()> {
    let options = ChangeStreamOptions::builder()
        .full_document(Some(FullDocumentType::UpdateLookup))
        .build();
    let mut change_stream = collection.watch().with_options(options).await?;

    while let Some(event) = change_stream.try_next().await? {
        match event.operation_type {
            OperationType::Delete => {
                // Document key only contains _id by default; without a
                // full document we can't resolve which symbol was
                // removed, but deletes aren't part of the current API
                // surface (PATCH always upserts), so this is best-effort.
                log_removed("unknown (delete event carries no symbol)");
            }
            _ => {
                if let Some(new_config) = event.full_document {
                    let old = store.upsert(new_config.clone());
                    log_change(old.as_ref(), &new_config);
                }
            }
        }
    }

    Ok(())
}

async fn connect_and_watch(mongo_url: &str, store: ConfigStore) -> mongodb::error::Result<()> {
    let client = Client::with_uri_str(mongo_url).await?;
    let db = client
        .default_database()
        .unwrap_or_else(|| client.database("jeeva"));
    let collection = db.collection::<PerpConfig>(COLLECTION_NAME);

    load_initial(&collection, &store).await?;
    tracing::info!(count = store.len(), "loaded initial perp config");

    watch_changes(collection, store).await
}

/// Runs the config watcher forever, reconnecting (after a fixed delay)
/// whenever the connection fails or the change stream ends, so a
/// temporarily unavailable MongoDB never crashes the engine.
pub async fn run_with_reconnect(mongo_url: &str, store: ConfigStore) -> ! {
    loop {
        match connect_and_watch(mongo_url, store.clone()).await {
            Ok(()) => {
                tracing::warn!("config change stream ended; reconnecting");
            }
            Err(error) => {
                tracing::error!(%error, "config watcher error; retrying");
            }
        }
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}
