use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant, MissedTickBehavior};

use super::decision_maker::DecisionMaker;
use super::decision_maker_registry::DecisionMakerRegistry;
use super::execution::ExecutionAdapter;
use super::health::FailureTracker;
use super::history::{build_context_summary, MarketDataHistoryReader};
use super::log::{DecisionLogEntry, DecisionLogWriter};
use super::model::decide_action;
use crate::config::{ConfigStore, PerpConfig};
use crate::funding::FundingHistoryReader;
use crate::scheduler::{delay_until_next_boundary, reconcile};

const HISTORY_WINDOW: u32 = 1000;
const AUTO_FLATTEN_THRESHOLD: u32 = 5;

/// The set of symbols that should currently be evaluated, each mapped
/// to its configured decision frequency (in seconds).
pub fn desired_state(configs: &HashMap<String, PerpConfig>) -> HashMap<String, f64> {
    configs
        .iter()
        .filter(|(_, c)| c.trading_enabled)
        .map(|(symbol, c)| (symbol.clone(), c.decision_frequency_seconds))
        .collect()
}

/// Runs a single decision cycle for one PERP: builds context from
/// recent market history, asks its configured `DecisionMaker` for a
/// Target Direction, compares it to the current Position State, applies
/// the resulting action, and always writes a decision-log row —
/// including when there's no market data yet or the decision
/// maker/execution fails, so the log is a complete audit trail. Free of
/// any scheduling concerns, so it's directly testable.
#[allow(clippy::too_many_arguments)]
pub async fn run_decision_cycle(
    symbol: &str,
    config: &PerpConfig,
    history: &dyn MarketDataHistoryReader,
    decision_maker: &dyn DecisionMaker,
    execution: &dyn ExecutionAdapter,
    funding: &dyn FundingHistoryReader,
    decision_log: &dyn DecisionLogWriter,
    health: &dyn FailureTracker,
) {
    let samples = match history.recent_samples(symbol, HISTORY_WINDOW).await {
        Ok(samples) => samples,
        Err(error) => {
            tracing::error!(symbol, %error, "failed to read market data history");
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: "",
                    decision: None,
                    position_action: None,
                    error: Some(&error.to_string()),
                    auto_flatten: false,
                })
                .await;
            return;
        }
    };

    if samples.is_empty() {
        let context_summary = build_context_summary(symbol, &samples, None, None);
        tracing::warn!(
            symbol,
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
            })
            .await;
        return;
    }

    let latest_mid_price = samples.last().unwrap().mid_price;

    let current_position = match execution.get_position(symbol).await {
        Ok(position) => position,
        Err(error) => {
            tracing::error!(symbol, %error, "failed to read current position");
            let context_summary = build_context_summary(symbol, &samples, None, None);
            handle_cycle_failure(
                symbol,
                &error.to_string(),
                &context_summary,
                latest_mid_price,
                execution,
                decision_log,
                health,
            )
            .await;
            return;
        }
    };

    let latest_funding = match funding.latest(symbol).await {
        Ok(funding) => funding,
        Err(error) => {
            tracing::warn!(symbol, %error, "failed to read latest funding rate; continuing without it");
            None
        }
    };

    let context_summary = build_context_summary(
        symbol,
        &samples,
        current_position.as_ref(),
        latest_funding.as_ref(),
    );

    let decision = match decision_maker.decide(symbol, &context_summary).await {
        Ok(decision) => decision,
        Err(error) => {
            tracing::error!(symbol, %error, "decision maker failed");
            handle_cycle_failure(
                symbol,
                &error.to_string(),
                &context_summary,
                latest_mid_price,
                execution,
                decision_log,
                health,
            )
            .await;
            return;
        }
    };

    let current_direction = current_position.map(|p| p.direction);

    let action = decide_action(current_direction, decision.direction);

    let execution_result = apply_action(
        execution,
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
                })
                .await;
        }
        Err(error) => {
            tracing::error!(symbol, %error, "failed to apply position action");
            let count = health.record_failure(symbol, &error).await;
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: &context_summary,
                    decision: Some(&decision),
                    position_action: Some(action),
                    error: Some(&error),
                    auto_flatten: false,
                })
                .await;
            if count >= AUTO_FLATTEN_THRESHOLD {
                auto_flatten(symbol, latest_mid_price, execution, decision_log).await;
            }
        }
    }
}

