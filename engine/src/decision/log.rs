use std::fmt;

use async_trait::async_trait;
use sqlx::PgPool;

use crate::pg::execute_idempotent;

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
    pub context_summary: &'a str,
    pub decision: Option<&'a JevDecision>,
    pub position_action: Option<PositionAction>,
    pub error: Option<&'a str>,
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

    pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
        execute_idempotent(
            pool,
            r#"
            CREATE TABLE IF NOT EXISTS decisions (
                time TIMESTAMPTZ NOT NULL DEFAULT now(),
                symbol TEXT NOT NULL,
                context_summary TEXT NOT NULL,
                target_direction TEXT,
                confidence DOUBLE PRECISION,
                prob_long DOUBLE PRECISION,
                prob_short DOUBLE PRECISION,
                prob_flat DOUBLE PRECISION,
                position_action TEXT,
                success BOOLEAN NOT NULL,
                error TEXT
            )
            "#,
        )
        .await?;

        execute_idempotent(
            pool,
            "SELECT create_hypertable('decisions', 'time', if_not_exists => TRUE)",
        )
        .await?;

        Ok(())
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
                time, symbol, context_summary, target_direction, confidence,
                prob_long, prob_short, prob_flat, position_action, success, error
            )
            VALUES (now(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            "#,
        )
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
        .execute(&self.pool)
        .await
        .map_err(|e| LogError(format!("failed to write decision log entry: {e}")))?;

        Ok(())
    }
}
