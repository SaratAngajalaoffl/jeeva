use engine::decision::{
    build_context_summary, DecisionLogEntry, DecisionLogWriter, Direction, ExecutionAdapter,
    JevDecision, MarketDataHistoryReader, MockExecutionAdapter, PositionAction,
    PostgresDecisionLogWriter, PostgresMarketDataHistoryReader, Probabilities, TargetDirection,
};
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

// This test wallet row is shared across every test in this file, so
// tests that mutate it must not run concurrently with each other.
static WALLET_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TEST_WALLET_ID: &str = "00000000-0000-0000-0000-0000000000d1";

async fn reset_wallet(pool: &PgPool, balance: f64) -> String {
    sqlx::query("DELETE FROM wallets WHERE id = $1::uuid")
        .bind(TEST_WALLET_ID)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO wallets (id, label, kind, initial_balance_usd, current_balance_usd) VALUES ($1::uuid, 'decision-persistence-test-wallet', 'mock', $2, $2)",
    )
    .bind(TEST_WALLET_ID)
    .bind(balance)
    .execute(pool)
    .await
    .unwrap();
    TEST_WALLET_ID.to_string()
}

async fn wallet_balance(pool: &PgPool) -> f64 {
    let row = sqlx::query("SELECT current_balance_usd FROM wallets WHERE id = $1::uuid")
        .bind(TEST_WALLET_ID)
        .fetch_one(pool)
        .await
        .unwrap();
    row.get("current_balance_usd")
}

mod execution {
    use super::*;

    #[tokio::test]
    async fn opening_a_position_persists_it_without_touching_the_wallet() {
        let pool = pool().await;
        let _guard = WALLET_LOCK.lock().await;
        let wallet_id = reset_wallet(&pool, 10_000.0).await;
        sqlx::query("DELETE FROM mock_positions WHERE session_id = $1::uuid")
            .bind("00000000-0000-0000-0000-0000000000e1")
            .execute(&pool)
            .await
            .unwrap();

        let adapter = MockExecutionAdapter::new(pool.clone(), 0.0, wallet_id);
        let position = adapter
            .open(
                "00000000-0000-0000-0000-0000000000e1",
                "TESTOPEN",
                Direction::Long,
                100.0,
                5.0,
                200.0,
            )
            .await
            .unwrap();

        assert_eq!(position.direction, Direction::Long);
        assert_eq!(position.entry_price, 200.0);
        assert_eq!(position.notional_usd, 500.0);

        let fetched = adapter
            .get_position("00000000-0000-0000-0000-0000000000e1", "TESTOPEN")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(fetched, position);
        assert_eq!(wallet_balance(&pool).await, 10_000.0);
    }

