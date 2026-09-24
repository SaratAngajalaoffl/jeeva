use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant, MissedTickBehavior};

use super::decision_maker::DecisionMaker;
use super::decision_maker_registry::DecisionMakerRegistry;
use super::execution::ExecutionAdapter;
use super::health::FailureTracker;
use super::history::{build_context, effective_history_window, MarketDataHistoryReader};
use super::log::{DecisionLogEntry, DecisionLogWriter};
use super::model::{decide_action, JevDecision, Probabilities, TargetDirection};
use crate::funding::FundingHistoryReader;
use crate::mode::ModeStore;
use crate::scheduler::{delay_until_next_boundary, reconcile};
use crate::session::{SessionStore, TradingSessionConfig, TradingSessionStatus};
use crate::wallets::WalletRegistry;

const AUTO_FLATTEN_THRESHOLD: u32 = 5;

/// Default minimum confidence: `0.0`, i.e. every decision is actionable.
/// Matches pre-threshold behavior, so a deployment that never sets
/// `MIN_CONFIDENCE_TO_SHIFT` behaves exactly as it did before.
pub const DEFAULT_MIN_CONFIDENCE_TO_SHIFT: f64 = 0.0;

/// Parses a `MIN_CONFIDENCE_TO_SHIFT` value. Unset/blank falls back to
/// `DEFAULT_MIN_CONFIDENCE_TO_SHIFT`; a malformed or out-of-range value
/// is an error so a bad deployment config fails fast at startup rather
/// than silently holding (or shifting) every position. Pure so it's
/// unit-testable without mutating the process environment.
pub fn parse_min_confidence_to_shift(raw: Option<&str>) -> Result<f64, String> {
    let raw = match raw {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok(DEFAULT_MIN_CONFIDENCE_TO_SHIFT),
    };

    match raw.trim().parse::<f64>() {
        Ok(min) if min.is_finite() && (0.0..=1.0).contains(&min) => Ok(min),
        _ => Err(format!(
            "Invalid MIN_CONFIDENCE_TO_SHIFT: {raw} (expected a number between 0.0 and 1.0)"
        )),
    }
}

/// The minimum confidence a decision must clear to shift a position,
/// from the environment.
pub fn min_confidence_to_shift_from_env() -> Result<f64, String> {
    parse_min_confidence_to_shift(std::env::var("MIN_CONFIDENCE_TO_SHIFT").ok().as_deref())
}

/// Transitions a trading session to `closed` once the engine has
/// finished flattening it (soft or hard close). Abstracted behind a
/// trait so `run_decision_cycle` stays DB-free and directly testable.
#[async_trait]
pub trait SessionLifecycle: Send + Sync {
    async fn mark_closed(&self, session_id: &str);
}

pub struct PostgresSessionLifecycle {
    pool: PgPool,
}

