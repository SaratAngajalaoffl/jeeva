use chrono::{DateTime, Utc};

use crate::decision::{DecisionMakerKind, HistoryFormat};

/// Mirrors `backtest_runs` in Postgres (see
/// api/migrations/1789848056800_create-backtests.ts). Unlike a live
/// trading session, a backtest run has no `soft_closing`/`hard_closing`
/// state — it runs to `end_time` and is force-flattened there.
#[derive(Debug, Clone, PartialEq)]
pub struct BacktestRun {
    pub id: String,
    pub symbol: String,
    pub decision_maker: DecisionMakerKind,
    pub decision_frequency_seconds: f64,
    pub leverage: f64,
    pub position_size_usd: f64,
    pub history_window_samples: u32,
    pub history_format: HistoryFormat,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub store_decision_payloads: bool,
}
