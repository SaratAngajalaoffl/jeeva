use crate::decision::{DecisionMakerKind, HistoryFormat};

/// Mirrors `trading_sessions.status` in Postgres (see
/// api/migrations/1789848053000_create-trading-sessions.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TradingSessionStatus {
    Active,
    /// Stop opening new positions; keep running the decision loop
    /// (flatten-only) until the position reports flat, then close.
    SoftClosing,
    /// Force-flatten the position on the next tick, then close.
    HardClosing,
    Closed,
}

impl TradingSessionStatus {
    pub fn from_db(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "soft_closing" => Some(Self::SoftClosing),
            "hard_closing" => Some(Self::HardClosing),
            "closed" => Some(Self::Closed),
            _ => None,
        }
    }
}

/// One trading session's config, as read from Postgres's
/// `trading_sessions` table. Multiple sessions can exist per symbol,
/// each with its own decision maker, frequency, sizing and (at most
/// one, exclusively-held) wallet.
#[derive(Debug, Clone, PartialEq)]
pub struct TradingSessionConfig {
    pub id: String,
    pub symbol: String,
    pub decision_maker: DecisionMakerKind,
    pub decision_frequency_seconds: f64,
    pub leverage: f64,
    pub position_size_usd: f64,
    /// How many recent market-data samples to read for this session's
    /// decision context, and in what form (see `HistoryFormat`).
    pub history_window_samples: u32,
    pub history_format: HistoryFormat,
    pub wallet_id: Option<String>,
    pub status: TradingSessionStatus,
    /// When enabled, every decision cycle's exact request/response
    /// exchange with Jev is persisted to the decision log (`decisions`/
    /// `backtest_decisions`), not just the parsed direction/confidence/
    /// probabilities. Off by default: raw payloads can be large and
    /// most sessions don't need them for debugging or auditing.
    pub store_decision_payloads: bool,
}
