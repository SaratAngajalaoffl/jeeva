use std::sync::Arc;
use std::time::Duration as StdDuration;

use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use sqlx::PgPool;

use crate::decision::{
    run_decision_cycle, DecisionMaker, DecisionMakerKind, ExecutionAdapter, HistoryFormat,
    InMemoryFailureTracker, MarketDataHistoryReader, SessionLifecycle,
};
use crate::funding::run_funding_cycle;
use crate::session::{TradingSessionConfig, TradingSessionStatus};

use super::clock::SimClock;
use super::execution::BacktestExecutionAdapter;
use super::funding::{
    BacktestFundingPaymentWriter, HyperliquidHistoricalFundingRateSource,
    ReplayFundingHistoryReader, ReplayFundingRateSource,
};
use super::history::ReplayMarketDataHistoryReader;
use super::log::BacktestDecisionLogWriter;
use super::model::BacktestRun;

const DEFAULT_BACKTEST_SLIPPAGE_BPS: f64 = 5.0;
// Hyperliquid applies funding hourly; a backtest replays the same cadence.
const FUNDING_INTERVAL: Duration = Duration::hours(1);

/// A backtest run never transitions through `soft_closing`/
/// `hard_closing` mid-replay — the runner flattens the position itself
/// once the loop reaches `end_time` — so `mark_closed` is never called.
struct NoopSessionLifecycle;

#[async_trait]
impl SessionLifecycle for NoopSessionLifecycle {
    async fn mark_closed(&self, _session_id: &str) {}
}

