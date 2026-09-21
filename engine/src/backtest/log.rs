use std::sync::Arc;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::decision::{DecisionLogEntry, DecisionLogWriter, LogError, PositionAction};

use super::clock::SimClock;

fn action_label(action: PositionAction) -> &'static str {
    match action {
        PositionAction::NoOp => "no_op",
        PositionAction::Open(_) => "opened",
        PositionAction::Close => "closed",
        PositionAction::CloseThenOpen(_) => "closed_and_opened",
    }
}

/// Writes decision-cycle outcomes to `backtest_decisions`, stamped with
/// the replay's simulated time rather than wall-clock `now()`, so the
/// backtest's decision log reflects when each cycle was replayed to
/// happen, not when the replay loop itself executed.
pub struct BacktestDecisionLogWriter {
    pool: PgPool,
    backtest_run_id: String,
    clock: Arc<SimClock>,
}

impl BacktestDecisionLogWriter {
    pub fn new(pool: PgPool, backtest_run_id: String, clock: Arc<SimClock>) -> Self {
        Self {
            pool,
            backtest_run_id,
            clock,
        }
    }
}

#[async_trait]
impl DecisionLogWriter for BacktestDecisionLogWriter {
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
            INSERT INTO backtest_decisions (
                backtest_run_id, sim_time, symbol, context_summary, target_direction, confidence,
                prob_long, prob_short, prob_flat, position_action, success, error, auto_flatten,
                raw_request, raw_response
            )
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb)
            "#,
        )
        .bind(&self.backtest_run_id)
        .bind(self.clock.get())
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
        .map_err(|e| LogError(format!("failed to write backtest decision log entry: {e}")))?;

        Ok(())
    }
}
