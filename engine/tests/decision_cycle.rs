use std::sync::Mutex;

use async_trait::async_trait;
use engine::decision::{
    run_decision_cycle, DecisionLogEntry, DecisionLogWriter, Direction, ExecutionAdapter,
    ExecutionError, HistoryError, InMemoryFailureTracker, MarketDataHistoryReader, OpenPosition,
    RandomDecisionMaker, SessionLifecycle, TargetDirection, DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
};
use engine::funding::{FundingHistoryError, FundingHistoryReader, FundingRecord};
use engine::market_data::MarketDataSample;
use engine::session::{TradingSessionConfig, TradingSessionStatus};

struct EmptyFunding;

#[async_trait]
impl FundingHistoryReader for EmptyFunding {
    async fn latest(&self, _symbol: &str) -> Result<Option<FundingRecord>, FundingHistoryError> {
        Ok(None)
    }
}

struct FakeHistory {
    samples: Vec<MarketDataSample>,
    /// Every `limit` the cycle asked for, so tests can assert the
    /// session's configured window actually reaches the reader.
    requested_limits: Mutex<Vec<u32>>,
}

impl FakeHistory {
    fn new(samples: Vec<MarketDataSample>) -> Self {
        Self {
            samples,
            requested_limits: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl MarketDataHistoryReader for FakeHistory {
    async fn recent_samples(
        &self,
        _symbol: &str,
        limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError> {
        self.requested_limits.lock().unwrap().push(limit);
        Ok(self.samples.clone())
    }
}

struct EmptyHistory;

#[async_trait]
impl MarketDataHistoryReader for EmptyHistory {
    async fn recent_samples(
        &self,
        _symbol: &str,
        _limit: u32,
    ) -> Result<Vec<MarketDataSample>, HistoryError> {
        Ok(vec![])
    }
}

#[derive(Default)]
struct FakeExecution {
    position: Mutex<Option<OpenPosition>>,
    open_calls: Mutex<Vec<(String, Direction, f64, f64)>>,
    close_calls: Mutex<Vec<String>>,
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
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        self.open_calls.lock().unwrap().push((
            symbol.to_string(),
            direction,
            position_size_usd,
            leverage,
        ));
        let position = OpenPosition {
            direction,
            entry_price: mid_price,
            notional_usd: position_size_usd * leverage,
            opened_at: chrono::Utc::now(),
        };
        *self.position.lock().unwrap() = Some(position);
        Ok(position)
    }

    async fn close(
        &self,
        _session_id: &str,
        symbol: &str,
        _mid_price: f64,
    ) -> Result<(), ExecutionError> {
        self.close_calls.lock().unwrap().push(symbol.to_string());
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

    async fn apply_funding(&self, _symbol: &str, _amount_usd: f64) -> Result<(), ExecutionError> {
        Ok(())
    }
}

struct LoggedEntry {
    success: bool,
    direction: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
struct FakeDecisionLog {
    entries: Mutex<Vec<LoggedEntry>>,
}

#[async_trait]
impl DecisionLogWriter for FakeDecisionLog {
    async fn write(&self, entry: DecisionLogEntry<'_>) -> Result<(), engine::decision::LogError> {
        self.entries.lock().unwrap().push(LoggedEntry {
            success: entry.error.is_none(),
            direction: entry.decision.map(|d| d.direction.as_str().to_string()),
            error: entry.error.map(|e| e.to_string()),
        });
        Ok(())
    }
}

fn sample(price: f64) -> MarketDataSample {
    MarketDataSample {
        symbol: "BTC".to_string(),
        price,
        open_interest: 10.0,
        volume: 1000.0,
        spread: 0.5,
        mid_price: price,
    }
}

#[derive(Default)]
struct CapturingDecisionMaker {
    states: Mutex<Vec<String>>,
}

#[async_trait]
impl engine::decision::DecisionMaker for CapturingDecisionMaker {
    async fn decide(
        &self,
        _symbol: &str,
        state: &str,
    ) -> Result<engine::decision::JevDecision, engine::decision::DecisionError> {
        self.states.lock().unwrap().push(state.to_string());
        Ok(engine::decision::JevDecision {
            direction: TargetDirection::Flat,
            confidence: 1.0,
            probabilities: engine::decision::Probabilities {
                long: 0.1,
                short: 0.1,
                flat: 0.8,
            },
        })
    }
}

fn config() -> TradingSessionConfig {
    TradingSessionConfig {
        id: "session-1".to_string(),
        symbol: "BTC".to_string(),
        decision_maker: Default::default(),
        decision_frequency_seconds: 60.0,
        leverage: 2.0,
        position_size_usd: 500.0,
        history_window_samples: 250,
        history_format: engine::decision::HistoryFormat::Summary,
        wallet_id: None,
        status: TradingSessionStatus::Active,
    }
}

struct NoopLifecycle;

#[async_trait]
impl SessionLifecycle for NoopLifecycle {
    async fn mark_closed(&self, _session_id: &str) {}
}

#[tokio::test]
async fn opens_a_position_from_flat_when_jev_says_long() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Long]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    let opens = execution.open_calls.lock().unwrap();
    assert_eq!(opens.len(), 1);
    assert_eq!(opens[0], ("BTC".to_string(), Direction::Long, 500.0, 2.0));
    assert!(execution.close_calls.lock().unwrap().is_empty());

    let entries = log.entries.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].success);
    assert_eq!(entries[0].direction, Some("long".to_string()));
}

#[tokio::test]
async fn repeating_the_same_direction_is_a_no_op() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Long]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;
    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    // Only the first cycle actually opened; the second was a no-op.
    assert_eq!(execution.open_calls.lock().unwrap().len(), 1);
    assert!(execution.close_calls.lock().unwrap().is_empty());
    assert_eq!(log.entries.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn flipping_direction_closes_then_opens() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker =
        RandomDecisionMaker::with_sequence(vec![TargetDirection::Long, TargetDirection::Short]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;
    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert_eq!(execution.close_calls.lock().unwrap().len(), 1);
    let opens = execution.open_calls.lock().unwrap();
    assert_eq!(opens.len(), 2);
    assert_eq!(opens[1].1, Direction::Short);
}

#[tokio::test]
async fn going_flat_closes_the_position() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker =
        RandomDecisionMaker::with_sequence(vec![TargetDirection::Long, TargetDirection::Flat]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;
    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert_eq!(execution.close_calls.lock().unwrap().len(), 1);
    assert_eq!(execution.open_calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn staying_flat_while_already_flat_is_a_no_op() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Flat]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert!(execution.open_calls.lock().unwrap().is_empty());
    assert!(execution.close_calls.lock().unwrap().is_empty());
    let entries = log.entries.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0].success);
}

