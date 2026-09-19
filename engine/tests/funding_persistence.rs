use engine::decision::Direction;
use engine::funding::{FundingPaymentWriter, PostgresFundingPaymentWriter};
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

#[tokio::test]
async fn writes_a_row_readable_back_with_all_fields() {
    let pool = pool().await;
    PostgresFundingPaymentWriter::migrate(&pool).await.unwrap();
    let writer = PostgresFundingPaymentWriter::new(pool.clone());

    sqlx::query("DELETE FROM funding_payments WHERE symbol = $1")
        .bind("TESTFUND1")
        .execute(&pool)
        .await
        .unwrap();

    writer
        .write("TESTFUND1", Direction::Long, 0.0001, 1000.0, -0.1)
        .await
        .unwrap();

    let row = sqlx::query(
        "SELECT symbol, direction, funding_rate, notional_usd, amount_usd FROM funding_payments WHERE symbol = $1",
    )
    .bind("TESTFUND1")
    .fetch_one(&pool)
    .await
    .unwrap();

    let symbol: String = row.get("symbol");
    let direction: String = row.get("direction");
    let funding_rate: f64 = row.get("funding_rate");
    let notional_usd: f64 = row.get("notional_usd");
    let amount_usd: f64 = row.get("amount_usd");

    assert_eq!(symbol, "TESTFUND1");
    assert_eq!(direction, "long");
    assert_eq!(funding_rate, 0.0001);
    assert_eq!(notional_usd, 1000.0);
    assert_eq!(amount_usd, -0.1);
}

#[tokio::test]
async fn every_call_writes_a_separate_row() {
    let pool = pool().await;
    PostgresFundingPaymentWriter::migrate(&pool).await.unwrap();
    let writer = PostgresFundingPaymentWriter::new(pool.clone());

    sqlx::query("DELETE FROM funding_payments WHERE symbol = $1")
        .bind("TESTFUND2")
        .execute(&pool)
        .await
        .unwrap();

    for _ in 0..3 {
        writer
            .write("TESTFUND2", Direction::Short, 0.0001, 500.0, 0.05)
            .await
            .unwrap();
    }

    let row = sqlx::query("SELECT count(*) as count FROM funding_payments WHERE symbol = $1")
        .bind("TESTFUND2")
        .fetch_one(&pool)
        .await
        .unwrap();
    let count: i64 = row.get("count");
    assert_eq!(count, 3);
}

#[tokio::test]
async fn funding_payments_table_is_a_hypertable() {
    let pool = pool().await;
    PostgresFundingPaymentWriter::migrate(&pool).await.unwrap();

    let row = sqlx::query(
        "SELECT count(*) as count FROM timescaledb_information.hypertables WHERE hypertable_name = 'funding_payments'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let count: i64 = row.get("count");
    assert_eq!(count, 1);
}