impl PostgresSessionLifecycle {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl SessionLifecycle for PostgresSessionLifecycle {
    async fn mark_closed(&self, session_id: &str) {
        crate::session::close_session(&self.pool, session_id).await;
    }
}

/// The set of trading sessions that should currently be evaluated, each
/// mapped to its configured decision frequency (in seconds). Every
/// non-closed session runs a task — including `soft_closing`/
/// `hard_closing` ones, whose task flattens the position and then
/// closes the session itself (see `run_decision_cycle`).
pub fn desired_state(sessions: &HashMap<String, TradingSessionConfig>) -> HashMap<String, f64> {
    sessions
        .iter()
        .map(|(id, s)| (id.clone(), s.decision_frequency_seconds))
        .collect()
}

fn flat_decision() -> JevDecision {
    JevDecision {
        direction: TargetDirection::Flat,
        confidence: 1.0,
        probabilities: Probabilities {
            long: 0.0,
            short: 0.0,
            flat: 1.0,
        },
        raw_request: None,
        raw_response: None,
    }
}

/// Runs a single decision cycle for one trading session: builds context
/// from recent market history (reading this session's configured window
/// and rendering it in this session's configured format), asks its
/// configured `DecisionMaker` for a Target Direction (or, when the
/// session is closing, skips straight to a forced Flat target), compares
/// it to the current Position State, applies the resulting action, and
/// always writes a decision-log row. Free of any scheduling concerns,
/// so it's directly testable.
///
/// `min_confidence_to_shift` is the engine-wide floor for acting on a
/// decision (see `MIN_CONFIDENCE_TO_SHIFT`): a decision whose winning
/// confidence falls below it holds the current position instead of
/// shifting. Forced flattening (soft/hard close, auto-flatten) is never
/// gated by it — a flatten is never blocked by low confidence.
///
/// `now` is "the present moment" as far as the built decision context
/// is concerned (e.g. how long a position has been held) — the live
/// loop passes the wall clock; a backtest replay passes its simulated
/// time, so a replayed cycle's context reads exactly as it would have
/// live.
#[allow(clippy::too_many_arguments)]
pub async fn run_decision_cycle(
    session_id: &str,
    symbol: &str,
    config: &TradingSessionConfig,
    min_confidence_to_shift: f64,
    now: DateTime<Utc>,
    history: &dyn MarketDataHistoryReader,
    decision_maker: &dyn DecisionMaker,
    execution: &dyn ExecutionAdapter,
    funding: &dyn FundingHistoryReader,
    decision_log: &dyn DecisionLogWriter,
    health: &dyn FailureTracker,
    lifecycle: &dyn SessionLifecycle,
) {
    let samples = match history
        .recent_samples(
            symbol,
            effective_history_window(config.history_window_samples),
        )
        .await
    {
        Ok(samples) => samples,
        Err(error) => {
            tracing::error!(symbol, session_id, %error, "failed to read market data history");
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: "",
                    decision: None,
                    position_action: None,
                    error: Some(&error.to_string()),
                    auto_flatten: false,
                    raw_request: None,
                    raw_response: None,
                })
                .await;
            return;
        }
    };

    if samples.is_empty() {
        let context_summary =
            build_context(symbol, &samples, None, None, config.history_format, now);
        tracing::warn!(
            symbol,
            session_id,
            "no market data available yet; skipping decision cycle"
        );
        let _ = decision_log
            .write(DecisionLogEntry {
                symbol,
                context_summary: &context_summary,
                decision: None,
                position_action: None,
                error: Some("no market data available yet"),
                auto_flatten: false,
                raw_request: None,
                raw_response: None,
            })
            .await;
        return;
    }

    let latest_mid_price = samples.last().unwrap().mid_price;

    if config.status == TradingSessionStatus::HardClosing {
        let result = execution.close(session_id, symbol, latest_mid_price).await;
        let error = result.as_ref().err().map(|e| e.to_string());
        let _ = decision_log
            .write(DecisionLogEntry {
                symbol,
                context_summary: "hard close: force-flattening position",
                decision: None,
                position_action: Some(super::model::PositionAction::Close),
                error: error.as_deref(),
                auto_flatten: false,
                raw_request: None,
                raw_response: None,
            })
            .await;

        match result {
            Ok(()) => lifecycle.mark_closed(session_id).await,
            Err(error) => {
                tracing::error!(symbol, session_id, %error, "hard close failed to flatten position; will retry")
            }
        }
        return;
    }

    let current_position = match execution.get_position(session_id, symbol).await {
        Ok(position) => position,
        Err(error) => {
            tracing::error!(symbol, session_id, %error, "failed to read current position");
            let context_summary =
                build_context(symbol, &samples, None, None, config.history_format, now);
            handle_cycle_failure(
                symbol,
                &error.to_string(),
                &context_summary,
                session_id,
                latest_mid_price,
                execution,
                decision_log,
                health,
                None,
                None,
            )
            .await;
            return;
        }
    };

    let latest_funding = match funding.latest(symbol).await {
        Ok(funding) => funding,
        Err(error) => {
            tracing::warn!(symbol, session_id, %error, "failed to read latest funding rate; continuing without it");
            None
        }
    };

    let context_summary = build_context(
        symbol,
        &samples,
        current_position.as_ref(),
        latest_funding.as_ref(),
        config.history_format,
        now,
    );

    let is_soft_closing = config.status == TradingSessionStatus::SoftClosing;

    let decision = if is_soft_closing {
        flat_decision()
    } else {
        match decision_maker.decide(symbol, &context_summary).await {
            Ok(decision) => decision,
            Err(error) => {
                tracing::error!(symbol, session_id, %error, "decision maker failed");
                let (raw_request, raw_response) = if config.store_decision_payloads {
                    (error.raw_request.as_deref(), error.raw_response.as_deref())
                } else {
                    (None, None)
                };
                handle_cycle_failure(
                    symbol,
                    &error.to_string(),
                    &context_summary,
                    session_id,
                    latest_mid_price,
                    execution,
                    decision_log,
                    health,
                    raw_request,
                    raw_response,
                )
                .await;
                return;
            }
        }
    };

    let current_direction = current_position.map(|p| p.direction);

    // A near-tie (e.g. long 0.34 / short 0.33 / flat 0.33) picks a
    // winning direction outright, but shouldn't be acted on: below the
    // configured floor, hold whatever position we already have. A
    // soft-close's forced Flat target isn't routed through here.
    let action = if is_soft_closing || decision.confidence >= min_confidence_to_shift {
        decide_action(current_direction, decision.direction)
    } else {
        tracing::info!(
            symbol,
            session_id,
            confidence = decision.confidence,
            min_confidence_to_shift,
            direction = decision.direction.as_str(),
            "decision below the confidence floor; holding current position"
        );
        super::model::PositionAction::NoOp
    };

    let execution_result = apply_action(
        execution,
        session_id,
        symbol,
        action,
        config.position_size_usd,
        config.leverage,
        latest_mid_price,
    )
    .await;

    match execution_result {
        Ok(()) => {
            tracing::info!(
                symbol,
                session_id,
                target_direction = decision.direction.as_str(),
                action = ?action,
                "decision cycle complete"
            );
            health.record_success(symbol).await;
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: &context_summary,
                    decision: Some(&decision),
                    position_action: Some(action),
                    error: None,
                    auto_flatten: false,
                    raw_request: config
                        .store_decision_payloads
                        .then_some(decision.raw_request.as_deref())
                        .flatten(),
                    raw_response: config
                        .store_decision_payloads
                        .then_some(decision.raw_response.as_deref())
                        .flatten(),
                })
                .await;

            if is_soft_closing {
                lifecycle.mark_closed(session_id).await;
            }
        }
        Err(error) => {
            tracing::error!(symbol, session_id, %error, "failed to apply position action");
            let count = health.record_failure(symbol, &error).await;
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: &context_summary,
                    decision: Some(&decision),
                    position_action: Some(action),
                    error: Some(&error),
                    auto_flatten: false,
                    raw_request: config
                        .store_decision_payloads
                        .then_some(decision.raw_request.as_deref())
                        .flatten(),
                    raw_response: config
                        .store_decision_payloads
                        .then_some(decision.raw_response.as_deref())
                        .flatten(),
                })
                .await;
            if count >= AUTO_FLATTEN_THRESHOLD {
                auto_flatten(
                    symbol,
                    session_id,
                    latest_mid_price,
                    execution,
                    decision_log,
                )
                .await;
            }
        }
    }
}

