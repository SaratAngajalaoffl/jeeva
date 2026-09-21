use engine::market_data::{prune_expired, DEFAULT_TTL_DAYS};
use sqlx::Row;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://jeeva:jeeva@localhost:5432/jeeva_test".to_string())
}

async fn fresh_pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .connect(&test_database_url())
        .await
        .expect("failed to connect to TimescaleDB")
}

async fn insert_sample(pool: &sqlx::PgPool, symbol: &str, age_days: f64) {
    sqlx::query(
        r#"
        INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price)
        VALUES (now() - make_interval(secs => $2), $1, 100, 10, 1000, 0.5, 100.25)
        "#,
    )
    .bind(symbol)
    .bind(age_days * 86_400.0)
    .execute(pool)
    .await
    .unwrap();
}

async fn count_for(pool: &sqlx::PgPool, symbol: &str) -> i64 {
    let row = sqlx::query("SELECT count(*) AS count FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .fetch_one(pool)
        .await
        .unwrap();
    row.get("count")
}

#[tokio::test]
async fn prunes_samples_older_than_the_default_ttl() {
    let pool = fresh_pool().await;
    let symbol = "TESTTTL1";
    sqlx::query("DELETE FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .execute(&pool)
        .await
        .unwrap();

    insert_sample(&pool, symbol, 8.0).await; // older than 7 days
    insert_sample(&pool, symbol, 0.5).await; // within the TTL

    // Global prune; other tests' fixtures are younger than a day so a
    // 7-day prune never touches them.
    prune_expired(&pool, DEFAULT_TTL_DAYS).await.unwrap();

    assert_eq!(count_for(&pool, symbol).await, 1);
}

#[tokio::test]
async fn respects_a_custom_ttl() {
    let pool = fresh_pool().await;
    let symbol = "TESTTTL2";
    sqlx::query("DELETE FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .execute(&pool)
        .await
        .unwrap();

    insert_sample(&pool, symbol, 2.0).await;

    prune_expired(&pool, 1.0).await.unwrap();

    assert_eq!(count_for(&pool, symbol).await, 0);
}

#[tokio::test]
async fn keeps_samples_within_the_ttl_untouched() {
    let pool = fresh_pool().await;
    let symbol = "TESTTTL3";
    sqlx::query("DELETE FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .execute(&pool)
        .await
        .unwrap();

    insert_sample(&pool, symbol, 0.5).await;

    prune_expired(&pool, DEFAULT_TTL_DAYS).await.unwrap();
    assert_eq!(count_for(&pool, symbol).await, 1);
}
