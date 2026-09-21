mod decision_maker;
mod decision_maker_registry;
mod execution;
mod health;
mod history;
mod hyperliquid_signing;
mod live_execution;
mod log;
mod model;
mod openrouter_jev_decision_maker;
mod supervisor;
mod typesafe_jev_decision_maker;

pub use decision_maker::{
    DecisionError, DecisionMaker, DecisionMakerKind, RandomDecisionMaker, UnconfiguredDecisionMaker,
};
pub use decision_maker_registry::DecisionMakerRegistry;
pub use execution::{
    fill_price, realized_pnl_usd, ExecutionAdapter, ExecutionError, MockExecutionAdapter,
    OpenPosition,
};
pub use health::{FailureTracker, InMemoryFailureTracker, PerpHealthTracker};
pub use history::{
    build_context_summary, HistoryError, MarketDataHistoryReader, PostgresMarketDataHistoryReader,
};
pub use hyperliquid_signing::{KeyError, PrivateKey};
pub use live_execution::LiveExecutionAdapter;
pub use log::{DecisionLogEntry, DecisionLogWriter, LogError, PostgresDecisionLogWriter};
pub use model::{
    decide_action, Direction, JevDecision, PositionAction, Probabilities, TargetDirection,
};
pub use openrouter_jev_decision_maker::OpenRouterJevDecisionMaker;
pub use supervisor::{
    desired_state, min_confidence_to_shift_from_env, parse_min_confidence_to_shift, run,
    run_decision_cycle, PostgresSessionLifecycle, SessionLifecycle,
    DEFAULT_MIN_CONFIDENCE_TO_SHIFT,
};
pub use typesafe_jev_decision_maker::TypeSafeJevDecisionMaker;
