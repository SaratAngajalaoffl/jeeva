use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use sqlx::PgPool;

/// Tracks each PERP's consecutive decision-cycle failure count so the
/// decision loop knows when to auto-flatten (5 in a row) and so the
/// dashboard can show a health indicator before that threshold is hit.
#[async_trait]
pub trait FailureTracker: Send + Sync {
    /// Records a failed cycle for `symbol` and returns the new
    /// consecutive-failure count.
    async fn record_failure(&self, symbol: &str, reason: &str) -> u32;

    /// Records a successful cycle for `symbol`, resetting its
    /// consecutive-failure count to 0.
    async fn record_success(&self, symbol: &str);
}

/// An in-memory-only `FailureTracker`, for tests that don't need a
/// database.
#[derive(Default)]
pub struct InMemoryFailureTracker {
    counts: Mutex<HashMap<String, u32>>,
}

impl InMemoryFailureTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn count(&self, symbol: &str) -> u32 {
        *self.counts.lock().unwrap().get(symbol).unwrap_or(&0)
    }
}

#[async_trait]
impl FailureTracker for InMemoryFailureTracker {
    async fn record_failure(&self, symbol: &str, _reason: &str) -> u32 {
        let mut counts = self.counts.lock().unwrap();
        let count = counts.entry(symbol.to_string()).or_insert(0);
        *count += 1;
        *count
    }

    async fn record_success(&self, symbol: &str) {
        self.counts.lock().unwrap().insert(symbol.to_string(), 0);
    }
}

/// A `FailureTracker` backed by an in-memory count (the source of
/// truth the decision loop consults synchronously) that write-throughs
/// to a `perp_health` table on every change, so Express can read it
/// for the dashboard without ever calling the engine directly.
pub struct PerpHealthTracker {
    pool: PgPool,
    counts: Mutex<HashMap<String, u32>>,
}

impl PerpHealthTracker {
    pub fn new(pool: PgPool) -> Self {
        Self {
            pool,
            counts: Mutex::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl FailureTracker for PerpHealthTracker {
    async fn record_failure(&self, symbol: &str, reason: &str) -> u32 {
        let count = {
            let mut counts = self.counts.lock().unwrap();
            let count = counts.entry(symbol.to_string()).or_insert(0);
            *count += 1;
            *count
        };

        let result = sqlx::query(
            r#"
            INSERT INTO perp_health (symbol, consecutive_failures, last_failure_reason, last_failure_at, updated_at)
            VALUES ($1, $2, $3, now(), now())
            ON CONFLICT (symbol) DO UPDATE SET
                consecutive_failures = EXCLUDED.consecutive_failures,
                last_failure_reason = EXCLUDED.last_failure_reason,
                last_failure_at = EXCLUDED.last_failure_at,
                updated_at = EXCLUDED.updated_at
            "#,
        )
        .bind(symbol)
        .bind(count as i32)
        .bind(reason)
        .execute(&self.pool)
        .await;

        if let Err(error) = result {
            tracing::error!(symbol, %error, "failed to persist perp health failure");
        }

        count
    }

    async fn record_success(&self, symbol: &str) {
        self.counts.lock().unwrap().insert(symbol.to_string(), 0);

        let result = sqlx::query(
            r#"
            INSERT INTO perp_health (symbol, consecutive_failures, updated_at)
            VALUES ($1, 0, now())
            ON CONFLICT (symbol) DO UPDATE SET
                consecutive_failures = 0,
                updated_at = now()
            "#,
        )
        .bind(symbol)
        .execute(&self.pool)
        .await;

        if let Err(error) = result {
            tracing::error!(symbol, %error, "failed to persist perp health success");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn increments_on_each_failure_and_resets_on_success() {
        let tracker = InMemoryFailureTracker::new();

        assert_eq!(tracker.record_failure("BTC", "jev timeout").await, 1);
        assert_eq!(tracker.record_failure("BTC", "jev timeout").await, 2);

        tracker.record_success("BTC").await;
        assert_eq!(tracker.count("BTC"), 0);

        assert_eq!(tracker.record_failure("BTC", "jev timeout").await, 1);
    }

    #[tokio::test]
    async fn tracks_each_symbol_independently() {
        let tracker = InMemoryFailureTracker::new();

        tracker.record_failure("BTC", "error").await;
        tracker.record_failure("BTC", "error").await;
        tracker.record_failure("ETH", "error").await;

        assert_eq!(tracker.count("BTC"), 2);
        assert_eq!(tracker.count("ETH"), 1);
    }
}