/// Common handling for a `DecisionMaker`/`ExecutionAdapter` failure that happens
/// before a decision is even reached: logs the normal failure entry,
/// increments the PERP's consecutive-failure count, and — once that
/// count hits the auto-flatten threshold — force-flattens the position
/// and logs that distinctly from a normal decision-driven change.
async fn handle_cycle_failure(
    symbol: &str,
    reason: &str,
    context_summary: &str,
    mid_price: f64,
    execution: &dyn ExecutionAdapter,
    decision_log: &dyn DecisionLogWriter,
    health: &dyn FailureTracker,
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
        })
        .await;

    if count >= AUTO_FLATTEN_THRESHOLD {
        auto_flatten(symbol, mid_price, execution, decision_log).await;
    }
}

async fn auto_flatten(
    symbol: &str,
    mid_price: f64,
    execution: &dyn ExecutionAdapter,
    decision_log: &dyn DecisionLogWriter,
) {
    tracing::warn!(
        symbol,
        "5 consecutive failures reached; force-flattening position"
    );

    let result = execution.close(symbol, mid_price).await;
    if let Err(error) = &result {
        tracing::error!(symbol, %error, "auto-flatten failed to close position");
    }

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary: "auto-flatten: 5 consecutive failures",
            decision: None,
            position_action: Some(super::model::PositionAction::Close),
            error: result.err().map(|e| e.to_string()).as_deref(),
            auto_flatten: true,
        })
        .await;
}

async fn apply_action(
    execution: &dyn ExecutionAdapter,
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
            .open(symbol, direction, position_size_usd, leverage, mid_price)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        PositionAction::Close => execution
            .close(symbol, mid_price)
            .await
            .map_err(|e| e.to_string()),
        PositionAction::CloseThenOpen(direction) => {
            execution
                .close(symbol, mid_price)
                .await
                .map_err(|e| e.to_string())?;
            execution
                .open(symbol, direction, position_size_usd, leverage, mid_price)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_task(
    symbol: String,
    frequency_seconds: f64,
    store: ConfigStore,
    history: Arc<dyn MarketDataHistoryReader>,
    decision_makers: Arc<DecisionMakerRegistry>,
    execution: Arc<dyn ExecutionAdapter>,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    health: Arc<dyn FailureTracker>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs_f64(frequency_seconds.max(0.001));
        let start = Instant::now() + delay_until_next_boundary(frequency_seconds);
        let mut ticker = interval_at(start, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if let Some(config) = store.get(&symbol) {
                let decision_maker = decision_makers.get(config.decision_maker);
                run_decision_cycle(
                    &symbol,
                    &config,
                    history.as_ref(),
                    decision_maker.as_ref(),
                    execution.as_ref(),
                    funding.as_ref(),
                    decision_log.as_ref(),
                    health.as_ref(),
                )
                .await;
            }
        }
    })
}