/// Common handling for a `DecisionMaker`/`ExecutionAdapter` failure that happens
/// before a decision is even reached: logs the normal failure entry,
/// increments the symbol's consecutive-failure count, and — once that
/// count hits the auto-flatten threshold — force-flattens the position
/// and logs that distinctly from a normal decision-driven change.
#[allow(clippy::too_many_arguments)]
async fn handle_cycle_failure(
    symbol: &str,
    reason: &str,
    context_summary: &str,
    session_id: &str,
    mid_price: f64,
    execution: &dyn ExecutionAdapter,
    decision_log: &dyn DecisionLogWriter,
    health: &dyn FailureTracker,
    raw_request: Option<&str>,
    raw_response: Option<&str>,
) {
    let count = health.record_failure(symbol, reason).await;
    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary,
            decision: None,
            position_action: None,
            error: Some(reason),
            auto_flatten: false,
            raw_request,
            raw_response,
        })
        .await;

    if count >= AUTO_FLATTEN_THRESHOLD {
        auto_flatten(symbol, session_id, mid_price, execution, decision_log).await;
    }
}

async fn auto_flatten(
    symbol: &str,
    session_id: &str,
    mid_price: f64,
    execution: &dyn ExecutionAdapter,
    decision_log: &dyn DecisionLogWriter,
) {
    tracing::warn!(
        symbol,
        session_id,
        "5 consecutive failures reached; force-flattening position"
    );

    let result = execution.close(session_id, symbol, mid_price).await;
    if let Err(error) = &result {
        tracing::error!(symbol, session_id, %error, "auto-flatten failed to close position");
    }

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary: "auto-flatten: 5 consecutive failures",
            decision: None,
            position_action: Some(super::model::PositionAction::Close),
            error: result.err().map(|e| e.to_string()).as_deref(),
            auto_flatten: true,
            raw_request: None,
            raw_response: None,
        })
        .await;
}