    #[tokio::test]
    async fn closing_a_winning_long_credits_the_wallet_and_clears_the_position() {
        let pool = pool().await;
        let _guard = WALLET_LOCK.lock().await;
        let wallet_id = reset_wallet(&pool, 10_000.0).await;
        sqlx::query("DELETE FROM mock_positions WHERE session_id = $1::uuid")
            .bind("00000000-0000-0000-0000-0000000000e2")
            .execute(&pool)
            .await
            .unwrap();

        let adapter = MockExecutionAdapter::new(pool.clone(), 0.0, wallet_id);
        adapter
            .open(
                "00000000-0000-0000-0000-0000000000e2",
                "TESTCLOSEWIN",
                Direction::Long,
                1000.0,
                1.0,
                100.0,
            )
            .await
            .unwrap();

        adapter
            .close(
                "00000000-0000-0000-0000-0000000000e2",
                "TESTCLOSEWIN",
                110.0,
            )
            .await
            .unwrap();

        // (110 - 100) / 100 * 1000 = +100
        assert_eq!(wallet_balance(&pool).await, 10_100.0);
        assert!(adapter
            .get_position("00000000-0000-0000-0000-0000000000e2", "TESTCLOSEWIN")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn closing_a_losing_short_debits_the_wallet() {
        let pool = pool().await;
        let _guard = WALLET_LOCK.lock().await;
        let wallet_id = reset_wallet(&pool, 10_000.0).await;
        sqlx::query("DELETE FROM mock_positions WHERE session_id = $1::uuid")
            .bind("00000000-0000-0000-0000-0000000000e3")
            .execute(&pool)
            .await
            .unwrap();

        let adapter = MockExecutionAdapter::new(pool.clone(), 0.0, wallet_id);
        adapter
            .open(
                "00000000-0000-0000-0000-0000000000e3",
                "TESTCLOSELOSE",
                Direction::Short,
                1000.0,
                1.0,
                100.0,
            )
            .await
            .unwrap();

        // price rose from 100 to 110: a short loses
        adapter
            .close(
                "00000000-0000-0000-0000-0000000000e3",
                "TESTCLOSELOSE",
                110.0,
            )
            .await
            .unwrap();

        assert_eq!(wallet_balance(&pool).await, 9_900.0);
    }

    #[tokio::test]
    async fn closing_a_symbol_with_no_open_position_is_a_no_op() {
        let pool = pool().await;
        let _guard = WALLET_LOCK.lock().await;
        let wallet_id = reset_wallet(&pool, 5_000.0).await;
        sqlx::query("DELETE FROM mock_positions WHERE session_id = $1::uuid")
            .bind("00000000-0000-0000-0000-0000000000e4")
            .execute(&pool)
            .await
            .unwrap();

        let adapter = MockExecutionAdapter::new(pool.clone(), 0.0, wallet_id);
        adapter
            .close("00000000-0000-0000-0000-0000000000e4", "TESTNOOP", 100.0)
            .await
            .unwrap();

        assert_eq!(wallet_balance(&pool).await, 5_000.0);
    }
}

mod decision_log {
    use super::*;

    #[tokio::test]
    async fn writes_a_row_readable_back_with_all_fields() {
        let pool = pool().await;
        let writer = PostgresDecisionLogWriter::new(pool.clone());

        sqlx::query("DELETE FROM decisions WHERE symbol = $1")
            .bind("TESTLOG1")
            .execute(&pool)
            .await
            .unwrap();

        let decision = JevDecision {
            direction: TargetDirection::Long,
            confidence: 0.8,
            probabilities: Probabilities {
                long: 0.7,
                short: 0.1,
                flat: 0.2,
            },
        };

        writer
            .write(DecisionLogEntry {
                symbol: "TESTLOG1",
                context_summary: "BTC: price=100",
                decision: Some(&decision),
                position_action: Some(PositionAction::Open(Direction::Long)),
                error: None,
                auto_flatten: false,
            })
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT symbol, target_direction, confidence, position_action, success FROM decisions WHERE symbol = $1",
        )
        .bind("TESTLOG1")
        .fetch_one(&pool)
        .await
        .unwrap();

        let symbol: String = row.get("symbol");
        let target_direction: Option<String> = row.get("target_direction");
        let confidence: Option<f64> = row.get("confidence");
        let position_action: Option<String> = row.get("position_action");
        let success: bool = row.get("success");

        assert_eq!(symbol, "TESTLOG1");
        assert_eq!(target_direction.as_deref(), Some("long"));
        assert_eq!(confidence, Some(0.8));
        assert_eq!(position_action.as_deref(), Some("opened"));
        assert!(success);
    }

    #[tokio::test]
    async fn writes_a_row_for_a_failed_cycle_with_no_decision() {
        let pool = pool().await;
        let writer = PostgresDecisionLogWriter::new(pool.clone());

        sqlx::query("DELETE FROM decisions WHERE symbol = $1")
            .bind("TESTLOG2")
            .execute(&pool)
            .await
            .unwrap();

        writer
            .write(DecisionLogEntry {
                symbol: "TESTLOG2",
                context_summary: "TESTLOG2: no recent market data available",
                decision: None,
                position_action: None,
                error: Some("no market data available yet"),
                auto_flatten: false,
            })
            .await
            .unwrap();

        let row =
            sqlx::query("SELECT target_direction, success, error FROM decisions WHERE symbol = $1")
                .bind("TESTLOG2")
                .fetch_one(&pool)
                .await
                .unwrap();

        let target_direction: Option<String> = row.get("target_direction");
        let success: bool = row.get("success");
        let error: Option<String> = row.get("error");

        assert_eq!(target_direction, None);
        assert!(!success);
        assert_eq!(error.as_deref(), Some("no market data available yet"));
    }

    #[tokio::test]
    async fn every_call_writes_a_separate_row() {
        let pool = pool().await;
        let writer = PostgresDecisionLogWriter::new(pool.clone());

        sqlx::query("DELETE FROM decisions WHERE symbol = $1")
            .bind("TESTLOG3")
            .execute(&pool)
            .await
            .unwrap();

        for _ in 0..3 {
            writer
                .write(DecisionLogEntry {
                    symbol: "TESTLOG3",
                    context_summary: "context",
                    decision: None,
                    position_action: None,
                    error: Some("no market data available yet"),
                    auto_flatten: false,
                })
                .await
                .unwrap();
        }

        let row = sqlx::query("SELECT count(*) as count FROM decisions WHERE symbol = $1")
            .bind("TESTLOG3")
            .fetch_one(&pool)
            .await
            .unwrap();
        let count: i64 = row.get("count");
        assert_eq!(count, 3);
    }
}

mod history {
    use super::*;

    #[tokio::test]
    async fn reads_back_recent_samples_oldest_first() {
        let pool = pool().await;
        sqlx::query("DELETE FROM market_data WHERE symbol = $1")
            .bind("TESTHIST1")
            .execute(&pool)
            .await
            .unwrap();

        for price in [100.0, 101.0, 102.0] {
            sqlx::query(
                "INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price) VALUES (now(), $1, $2, 1, 1, 1, $2)",
            )
            .bind("TESTHIST1")
            .bind(price)
            .execute(&pool)
            .await
            .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }

        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader.recent_samples("TESTHIST1", 10).await.unwrap();

        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].price, 100.0);
        assert_eq!(samples[2].price, 102.0);

        let summary = build_context_summary("TESTHIST1", &samples, None, None, chrono::Utc::now());
        assert!(summary.contains("price=102.00"));
    }

    #[tokio::test]
    async fn returns_empty_for_a_symbol_with_no_samples() {
        let pool = pool().await;
        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader.recent_samples("TESTHISTNONE", 10).await.unwrap();
        assert!(samples.is_empty());
    }
}
