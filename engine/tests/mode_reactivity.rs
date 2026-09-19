use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use engine::mode::{load_initial, watch_changes, EngineMode, ModeDocument, ModeStore};
use mongodb::bson::doc;
use mongodb::{Client, Collection};
use tokio::time::{sleep, timeout};

fn test_mongo_url() -> String {
    std::env::var("TEST_MONGO_URL").unwrap_or_else(|_| "mongodb://localhost:27017".to_string())
}

async fn fresh_collection(test_name: &str) -> Collection<ModeDocument> {
    let mut hasher = DefaultHasher::new();
    test_name.hash(&mut hasher);
    let db_name = format!("jeeva_engine_test_{:x}", hasher.finish());

    let client = Client::with_uri_str(test_mongo_url()).await.unwrap();
    let db = client.database(&db_name);
    let collection = db.collection::<ModeDocument>("engineConfig");
    collection.delete_many(doc! {}).await.unwrap();
    collection
}

async fn wait_until(store: &ModeStore, predicate: impl Fn(&ModeStore) -> bool) {
    timeout(Duration::from_secs(10), async {
        loop {
            if predicate(store) {
                return;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("condition was not met within timeout");
}

#[tokio::test]
async fn a_fresh_store_defaults_to_mock_before_loading_anything() {
    let store = ModeStore::new();
    assert_eq!(store.get(), EngineMode::Mock);
}

#[tokio::test]
async fn loads_the_existing_mode_on_startup() {
    let collection = fresh_collection("loads_the_existing_mode_on_startup").await;
    collection
        .insert_one(ModeDocument::singleton(EngineMode::Live))
        .await
        .unwrap();

    let store = ModeStore::new();
    load_initial(&collection, &store).await.unwrap();

    assert_eq!(store.get(), EngineMode::Live);
}

#[tokio::test]
async fn missing_document_leaves_the_default_mock_mode_in_place() {
    let collection =
        fresh_collection("missing_document_leaves_the_default_mock_mode_in_place").await;

    let store = ModeStore::new();
    load_initial(&collection, &store).await.unwrap();

    assert_eq!(store.get(), EngineMode::Mock);
}

#[tokio::test]
async fn a_mode_switch_propagates_via_the_change_stream() {
    let collection = fresh_collection("a_mode_switch_propagates_via_the_change_stream").await;
    collection
        .insert_one(ModeDocument::singleton(EngineMode::Mock))
        .await
        .unwrap();

    let store = ModeStore::new();
    load_initial(&collection, &store).await.unwrap();
    assert_eq!(store.get(), EngineMode::Mock);

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        watch_changes(watch_collection, watch_store).await.ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "_id": "singleton" },
            doc! { "$set": { "mode": "live" } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| s.get() == EngineMode::Live).await;
}

#[tokio::test]
async fn switching_back_to_mock_also_propagates() {
    let collection = fresh_collection("switching_back_to_mock_also_propagates").await;
    collection
        .insert_one(ModeDocument::singleton(EngineMode::Live))
        .await
        .unwrap();

    let store = ModeStore::new();
    load_initial(&collection, &store).await.unwrap();
    assert_eq!(store.get(), EngineMode::Live);

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        watch_changes(watch_collection, watch_store).await.ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "_id": "singleton" },
            doc! { "$set": { "mode": "mock" } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| s.get() == EngineMode::Mock).await;
}