fn slippage_bps_from_env() -> f64 {
    std::env::var("MOCK_SLIPPAGE_BPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_BACKTEST_SLIPPAGE_BPS)
}

fn to_session_config(run: &BacktestRun) -> TradingSessionConfig {
    TradingSessionConfig {
        id: run.id.clone(),
        symbol: run.symbol.clone(),
        decision_maker: run.decision_maker,
        decision_frequency_seconds: run.decision_frequency_seconds,
        leverage: run.leverage,
        position_size_usd: run.position_size_usd,
        history_window_samples: run.history_window_samples,
        history_format: run.history_format,
        wallet_id: None,
        // Always Active: HardClosing/SoftClosing are session-level
        // lifecycle states, irrelevant to a one-shot replay.
        status: TradingSessionStatus::Active,
    }
}

async fn mark_status(pool: &PgPool, run_id: &str, status: &str, error: Option<&str>) {
    let result = sqlx::query(
        "UPDATE backtest_runs SET status = $2, error = $3, completed_at = CASE WHEN $2 IN ('completed', 'failed') THEN now() ELSE completed_at END WHERE id = $1::uuid",
    )
    .bind(run_id)
    .bind(status)
    .bind(error)
    .execute(pool)
    .await;

    if let Err(error) = result {
        tracing::error!(run_id, %error, "failed to update backtest run status");
    }
}

/// Runs one backtest to completion: fetches historical funding for the
/// range, then steps through simulated timestamps from `start_time` to
/// `end_time` at the session's configured decision frequency, running
/// the exact same `run_decision_cycle` core the live engine uses at
/// each step (context built only from data at or before that step —
/// see `ReplayMarketDataHistoryReader`), applying funding on an hourly
/// simulated cadence, and finally force-flattening any open position at
/// `end_time`.
pub async fn run_backtest(
    pool: PgPool,
    run: BacktestRun,
    decision_maker: Arc<dyn DecisionMaker>,
) {
    mark_status(&pool, &run.id, "running", None).await;

    let funding_source = HyperliquidHistoricalFundingRateSource::default();
    let funding_series = match funding_source
        .fetch(&run.symbol, run.start_time, run.end_time)
        .await
    {
        Ok(series) => series,
        Err(error) => {
            tracing::error!(run_id = %run.id, %error, "failed to fetch historical funding for backtest");
            mark_status(
                &pool,
                &run.id,
                "failed",
                Some(&format!("failed to fetch historical funding: {error}")),
            )
            .await;
            return;
        }
    };

    let clock = Arc::new(SimClock::new(run.start_time));
    let config = to_session_config(&run);

    let history = ReplayMarketDataHistoryReader::new(pool.clone(), clock.clone());
    let execution = BacktestExecutionAdapter::new(
        pool.clone(),
        run.id.clone(),
        slippage_bps_from_env(),
        clock.clone(),
    );
    let funding_history = ReplayFundingHistoryReader::new(funding_series.clone(), clock.clone());
    let funding_rate_source = ReplayFundingRateSource::new(funding_series, clock.clone());
    let funding_payment_writer =
        BacktestFundingPaymentWriter::new(pool.clone(), run.id.clone(), clock.clone());
    let decision_log = BacktestDecisionLogWriter::new(pool.clone(), run.id.clone(), clock.clone());
    let health = InMemoryFailureTracker::new();
    let lifecycle = NoopSessionLifecycle;

    let step = Duration::milliseconds((run.decision_frequency_seconds * 1000.0) as i64);
    let mut sim_time = run.start_time;
    let mut next_funding_at = run.start_time + FUNDING_INTERVAL;

    while sim_time <= run.end_time {
        clock.set(sim_time);

        run_decision_cycle(
            &run.id,
            &run.symbol,
            &config,
            0.0,
            &history,
            decision_maker.as_ref(),
            &execution,
            &funding_history,
            &decision_log,
            &health,
            &lifecycle,
        )
        .await;

        if sim_time >= next_funding_at {
            run_funding_cycle(&execution, &funding_rate_source, &funding_payment_writer).await;
            next_funding_at = sim_time + FUNDING_INTERVAL;
        }

        sim_time += step;
    }

    // Force-flatten any position still open at the end of the range, so
    // the run's final balance reflects fully realized P&L.
    clock.set(run.end_time);
    if let Ok(samples) = history.recent_samples(&run.symbol, 1).await {
        if let Some(latest) = samples.last() {
            if let Err(error) = execution.close(&run.id, &run.symbol, latest.mid_price).await {
                tracing::error!(run_id = %run.id, %error, "failed to flatten backtest position at end of range");
            }
        }
    }

    mark_status(&pool, &run.id, "completed", None).await;
}

struct PendingBacktestRow {
    id: String,
    symbol: String,
    decision_maker: String,
    decision_frequency_seconds: f64,
    leverage: f64,
    position_size_usd: f64,
    history_window_samples: i32,
    history_format: String,
    start_time: DateTime<Utc>,
    end_time: DateTime<Utc>,
}

async fn claim_next_pending(pool: &PgPool) -> Option<PendingBacktestRow> {
    let row = sqlx::query_as::<_, (
        String,
        String,
        String,
        f64,
        f64,
        f64,
        i32,
        String,
        DateTime<Utc>,
        DateTime<Utc>,
    )>(
        r#"
        UPDATE backtest_runs SET status = 'running'
        WHERE id = (
            SELECT id FROM backtest_runs WHERE status = 'pending' ORDER BY created_at LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING id::text, symbol, decision_maker, decision_frequency_seconds, leverage,
                  position_size_usd, history_window_samples, history_format, start_time, end_time
        "#,
    )
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    row.map(
        |(
            id,
            symbol,
            decision_maker,
            decision_frequency_seconds,
            leverage,
            position_size_usd,
            history_window_samples,
            history_format,
            start_time,
            end_time,
        )| PendingBacktestRow {
            id,
            symbol,
            decision_maker,
            decision_frequency_seconds,
            leverage,
            position_size_usd,
            history_window_samples,
            history_format,
            start_time,
            end_time,
        },
    )
}

/// Picks up `pending` backtest runs one at a time and runs each to
/// completion. Deliberately not timer-driven like the live session
/// scheduler — a backtest replays as fast as the database allows, not
/// on wall-clock boundaries.
pub async fn run(
    pool: PgPool,
    decision_maker_for: Arc<dyn Fn(DecisionMakerKind) -> Arc<dyn DecisionMaker> + Send + Sync>,
    poll_interval: StdDuration,
) -> ! {
    loop {
        match claim_next_pending(&pool).await {
            Some(row) => {
                let Some(decision_maker_kind) = DecisionMakerKind::from_db(&row.decision_maker)
                else {
                    tracing::error!(run_id = %row.id, decision_maker = %row.decision_maker, "unknown decision maker for backtest run");
                    mark_status(&pool, &row.id, "failed", Some("unknown decision maker")).await;
                    continue;
                };
                let Some(history_format) = HistoryFormat::from_db(&row.history_format) else {
                    tracing::error!(run_id = %row.id, "unknown history format for backtest run");
                    mark_status(&pool, &row.id, "failed", Some("unknown history format")).await;
                    continue;
                };

                let run_config = BacktestRun {
                    id: row.id,
                    symbol: row.symbol,
                    decision_maker: decision_maker_kind,
                    decision_frequency_seconds: row.decision_frequency_seconds,
                    leverage: row.leverage,
                    position_size_usd: row.position_size_usd,
                    history_window_samples: row.history_window_samples.max(1) as u32,
                    history_format,
                    start_time: row.start_time,
                    end_time: row.end_time,
                };

                let decision_maker = decision_maker_for(decision_maker_kind);
                run_backtest(pool.clone(), run_config, decision_maker).await;
            }
            None => tokio::time::sleep(poll_interval).await,
        }
    }
}
