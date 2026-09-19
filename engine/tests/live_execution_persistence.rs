use engine::decision::{LiveExecutionAdapter, PrivateKey};
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://jeeva:jeeva@localhost:5432/jeeva_test".to_string())
}

async fn pool() -> PgPool {
    PgPoolOptions::new()
        .connect(&test_database_url())
        .await
        .expect("failed to connect to TimescaleDB")
}

const TEST_KEY_HEX: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

async fn reset_engine_wallet_table(pool: &PgPool) {
    sqlx::query("DROP TABLE IF EXISTS engine_wallet")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn publish_public_address_persists_only_the_address_never_the_key() {
    let pool = pool().await;
    reset_engine_wallet_table(&pool).await;
    LiveExecutionAdapter::migrate(&pool).await.unwrap();

    let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
    let adapter = LiveExecutionAdapter::new("https://example.invalid", key, true);

    adapter.publish_public_address(&pool).await.unwrap();

    let row = sqlx::query("SELECT public_address FROM engine_wallet WHERE id = 1")
        .fetch_one(&pool)
        .await
        .unwrap();
    let stored_address: String = row.get("public_address");

    assert_eq!(stored_address, adapter.public_address());
    assert!(stored_address.starts_with("0x"));
    assert_eq!(stored_address.len(), 42);

    // The table has exactly one column besides the singleton id —
    // there is nowhere in this schema a key could have been written.
    let columns: Vec<String> = sqlx::query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'engine_wallet'",
    )
    .fetch_all(&pool)
    .await
    .unwrap()
    .into_iter()
    .map(|row| row.get::<String, _>("column_name"))
    .collect();
    assert_eq!(columns.len(), 2);
    assert!(columns.contains(&"id".to_string()));
    assert!(columns.contains(&"public_address".to_string()));
}

#[tokio::test]
async fn publish_public_address_is_idempotent_across_restarts() {
    let pool = pool().await;
    reset_engine_wallet_table(&pool).await;
    LiveExecutionAdapter::migrate(&pool).await.unwrap();

    let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
    let adapter = LiveExecutionAdapter::new("https://example.invalid", key, true);

    adapter.publish_public_address(&pool).await.unwrap();
    adapter.publish_public_address(&pool).await.unwrap();

    let count: i64 = sqlx::query("SELECT COUNT(*) AS count FROM engine_wallet")
        .fetch_one(&pool)
        .await
        .unwrap()
        .get("count");
    assert_eq!(count, 1);
}
