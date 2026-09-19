use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::Duration;

use engine::config::{ConfigStore, PerpConfig};
use mongodb::bson::doc;
use mongodb::{Client, Collection};
use tokio::time::{sleep, timeout};

fn test_mongo_url() -> String {
    std::env::var("TEST_MONGO_URL").unwrap_or_else(|_| "mongodb://localhost:27017".to_string())
}

/// Each test gets its own database (a short hash of the test's name, to
/// stay under MongoDB's 63-character database name limit) so tests
/// running in parallel never interfere with each other's collections.
async fn fresh_collection(test_name: &str) -> Collection<PerpConfig> {
    let mut hasher = DefaultHasher::new();
    test_name.hash(&mut hasher);
    let db_name = format!("jeeva_engine_test_{:x}", hasher.finish());

    let client = Client::with_uri_str(test_mongo_url()).await.unwrap();
    let db = client.database(&db_name);
    let collection = db.collection::<PerpConfig>("perpConfigs");
    collection.delete_many(doc! {}).await.unwrap();
    collection
}

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

/// Polls the store until `predicate` holds or the timeout elapses,
/// since change-stream propagation is asynchronous.
async fn wait_until(store: &ConfigStore, predicate: impl Fn(&ConfigStore) -> bool) {
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
async fn loads_existing_documents_on_startup() {
    let collection = fresh_collection("loads_existing_documents_on_startup").await;
    collection.insert_one(sample("BTC")).await.unwrap();
    collection.insert_one(sample("ETH")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    assert_eq!(store.len(), 2);
    assert_eq!(store.get("BTC").unwrap().symbol, "BTC");
    assert_eq!(store.get("ETH").unwrap().symbol, "ETH");
}

#[tokio::test]
async fn picks_up_an_inserted_document_via_the_change_stream() {
    let collection = fresh_collection("picks_up_an_inserted_document_via_the_change_stream").await;
    let store = ConfigStore::new();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });

    // Give the change stream a moment to establish before writing.
    sleep(Duration::from_millis(200)).await;
    collection.insert_one(sample("BTC")).await.unwrap();

    wait_until(&store, |s| s.get("BTC").is_some()).await;
    assert!(!store.get("BTC").unwrap().trading_enabled);
}

#[tokio::test]
async fn reflects_a_toggle_update_via_the_change_stream() {
    let collection = fresh_collection("reflects_a_toggle_update_via_the_change_stream").await;
    collection.insert_one(sample("BTC")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "symbol": "BTC" },
            doc! { "$set": { "tradingEnabled": true, "samplingEnabled": true } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| {
        s.get("BTC").map(|c| c.trading_enabled) == Some(true)
    })
    .await;

    let updated = store.get("BTC").unwrap();
    assert!(updated.trading_enabled);
    assert!(updated.sampling_enabled);
}

#[tokio::test]
async fn reflects_a_frequency_update_via_the_change_stream() {
    let collection = fresh_collection("reflects_a_frequency_update_via_the_change_stream").await;
    collection.insert_one(sample("BTC")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "symbol": "BTC" },
            doc! { "$set": { "decisionFrequencySeconds": 30.0, "samplingFrequencySeconds": 10.0 } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| {
        s.get("BTC").map(|c| c.decision_frequency_seconds) == Some(30.0)
    })
    .await;

    let updated = store.get("BTC").unwrap();
    assert_eq!(updated.decision_frequency_seconds, 30.0);
    assert_eq!(updated.sampling_frequency_seconds, 10.0);
}

#[tokio::test]
async fn reflects_a_leverage_and_size_update_via_the_change_stream() {
    let collection =
        fresh_collection("reflects_a_leverage_and_size_update_via_the_change_stream").await;
    collection.insert_one(sample("BTC")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "symbol": "BTC" },
            doc! { "$set": { "leverage": 10.0, "positionSizeUsd": 500.0 } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| s.get("BTC").map(|c| c.leverage) == Some(10.0)).await;

    let updated = store.get("BTC").unwrap();
    assert_eq!(updated.leverage, 10.0);
    assert_eq!(updated.position_size_usd, 500.0);
}

#[tokio::test]
async fn survives_multiple_sequential_changes_in_order() {
    let collection = fresh_collection("survives_multiple_sequential_changes_in_order").await;
    collection.insert_one(sample("BTC")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });
    sleep(Duration::from_millis(200)).await;

    for leverage in [2.0, 5.0, 10.0, 25.0] {
        collection
            .update_one(
                doc! { "symbol": "BTC" },
                doc! { "$set": { "leverage": leverage } },
            )
            .await
            .unwrap();
        wait_until(&store, |s| {
            s.get("BTC").map(|c| c.leverage) == Some(leverage)
        })
        .await;
    }

    assert_eq!(store.get("BTC").unwrap().leverage, 25.0);
}

#[tokio::test]
async fn tracks_multiple_perps_independently_through_the_change_stream() {
    let collection =
        fresh_collection("tracks_multiple_perps_independently_through_the_change_stream").await;
    collection.insert_one(sample("BTC")).await.unwrap();
    collection.insert_one(sample("ETH")).await.unwrap();

    let store = ConfigStore::new();
    engine::config::load_initial(&collection, &store)
        .await
        .unwrap();

    let watch_collection = collection.clone();
    let watch_store = store.clone();
    tokio::spawn(async move {
        engine::config::watch_changes(watch_collection, watch_store)
            .await
            .ok();
    });
    sleep(Duration::from_millis(200)).await;

    collection
        .update_one(
            doc! { "symbol": "BTC" },
            doc! { "$set": { "tradingEnabled": true, "samplingEnabled": true } },
        )
        .await
        .unwrap();

    wait_until(&store, |s| {
        s.get("BTC").map(|c| c.trading_enabled) == Some(true)
    })
    .await;

    assert!(store.get("BTC").unwrap().trading_enabled);
    assert!(!store.get("ETH").unwrap().trading_enabled);
}