#[allow(clippy::too_many_arguments)]
async fn apply_action(
    execution: &dyn ExecutionAdapter,
    session_id: &str,
    symbol: &str,
    action: super::model::PositionAction,
    position_size_usd: f64,
    leverage: f64,
    mid_price: f64,
) -> Result<(), String> {
    use super::model::PositionAction;

    match action {
        PositionAction::NoOp => Ok(()),
        PositionAction::Open(direction) => execution
            .open(
                session_id,
                symbol,
                direction,
                position_size_usd,
                leverage,
                mid_price,
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        PositionAction::Close => execution
            .close(session_id, symbol, mid_price)
            .await
            .map_err(|e| e.to_string()),
        PositionAction::CloseThenOpen(direction) => {
            execution
                .close(session_id, symbol, mid_price)
                .await
                .map_err(|e| e.to_string())?;
            execution
                .open(
                    session_id,
                    symbol,
                    direction,
                    position_size_usd,
                    leverage,
                    mid_price,
                )
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_task(
    session_id: String,
    frequency_seconds: f64,
    store: SessionStore,
    min_confidence_to_shift: f64,
    history: Arc<dyn MarketDataHistoryReader>,
    decision_makers: Arc<DecisionMakerRegistry>,
    wallets: Arc<WalletRegistry>,
    mode: ModeStore,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    health: Arc<dyn FailureTracker>,
    lifecycle: Arc<dyn SessionLifecycle>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs_f64(frequency_seconds.max(0.001));
        let start = Instant::now() + delay_until_next_boundary(frequency_seconds);
        let mut ticker = interval_at(start, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if let Some(config) = store.get(&session_id) {
                let Some(execution) = resolve_execution(&config, &wallets, &mode) else {
                    continue;
                };
                let decision_maker = decision_makers.get(config.decision_maker);
                run_decision_cycle(
                    &session_id,
                    &config.symbol,
                    &config,
                    min_confidence_to_shift,
                    Utc::now(),
                    history.as_ref(),
                    decision_maker.as_ref(),
                    execution.as_ref(),
                    funding.as_ref(),
                    decision_log.as_ref(),
                    health.as_ref(),
                    lifecycle.as_ref(),
                )
                .await;
            }
        }
    })
}

/// Resolves the `ExecutionAdapter` for a session's configured wallet and
/// enforces the safety net: a session must never execute against a real
/// wallet while live trading is globally disabled (or a mock wallet
/// while the engine is switched to live) — this is checked on every
/// cycle, not just at attach-time, in case the two ever disagree.
fn resolve_execution(
    config: &TradingSessionConfig,
    wallets: &WalletRegistry,
    mode: &ModeStore,
) -> Option<Arc<dyn ExecutionAdapter>> {
    let symbol = config.symbol.as_str();
    let Some(wallet_id) = &config.wallet_id else {
        tracing::error!(
            symbol,
            session_id = %config.id,
            "session has no wallet attached; skipping cycle"
        );
        return None;
    };

    let Some((kind, adapter)) = wallets.resolve(wallet_id) else {
        tracing::error!(
            symbol,
            session_id = %config.id,
            wallet_id,
            "configured wallet not found or not ready; skipping cycle"
        );
        return None;
    };

    if !kind.matches_mode(mode.get()) {
        tracing::error!(
            symbol,
            session_id = %config.id,
            wallet_id,
            wallet_kind = ?kind,
            mode = mode.get().as_str(),
            "wallet kind does not match the current engine mode; refusing to trade"
        );
        return None;
    }

    Some(adapter)
}

/// Runs forever, polling the session store on `poll_interval` and
/// starting/stopping/restarting one decision task per non-closed
/// trading session so the running tasks always match what's in
/// Postgres — without ever restarting the engine itself.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    store: SessionStore,
    min_confidence_to_shift: f64,
    history: Arc<dyn MarketDataHistoryReader>,
    decision_makers: Arc<DecisionMakerRegistry>,
    wallets: Arc<WalletRegistry>,
    mode: ModeStore,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    health: Arc<dyn FailureTracker>,
    lifecycle: Arc<dyn SessionLifecycle>,
    poll_interval: Duration,
) -> ! {
    let mut running: HashMap<String, (f64, JoinHandle<()>)> = HashMap::new();

    loop {
        let sessions = store.snapshot();
        let desired = desired_state(&sessions);
        let running_frequencies: HashMap<String, f64> =
            running.iter().map(|(k, (f, _))| (k.clone(), *f)).collect();
        let actions = reconcile(&running_frequencies, &desired);

        for session_id in actions.to_stop {
            if let Some((_, handle)) = running.remove(&session_id) {
                handle.abort();
                tracing::info!(session_id = %session_id, "stopped decision loop");
            }
        }

        for (session_id, frequency) in actions.to_start {
            if let Some((_, handle)) = running.remove(&session_id) {
                handle.abort();
            }
            tracing::info!(session_id = %session_id, frequency_seconds = frequency, "starting decision loop");
            let handle = spawn_task(
                session_id.clone(),
                frequency,
                store.clone(),
                min_confidence_to_shift,
                history.clone(),
                decision_makers.clone(),
                wallets.clone(),
                mode.clone(),
                funding.clone(),
                decision_log.clone(),
                health.clone(),
                lifecycle.clone(),
            );
            running.insert(session_id, (frequency, handle));
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::super::decision_maker::DecisionError;
    use super::super::execution::{ExecutionError, OpenPosition};
    use super::super::health::InMemoryFailureTracker;
    use super::super::history::{HistoryError, HistoryFormat};
    use super::super::log::LogError;
    use super::super::model::{Direction, JevDecision, Probabilities, TargetDirection};
    use super::*;
    use crate::decision::DecisionMakerKind;
    use crate::funding::{FundingHistoryError, FundingRecord};
    use crate::market_data::MarketDataSample;

    fn sample_config(status: TradingSessionStatus, frequency: f64) -> TradingSessionConfig {
        TradingSessionConfig {
            id: "session-1".to_string(),
            symbol: "BTC".to_string(),
            decision_maker: DecisionMakerKind::Random,
            decision_frequency_seconds: frequency,
            leverage: 1.0,
            position_size_usd: 100.0,
            history_window_samples: 250,
            history_format: HistoryFormat::Summary,
            wallet_id: Some("test-wallet".to_string()),
            status,
            store_decision_payloads: false,
            stop_loss_pct: None,
        }
    }

    #[test]
    fn desired_state_includes_every_non_closed_session() {
        let sessions = HashMap::from([
            (
                "s1".to_string(),
                sample_config(TradingSessionStatus::Active, 30.0),
            ),
            (
                "s2".to_string(),
                sample_config(TradingSessionStatus::SoftClosing, 15.0),
            ),
        ]);

        let desired = desired_state(&sessions);
        assert_eq!(desired.get("s1"), Some(&30.0));
        assert_eq!(desired.get("s2"), Some(&15.0));
    }

    struct FakeHistory;

    #[async_trait]
    impl MarketDataHistoryReader for FakeHistory {
        async fn recent_samples(
            &self,
            symbol: &str,
            _limit: u32,
        ) -> Result<Vec<MarketDataSample>, HistoryError> {
            Ok(vec![MarketDataSample {
                symbol: symbol.to_string(),
                price: 100.0,
                open_interest: 1.0,
                volume: 1.0,
                spread: 0.1,
                mid_price: 100.0,
            }])
        }
    }

    struct FakeFunding;

    #[async_trait]
    impl FundingHistoryReader for FakeFunding {
        async fn latest(
            &self,
            _symbol: &str,
        ) -> Result<Option<FundingRecord>, FundingHistoryError> {
            Ok(None)
        }
    }

    struct NoopDecisionLog;

    #[async_trait]
    impl DecisionLogWriter for NoopDecisionLog {
        async fn write(&self, _entry: DecisionLogEntry<'_>) -> Result<(), LogError> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeLifecycle {
        closed: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl SessionLifecycle for FakeLifecycle {
        async fn mark_closed(&self, session_id: &str) {
            self.closed.lock().unwrap().push(session_id.to_string());
        }
    }

    /// Records whether each written entry was flagged as an
    /// auto-flatten, so tests can assert a forced flatten was (or
    /// wasn't) logged distinctly from a normal decision.
    #[derive(Default)]
    struct CapturingDecisionLog {
        auto_flatten_flags: Mutex<Vec<bool>>,
    }

    impl CapturingDecisionLog {
        fn auto_flatten_count(&self) -> usize {
            self.auto_flatten_flags
                .lock()
                .unwrap()
                .iter()
                .filter(|f| **f)
                .count()
        }
    }

    #[async_trait]
    impl DecisionLogWriter for CapturingDecisionLog {
        async fn write(&self, entry: DecisionLogEntry<'_>) -> Result<(), LogError> {
            self.auto_flatten_flags
                .lock()
                .unwrap()
                .push(entry.auto_flatten);
            Ok(())
        }
    }

    /// A `DecisionMaker` that always fails, for exercising the
    /// failure-handling/auto-flatten path.
    struct AlwaysFailingDecisionMaker;

    #[async_trait]
    impl DecisionMaker for AlwaysFailingDecisionMaker {
        async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
            Err(DecisionError::new("decision maker unavailable"))
        }
    }

    /// A `DecisionMaker` that fails on every call except the
    /// `succeed_on` (1-indexed) call, for exercising "a success resets
    /// the counter" behavior.
    struct SucceedsOnceDecisionMaker {
        succeed_on: usize,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl DecisionMaker for SucceedsOnceDecisionMaker {
        async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
            let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
            if call == self.succeed_on {
                Ok(JevDecision {
                    direction: TargetDirection::Flat,
                    confidence: 0.9,
                    probabilities: Probabilities {
                        long: 0.05,
                        short: 0.05,
                        flat: 0.9,
                    },
                    raw_request: None,
                    raw_response: None,
                })
            } else {
                Err(DecisionError::new("decision maker unavailable"))
            }
        }
    }

    /// A `MockExecutionAdapter` stand-in with no database dependency:
    /// tracks whether a position is open and counts `close` calls, so
    /// tests can assert the auto-flatten path actually closes.
    #[derive(Default)]
    struct FakeExecution {
        position: Mutex<Option<OpenPosition>>,
        close_calls: AtomicUsize,
    }

    impl FakeExecution {
        fn with_open_position() -> Self {
            Self {
                position: Mutex::new(Some(OpenPosition {
                    direction: Direction::Long,
                    entry_price: 100.0,
                    notional_usd: 1000.0,
                    opened_at: chrono::Utc::now(),
                })),
                close_calls: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl ExecutionAdapter for FakeExecution {
        async fn get_position(
            &self,
            _session_id: &str,
            _symbol: &str,
        ) -> Result<Option<OpenPosition>, ExecutionError> {
            Ok(*self.position.lock().unwrap())
        }

        async fn open(
            &self,
            _session_id: &str,
            _symbol: &str,
            direction: Direction,
            _position_size_usd: f64,
            _leverage: f64,
            mid_price: f64,
        ) -> Result<OpenPosition, ExecutionError> {
            let position = OpenPosition {
                direction,
                entry_price: mid_price,
                notional_usd: 1000.0,
                opened_at: chrono::Utc::now(),
            };
            *self.position.lock().unwrap() = Some(position);
            Ok(position)
        }

        async fn close(
            &self,
            _session_id: &str,
            _symbol: &str,
            _mid_price: f64,
        ) -> Result<(), ExecutionError> {
            self.close_calls.fetch_add(1, Ordering::SeqCst);
            *self.position.lock().unwrap() = None;
            Ok(())
        }

        async fn list_open_positions(
            &self,
        ) -> Result<Vec<(String, String, OpenPosition)>, ExecutionError> {
            Ok(self
                .position
                .lock()
                .unwrap()
                .map(|p| ("test-session".to_string(), "BTC".to_string(), p))
                .into_iter()
                .collect())
        }

        async fn apply_funding(
            &self,
            _symbol: &str,
            _amount_usd: f64,
        ) -> Result<(), ExecutionError> {
            Ok(())
        }

        async fn reconcile(
            &self,
            _sessions: &[super::super::execution::ReconcileTarget],
        ) -> Result<Vec<super::super::execution::DriftOutcome>, ExecutionError> {
            Ok(Vec::new())
        }
    }

    #[tokio::test]
    async fn a_failed_jev_call_skips_the_cycle_and_increments_the_failure_counter() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
            Utc::now(),
            &FakeHistory,
            &AlwaysFailingDecisionMaker,
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &FakeLifecycle::default(),
        )
        .await;

        assert_eq!(health.count("BTC"), 1);
        // Position State is unchanged by a failed cycle.
        assert!(execution
            .get_position(&config.id, "BTC")
            .await
            .unwrap()
            .is_some());
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_successful_cycle_resets_the_failure_counter_to_zero() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        health.record_failure("BTC", "previous failure").await;
        health.record_failure("BTC", "previous failure").await;

        let decision_maker = SucceedsOnceDecisionMaker {
            succeed_on: 1,
            calls: AtomicUsize::new(0),
        };

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
            Utc::now(),
            &FakeHistory,
            &decision_maker,
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &FakeLifecycle::default(),
        )
        .await;

        assert_eq!(health.count("BTC"), 0);
    }

    #[tokio::test]
    async fn five_consecutive_failures_auto_flattens_the_position() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let decision_log = CapturingDecisionLog::default();

        for _ in 0..5 {
            run_decision_cycle(
                &config.id,
                &config.symbol,
                &config,
                DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
                Utc::now(),
                &FakeHistory,
                &AlwaysFailingDecisionMaker,
                &execution,
                &FakeFunding,
                &decision_log,
                &health,
                &FakeLifecycle::default(),
            )
            .await;
        }

        assert_eq!(health.count("BTC"), 5);
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution
            .get_position(&config.id, "BTC")
            .await
            .unwrap()
            .is_none());
        assert_eq!(decision_log.auto_flatten_count(), 1);
    }

    #[tokio::test]
    async fn a_success_at_the_fourth_failure_prevents_the_auto_flatten() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let decision_log = CapturingDecisionLog::default();

        let decision_maker = SucceedsOnceDecisionMaker {
            succeed_on: 4,
            calls: AtomicUsize::new(0),
        };

        for _ in 0..5 {
            run_decision_cycle(
                &config.id,
                &config.symbol,
                &config,
                DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
                Utc::now(),
                &FakeHistory,
                &decision_maker,
                &execution,
                &FakeFunding,
                &decision_log,
                &health,
                &FakeLifecycle::default(),
            )
            .await;
        }

        // Failures 1-3, success (reset) on 4, failure on 5 => count is 1.
        assert_eq!(health.count("BTC"), 1);
        // The one `close` call came from the success's normal Flat
        // decision, not a forced flatten.
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(decision_log.auto_flatten_count(), 0);
    }

    #[tokio::test]
    async fn soft_closing_forces_a_flat_target_and_closes_the_session_once_flat() {
        let config = sample_config(TradingSessionStatus::SoftClosing, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let lifecycle = FakeLifecycle::default();

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
            Utc::now(),
            &FakeHistory,
            // Even a decision maker that would pick Long must be
            // ignored while soft-closing.
            &SucceedsOnceDecisionMaker {
                succeed_on: 1,
                calls: AtomicUsize::new(0),
            },
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &lifecycle,
        )
        .await;

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution
            .get_position(&config.id, "BTC")
            .await
            .unwrap()
            .is_none());
        assert_eq!(lifecycle.closed.lock().unwrap().as_slice(), ["session-1"]);
    }

    #[tokio::test]
    async fn hard_closing_flattens_immediately_without_consulting_the_decision_maker() {
        let config = sample_config(TradingSessionStatus::HardClosing, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let lifecycle = FakeLifecycle::default();

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
            Utc::now(),
            &FakeHistory,
            &AlwaysFailingDecisionMaker,
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &lifecycle,
        )
        .await;

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert_eq!(lifecycle.closed.lock().unwrap().as_slice(), ["session-1"]);
    }

    /// The fake's Flat decision carries 0.9 confidence.
    const FAKE_DECISION_CONFIDENCE: f64 = 0.9;

    #[tokio::test]
    async fn a_decision_below_the_confidence_floor_holds_the_current_position() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            FAKE_DECISION_CONFIDENCE + 0.01,
            Utc::now(),
            &FakeHistory,
            &SucceedsOnceDecisionMaker {
                succeed_on: 1,
                calls: AtomicUsize::new(0),
            },
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &FakeLifecycle::default(),
        )
        .await;

        // The Flat target was below the floor, so the long is still open.
        assert!(execution
            .get_position(&config.id, "BTC")
            .await
            .unwrap()
            .is_some());
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 0);
        assert_eq!(health.count("BTC"), 0);
    }

    #[tokio::test]
    async fn a_decision_exactly_at_the_confidence_floor_still_shifts() {
        let config = sample_config(TradingSessionStatus::Active, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();

        run_decision_cycle(
            &config.id,
            &config.symbol,
            &config,
            FAKE_DECISION_CONFIDENCE,
            Utc::now(),
            &FakeHistory,
            &SucceedsOnceDecisionMaker {
                succeed_on: 1,
                calls: AtomicUsize::new(0),
            },
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
            &FakeLifecycle::default(),
        )
        .await;

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution
            .get_position(&config.id, "BTC")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn min_confidence_defaults_to_zero_when_unset_or_blank() {
        assert_eq!(parse_min_confidence_to_shift(None).unwrap(), 0.0);
        assert_eq!(parse_min_confidence_to_shift(Some("")).unwrap(), 0.0);
        assert_eq!(parse_min_confidence_to_shift(Some("  ")).unwrap(), 0.0);
    }

    #[test]
    fn min_confidence_accepts_a_value_between_zero_and_one() {
        assert_eq!(parse_min_confidence_to_shift(Some("0.5")).unwrap(), 0.5);
        assert_eq!(parse_min_confidence_to_shift(Some("1")).unwrap(), 1.0);
        assert_eq!(parse_min_confidence_to_shift(Some("0")).unwrap(), 0.0);
    }

    #[test]
    fn min_confidence_rejects_malformed_or_out_of_range_values() {
        assert!(parse_min_confidence_to_shift(Some("high")).is_err());
        assert!(parse_min_confidence_to_shift(Some("1.5")).is_err());
        assert!(parse_min_confidence_to_shift(Some("-0.1")).is_err());
        assert!(parse_min_confidence_to_shift(Some("NaN")).is_err());
        assert!(parse_min_confidence_to_shift(Some("inf")).is_err());
    }
}