/// Runs forever, polling the config store on `poll_interval` and
/// starting/stopping/restarting one decision task per trading-enabled
/// PERP so the running tasks always match `trading_enabled` +
/// `decision_frequency_seconds` from config — without ever restarting
/// the engine itself.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    store: ConfigStore,
    history: Arc<dyn MarketDataHistoryReader>,
    decision_makers: Arc<DecisionMakerRegistry>,
    execution: Arc<dyn ExecutionAdapter>,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    health: Arc<dyn FailureTracker>,
    poll_interval: Duration,
) -> ! {
    let mut running: HashMap<String, (f64, JoinHandle<()>)> = HashMap::new();

    loop {
        let configs = store.snapshot();
        let desired = desired_state(&configs);
        let running_frequencies: HashMap<String, f64> =
            running.iter().map(|(k, (f, _))| (k.clone(), *f)).collect();
        let actions = reconcile(&running_frequencies, &desired);

        for symbol in actions.to_stop {
            if let Some((_, handle)) = running.remove(&symbol) {
                handle.abort();
                tracing::info!(symbol = %symbol, "stopped decision loop");
            }
        }

        for (symbol, frequency) in actions.to_start {
            if let Some((_, handle)) = running.remove(&symbol) {
                handle.abort();
            }
            tracing::info!(symbol = %symbol, frequency_seconds = frequency, "starting decision loop");
            let handle = spawn_task(
                symbol.clone(),
                frequency,
                store.clone(),
                history.clone(),
                decision_makers.clone(),
                execution.clone(),
                funding.clone(),
                decision_log.clone(),
                health.clone(),
            );
            running.insert(symbol, (frequency, handle));
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
    use super::super::history::HistoryError;
    use super::super::log::LogError;
    use super::super::model::{Direction, JevDecision, Probabilities, TargetDirection};
    use super::*;
    use crate::funding::{FundingHistoryError, FundingRecord};
    use crate::market_data::MarketDataSample;

    fn sample_config(symbol: &str, trading_enabled: bool, frequency: f64) -> PerpConfig {
        PerpConfig {
            symbol: symbol.to_string(),
            trading_enabled,
            sampling_enabled: trading_enabled,
            decision_frequency_seconds: frequency,
            sampling_frequency_seconds: 60.0,
            leverage: 1.0,
            position_size_usd: 100.0,
            decision_maker: crate::decision::DecisionMakerKind::Fake,
        }
    }

    #[test]
    fn desired_state_excludes_trading_disabled_perps() {
        let configs = HashMap::from([
            ("BTC".to_string(), sample_config("BTC", true, 30.0)),
            ("ETH".to_string(), sample_config("ETH", false, 15.0)),
        ]);

        let desired = desired_state(&configs);
        assert_eq!(desired.get("BTC"), Some(&30.0));
        assert_eq!(desired.get("ETH"), None);
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
            Err(DecisionError("decision maker unavailable".to_string()))
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
                })
            } else {
                Err(DecisionError("decision maker unavailable".to_string()))
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
            _symbol: &str,
        ) -> Result<Option<OpenPosition>, ExecutionError> {
            Ok(*self.position.lock().unwrap())
        }

        async fn open(
            &self,
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

        async fn close(&self, _symbol: &str, _mid_price: f64) -> Result<(), ExecutionError> {
            self.close_calls.fetch_add(1, Ordering::SeqCst);
            *self.position.lock().unwrap() = None;
            Ok(())
        }

        async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
            Ok(self
                .position
                .lock()
                .unwrap()
                .map(|p| ("BTC".to_string(), p))
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
    }

    #[tokio::test]
    async fn a_failed_jev_call_skips_the_cycle_and_increments_the_failure_counter() {
        let config = sample_config("BTC", true, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();

        run_decision_cycle(
            "BTC",
            &config,
            &FakeHistory,
            &AlwaysFailingDecisionMaker,
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
        )
        .await;

        assert_eq!(health.count("BTC"), 1);
        // Position State is unchanged by a failed cycle.
        assert!(execution.get_position("BTC").await.unwrap().is_some());
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_successful_cycle_resets_the_failure_counter_to_zero() {
        let config = sample_config("BTC", true, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        health.record_failure("BTC", "previous failure").await;
        health.record_failure("BTC", "previous failure").await;

        let decision_maker = SucceedsOnceDecisionMaker {
            succeed_on: 1,
            calls: AtomicUsize::new(0),
        };

        run_decision_cycle(
            "BTC",
            &config,
            &FakeHistory,
            &decision_maker,
            &execution,
            &FakeFunding,
            &NoopDecisionLog,
            &health,
        )
        .await;

        assert_eq!(health.count("BTC"), 0);
    }

    #[tokio::test]
    async fn five_consecutive_failures_auto_flattens_the_position() {
        let config = sample_config("BTC", true, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let decision_log = CapturingDecisionLog::default();

        for _ in 0..5 {
            run_decision_cycle(
                "BTC",
                &config,
                &FakeHistory,
                &AlwaysFailingDecisionMaker,
                &execution,
                &FakeFunding,
                &decision_log,
                &health,
            )
            .await;
        }

        assert_eq!(health.count("BTC"), 5);
        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution.get_position("BTC").await.unwrap().is_none());
        assert_eq!(decision_log.auto_flatten_count(), 1);
    }

    #[tokio::test]
    async fn a_success_at_the_fourth_failure_prevents_the_auto_flatten() {
        let config = sample_config("BTC", true, 30.0);
        let execution = FakeExecution::with_open_position();
        let health = InMemoryFailureTracker::new();
        let decision_log = CapturingDecisionLog::default();

        let decision_maker = SucceedsOnceDecisionMaker {
            succeed_on: 4,
            calls: AtomicUsize::new(0),
        };

        for _ in 0..5 {
            run_decision_cycle(
                "BTC",
                &config,
                &FakeHistory,
                &decision_maker,
                &execution,
                &FakeFunding,
                &decision_log,
                &health,
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
}
