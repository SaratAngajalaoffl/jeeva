use engine::market_data::{MarketDataSample, MarketDataWriter, PostgresMarketDataWriter};
use sqlx::Row;

fn test_database_url() -> String {
    std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://jeeva:jeeva@localhost:5432/jeeva_test".to_string())
}

async fn fresh_writer() -> PostgresMarketDataWriter {
    PostgresMarketDataWriter::connect(&test_database_url())
        .await
        .expect("failed to connect to TimescaleDB")
}

fn sample(symbol: &str) -> MarketDataSample {
    MarketDataSample {
        symbol: symbol.to_string(),
        price: 65000.5,
        open_interest: 1234.0,
        volume: 987654.0,
        spread: 1.5,
        mid_price: 65001.25,
    }
}

#[tokio::test]
async fn writes_a_sample_row_readable_back_from_the_hypertable() {
    let writer = fresh_writer().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect(&test_database_url())
        .await
        .unwrap();

    let symbol = "TESTWRITE1";
    sqlx::query("DELETE FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .execute(&pool)
        .await
        .unwrap();

    writer.write(&sample(symbol)).await.unwrap();

    let row = sqlx::query(
        "SELECT price, open_interest, volume, spread, mid_price FROM market_data WHERE symbol = $1",
    )
    .bind(symbol)
    .fetch_one(&pool)
    .await
    .unwrap();

    let price: f64 = row.get("price");
    let open_interest: f64 = row.get("open_interest");
    let volume: f64 = row.get("volume");
    let spread: f64 = row.get("spread");
    let mid_price: f64 = row.get("mid_price");

    assert_eq!(price, 65000.5);
    assert_eq!(open_interest, 1234.0);
    assert_eq!(volume, 987654.0);
    assert_eq!(spread, 1.5);
    assert_eq!(mid_price, 65001.25);
}

#[tokio::test]
async fn writes_multiple_samples_for_the_same_symbol_as_separate_rows() {
    let writer = fresh_writer().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect(&test_database_url())
        .await
        .unwrap();

    let symbol = "TESTWRITE2";
    sqlx::query("DELETE FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .execute(&pool)
        .await
        .unwrap();

    writer.write(&sample(symbol)).await.unwrap();
    writer.write(&sample(symbol)).await.unwrap();
    writer.write(&sample(symbol)).await.unwrap();

    let row = sqlx::query("SELECT count(*) as count FROM market_data WHERE symbol = $1")
        .bind(symbol)
        .fetch_one(&pool)
        .await
        .unwrap();
    let count: i64 = row.get("count");
    assert_eq!(count, 3);
}

#[tokio::test]
async fn market_data_table_is_a_hypertable() {
    let _writer = fresh_writer().await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect(&test_database_url())
        .await
        .unwrap();

    let row = sqlx::query(
        "SELECT count(*) as count FROM timescaledb_information.hypertables WHERE hypertable_name = 'market_data'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let count: i64 = row.get("count");
    assert_eq!(count, 1);
}