#[tokio::test]
async fn writes_a_decision_log_entry_even_with_no_market_data() {
    let history = EmptyHistory;
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Long]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert!(execution.open_calls.lock().unwrap().is_empty());
    let entries = log.entries.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].success);
    assert!(entries[0]
        .error
        .as_deref()
        .unwrap()
        .contains("no market data"));
}

#[tokio::test]
async fn every_cycle_writes_exactly_one_log_entry_across_a_full_state_machine_walk() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    // flat -> long -> short -> flat -> flat (repeat, no-op)
    let decision_maker = RandomDecisionMaker::with_sequence(vec![
        TargetDirection::Flat,
        TargetDirection::Long,
        TargetDirection::Short,
        TargetDirection::Flat,
        TargetDirection::Flat,
    ]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    for _ in 0..5 {
        run_decision_cycle(
            "session-1",
            "BTC",
            &config(),
            DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
            &history,
            &decision_maker,
            &execution,
            &EmptyFunding,
            &log,
            &InMemoryFailureTracker::new(),
            &NoopLifecycle,
        )
        .await;
    }

    assert_eq!(log.entries.lock().unwrap().len(), 5);
    assert_eq!(execution.open_calls.lock().unwrap().len(), 2); // long, then short
    assert_eq!(execution.close_calls.lock().unwrap().len(), 2); // long->short, short->flat
}

#[tokio::test]
async fn reads_the_sessions_configured_history_window() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Flat]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    let config = TradingSessionConfig {
        history_window_samples: 42,
        ..config()
    };

    run_decision_cycle(
        "session-1",
        "BTC",
        &config,
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert_eq!(*history.requested_limits.lock().unwrap(), vec![42]);
}

#[tokio::test]
async fn clamps_an_out_of_range_history_window_before_reading() {
    let history = FakeHistory::new(vec![sample(100.0)]);
    let decision_maker = RandomDecisionMaker::with_sequence(vec![TargetDirection::Flat]);
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    let config = TradingSessionConfig {
        history_window_samples: 0,
        ..config()
    };

    run_decision_cycle(
        "session-1",
        "BTC",
        &config,
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    assert_eq!(*history.requested_limits.lock().unwrap(), vec![1]);
}

#[tokio::test]
async fn raw_history_format_sends_every_sample_to_the_decision_maker() {
    let history = FakeHistory::new(vec![sample(90.0), sample(100.0), sample(110.0)]);
    let decision_maker = CapturingDecisionMaker::default();
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    let config = TradingSessionConfig {
        history_format: engine::decision::HistoryFormat::Raw,
        ..config()
    };

    run_decision_cycle(
        "session-1",
        "BTC",
        &config,
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    let states = decision_maker.states.lock().unwrap();
    assert_eq!(states.len(), 1);
    assert!(states[0].contains("price_history=raw (oldest first, 3 samples"));
    assert!(states[0].contains("price=90.00"));
    assert!(states[0].contains("price=100.00"));
    assert!(states[0].contains("price=110.00"));
}

#[tokio::test]
async fn summary_history_format_sends_the_averaged_rendering() {
    let history = FakeHistory::new(vec![sample(90.0), sample(110.0)]);
    let decision_maker = CapturingDecisionMaker::default();
    let execution = FakeExecution::default();
    let log = FakeDecisionLog::default();

    run_decision_cycle(
        "session-1",
        "BTC",
        &config(),
        DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
        &history,
        &decision_maker,
        &execution,
        &EmptyFunding,
        &log,
        &InMemoryFailureTracker::new(),
        &NoopLifecycle,
    )
    .await;

    let states = decision_maker.states.lock().unwrap();
    assert_eq!(states.len(), 1);
    assert!(states[0].contains("avg=100.00"));
    assert!(!states[0].contains("price_history=raw"));
}
