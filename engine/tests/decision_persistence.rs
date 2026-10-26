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

        sqlx::query("DELETE FROM mock_positions WHERE session_id IN ($1::uuid, $2::uuid)")
            .bind("00000000-0000-0000-0000-0000000000e1")
            .bind("00000000-0000-0000-0000-0000000000e7")
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
    async fn listing_open_positions_preserves_each_sessions_symbol() {
        let pool = pool().await;
        let _guard = WALLET_LOCK.lock().await;
        let wallet_id = reset_wallet(&pool, 10_000.0).await;
        let session_a = "00000000-0000-0000-0000-0000000000e1";
        let session_b = "00000000-0000-0000-0000-0000000000e7";
        sqlx::query("DELETE FROM mock_positions WHERE session_id IN ($1::uuid, $2::uuid)")
            .bind(session_a)
            .bind(session_b)
            .execute(&pool)
            .await
            .unwrap();

        let adapter = MockExecutionAdapter::new(pool.clone(), 0.0, wallet_id);
        adapter
            .open(session_a, "TESTLISTA", Direction::Long, 100.0, 1.0, 100.0)
            .await
            .unwrap();
        adapter
            .open(session_b, "TESTLISTB", Direction::Short, 200.0, 1.0, 200.0)
            .await
            .unwrap();

        let mut positions = adapter.list_open_positions().await.unwrap();
        positions.sort_by(|left, right| left.0.cmp(&right.0));
        assert_eq!(positions.len(), 2);
        assert_eq!(positions[0].0, session_a);
        assert_eq!(positions[0].1, "TESTLISTA");
        assert_eq!(positions[1].0, session_b);
        assert_eq!(positions[1].1, "TESTLISTB");
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
        let session_id: String =
            sqlx::query("INSERT INTO trading_sessions (symbol) VALUES ($1) RETURNING id::text")
                .bind("TESTLOG1")
                .fetch_one(&pool)
                .await
                .unwrap()
                .get("id");

        let decision = JevDecision {
            direction: TargetDirection::Long,
            confidence: 0.8,
            probabilities: Probabilities {
                long: 0.7,
                short: 0.1,
                flat: 0.2,
            },
            raw_request: None,
            raw_response: None,
        };

        writer
            .write(DecisionLogEntry {
                symbol: "TESTLOG1",
                session_id: Some(&session_id),
                context_summary: "BTC: price=100",
                decision: Some(&decision),
                position_action: Some(PositionAction::Open(Direction::Long)),
                error: None,
                auto_flatten: false,
                raw_request: None,
                raw_response: None,
            })
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT session_id::text, symbol, target_direction, confidence, position_action, success FROM decisions WHERE symbol = $1",
        )
        .bind("TESTLOG1")
        .fetch_one(&pool)
        .await
        .unwrap();

        let stored_session_id: String = row.get("session_id");
        let symbol: String = row.get("symbol");
        let target_direction: Option<String> = row.get("target_direction");
        let confidence: Option<f64> = row.get("confidence");
        let position_action: Option<String> = row.get("position_action");
        let success: bool = row.get("success");

        assert_eq!(stored_session_id, session_id);
        assert_eq!(symbol, "TESTLOG1");
        assert_eq!(target_direction.as_deref(), Some("long"));
        assert_eq!(confidence, Some(0.8));
        assert_eq!(position_action.as_deref(), Some("opened"));
        assert!(success);
    }

    #[tokio::test]
    async fn writes_and_reads_back_the_raw_request_and_response_when_provided() {
        let pool = pool().await;
        let writer = PostgresDecisionLogWriter::new(pool.clone());

        sqlx::query("DELETE FROM decisions WHERE symbol = $1")
            .bind("TESTLOGRAW")
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
            raw_request: Some(r#"{"state":"BTC context"}"#.to_string()),
            raw_response: Some(r#"{"choice":"long","confidence":0.8}"#.to_string()),
        };

        writer
            .write(DecisionLogEntry {
                symbol: "TESTLOGRAW",
                session_id: None,
                context_summary: "BTC: price=100",
                decision: Some(&decision),
                position_action: Some(PositionAction::Open(Direction::Long)),
                error: None,
                auto_flatten: false,
                raw_request: decision.raw_request.as_deref(),
                raw_response: decision.raw_response.as_deref(),
            })
            .await
            .unwrap();

        let row = sqlx::query(
            "SELECT raw_request::text AS raw_request, raw_response::text AS raw_response \
             FROM decisions WHERE symbol = $1",
        )
        .bind("TESTLOGRAW")
        .fetch_one(&pool)
        .await
        .unwrap();

        let raw_request: Option<String> = row.get("raw_request");
        let raw_response: Option<String> = row.get("raw_response");

        assert_eq!(
            raw_request.map(|s| s.parse::<serde_json::Value>().unwrap()),
            Some(serde_json::json!({"state": "BTC context"}))
        );
        assert_eq!(
            raw_response.map(|s| s.parse::<serde_json::Value>().unwrap()),
            Some(serde_json::json!({"choice": "long", "confidence": 0.8}))
        );
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
                session_id: None,
                context_summary: "TESTLOG2: no recent market data available",
                decision: None,
                position_action: None,
                error: Some("no market data available yet"),
                auto_flatten: false,
                raw_request: None,
                raw_response: None,
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
                    session_id: None,
                    context_summary: "context",
                    decision: None,
                    position_action: None,
                    error: Some("no market data available yet"),
                    auto_flatten: false,
                    raw_request: None,
                    raw_response: None,
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
    use chrono::{Duration, Utc};
    use engine::decision::MAX_HISTORY_SAMPLES;

    async fn insert_sample(pool: &PgPool, symbol: &str, time: chrono::DateTime<Utc>, price: f64) {
        sqlx::query(
            "INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price) VALUES ($1, $2, $3, 1, 1, 1, $3)",
        )
        .bind(time)
        .bind(symbol)
        .bind(price)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn clear(pool: &PgPool, symbol: &str) {
        sqlx::query("DELETE FROM market_data WHERE symbol = $1")
            .bind(symbol)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reads_back_recent_samples_oldest_first() {
        let pool = pool().await;
        clear(&pool, "TESTHIST1").await;
        let now = Utc::now();
        for (i, price) in [100.0, 101.0, 102.0].into_iter().enumerate() {
            insert_sample(
                &pool,
                "TESTHIST1",
                now - Duration::seconds(2 - i as i64),
                price,
            )
            .await;
        }

        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader.recent_samples("TESTHIST1", 10).await.unwrap();

        assert_eq!(samples.len(), 3);
        assert_eq!(samples[0].price, 100.0);
        assert_eq!(samples[2].price, 102.0);
    }

    #[tokio::test]
    async fn returns_empty_for_a_symbol_with_no_samples() {
        let pool = pool().await;
        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader.recent_samples("TESTHISTNONE", 10).await.unwrap();
        assert!(samples.is_empty());
    }

    #[tokio::test]
    async fn a_window_read_only_returns_samples_inside_the_window_with_their_timestamps() {
        let pool = pool().await;
        clear(&pool, "TESTHISTWIN").await;
        let now = Utc::now();
        // Recorded before the window opened, e.g. before sampling was
        // switched off for a while.
        insert_sample(&pool, "TESTHISTWIN", now - Duration::hours(3), 90.0).await;
        insert_sample(&pool, "TESTHISTWIN", now - Duration::minutes(30), 100.0).await;
        insert_sample(&pool, "TESTHISTWIN", now - Duration::minutes(1), 101.0).await;
        // After `to`: a replay must never see it.
        insert_sample(&pool, "TESTHISTWIN", now + Duration::minutes(1), 999.0).await;

        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader
            .samples_in_window("TESTHISTWIN", now - Duration::hours(1), now)
            .await
            .unwrap();

        let prices: Vec<f64> = samples.iter().map(|s| s.sample.price).collect();
        assert_eq!(prices, vec![100.0, 101.0]);
        let first_age = now - samples[0].time;
        assert!((first_age - Duration::minutes(30)).num_milliseconds().abs() < 5);

        let summary = build_context_summary("TESTHISTWIN", &samples, 3600, None, None, now);
        assert!(summary.contains("window=last 1h"));
        assert!(summary.contains("price=101.00"));
    }

    #[tokio::test]
    async fn a_window_with_only_stale_data_reads_back_empty() {
        let pool = pool().await;
        clear(&pool, "TESTHISTSTALE").await;
        let now = Utc::now();
        insert_sample(&pool, "TESTHISTSTALE", now - Duration::days(2), 100.0).await;

        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader
            .samples_in_window("TESTHISTSTALE", now - Duration::hours(1), now)
            .await
            .unwrap();
        assert!(samples.is_empty());
    }

    #[tokio::test]
    async fn a_dense_window_is_thinned_evenly_across_its_whole_span() {
        let pool = pool().await;
        clear(&pool, "TESTHISTDENSE").await;
        let now = Utc::now();
        let from = now - Duration::seconds(2 * i64::from(MAX_HISTORY_SAMPLES));
        // Two samples per bucket: twice what the read may return.
        sqlx::query(
            "INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price)
             SELECT $2 + make_interval(secs => s), $1, s, 1, 1, 1, s
             FROM generate_series(1, $3) AS s",
        )
        .bind("TESTHISTDENSE")
        .bind(from)
        .bind(2 * i32::try_from(MAX_HISTORY_SAMPLES).unwrap())
        .execute(&pool)
        .await
        .unwrap();

        let reader = PostgresMarketDataHistoryReader::new(pool.clone());
        let samples = reader
            .samples_in_window("TESTHISTDENSE", from, now)
            .await
            .unwrap();

        assert!(samples.len() <= MAX_HISTORY_SAMPLES as usize);
        assert!(samples.len() >= MAX_HISTORY_SAMPLES as usize - 1);
        // Covers the whole window, not just its most recent end.
        assert!(samples.first().unwrap().sample.price <= 2.0);
        assert_eq!(
            samples.last().unwrap().sample.price,
            f64::from(2 * MAX_HISTORY_SAMPLES)
        );
        assert!(samples.windows(2).all(|pair| pair[0].time < pair[1].time));
    }
}
