use std::fmt;

use async_trait::async_trait;
use sqlx::PgPool;

use super::model::{JevDecision, PositionAction};

#[derive(Debug)]
pub struct LogError(pub String);

impl fmt::Display for LogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for LogError {}

fn action_label(action: PositionAction) -> &'static str {
    match action {
        PositionAction::NoOp => "no_op",
        PositionAction::Open(_) => "opened",
        PositionAction::Close => "closed",
        PositionAction::CloseThenOpen(_) => "closed_and_opened",
    }
}

/// One decision-cycle outcome to record, regardless of whether it
/// resulted in a position change.
pub struct DecisionLogEntry<'a> {
    pub symbol: &'a str,
    /// The live trading session that produced this row. Backtest writers
    /// ignore it because their rows are keyed by `backtest_run_id`.
    pub session_id: Option<&'a str>,
    pub context_summary: &'a str,
    pub decision: Option<&'a JevDecision>,
    pub position_action: Option<PositionAction>,
    pub error: Option<&'a str>,
    /// True only for the forced-flatten row written when a PERP hits 5
    /// consecutive failures — kept distinct from a normal Jev-driven
    /// position change.
    pub auto_flatten: bool,
    /// The exact request/response JSON exchanged with Jev for this
    /// cycle, when the session has `store_decision_payloads` enabled —
    /// `None` otherwise, and always `None` for cycles that never
    /// reached a network decision maker (e.g. missing market data).
    pub raw_request: Option<&'a str>,
    pub raw_response: Option<&'a str>,
}

/// Persists one row per decision cycle — including cycles that
/// couldn't produce a decision (e.g. no market data yet) — so the
/// dashboard's decision history is a complete audit trail, not just
/// the successful cycles.
#[async_trait]
pub trait DecisionLogWriter: Send + Sync {
    async fn write(&self, entry: DecisionLogEntry<'_>) -> Result<(), LogError>;
}

pub struct PostgresDecisionLogWriter {
    pool: PgPool,
}

impl PostgresDecisionLogWriter {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl DecisionLogWriter for PostgresDecisionLogWriter {
    async fn write(&self, entry: DecisionLogEntry<'_>) -> Result<(), LogError> {
        let success = entry.error.is_none();
        let target_direction = entry.decision.map(|d| d.direction.as_str());
        let confidence = entry.decision.map(|d| d.confidence);
        let prob_long = entry.decision.map(|d| d.probabilities.long);
        let prob_short = entry.decision.map(|d| d.probabilities.short);
        let prob_flat = entry.decision.map(|d| d.probabilities.flat);
        let position_action = entry.position_action.map(action_label);

        sqlx::query(
            r#"
            INSERT INTO decisions (
                time, session_id, symbol, context_summary, target_direction, confidence,
                prob_long, prob_short, prob_flat, position_action, success, error, auto_flatten,
                raw_request, raw_response
            )
            VALUES (now(), $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
            "#,
        )
        .bind(entry.session_id)
        .bind(entry.symbol)
        .bind(entry.context_summary)
        .bind(target_direction)
        .bind(confidence)
        .bind(prob_long)
        .bind(prob_short)
        .bind(prob_flat)
        .bind(position_action)
        .bind(success)
        .bind(entry.error)
        .bind(entry.auto_flatten)
        .bind(entry.raw_request)
        .bind(entry.raw_response)
        .execute(&self.pool)
        .await
        .map_err(|e| LogError(format!("failed to write decision log entry: {e}")))?;

        Ok(())
    }
}
