use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::decision::{
    DecisionLogEntry, DecisionLogWriter, DriftOutcome, ExecutionAdapter, MarketDataHistoryReader,
    PositionAction, ReconcileTarget, SessionLifecycle,
};
use crate::mode::ModeStore;
use crate::session::{TradingSessionConfig, TradingSessionStatus};
use crate::wallets::WalletRegistry;

/// Builds this tick's `ReconcileTarget`s for every wallet that has at
/// least one non-closed session attached, grouped by `wallet_id` — a
/// wallet with no attached session gets an empty slice (still worth
/// reconciling, since the exchange may report a position no session
/// remembers at all).
fn targets_by_wallet(
    sessions: &HashMap<String, TradingSessionConfig>,
) -> HashMap<String, Vec<ReconcileTarget>> {
    let mut targets: HashMap<String, Vec<ReconcileTarget>> = HashMap::new();
    for config in sessions.values() {
        let Some(wallet_id) = &config.wallet_id else {
            continue;
        };
        targets
            .entry(wallet_id.clone())
            .or_default()
            .push(ReconcileTarget {
                session_id: config.id.clone(),
                symbol: config.symbol.clone(),
                status: config.status,
            });
    }
    targets
}

/// Every session that's waiting on a hard-close, oldest concern first —
/// `run_decision_cycle`'s own `HardClosing` branch only notices these on
/// that session's next decision tick, which can be as slow as its
/// configured `decision_frequency_seconds`; the reconcile loop checks
/// every tick instead.
fn hard_closing_sessions(
    sessions: &HashMap<String, TradingSessionConfig>,
) -> Vec<&TradingSessionConfig> {
    sessions
        .values()
        .filter(|config| config.status == TradingSessionStatus::HardClosing)
        .collect()
}

async fn latest_mid_price(symbol: &str, history: &dyn MarketDataHistoryReader) -> Option<f64> {
    match history.recent_samples(symbol, 1).await {
        Ok(samples) => samples.last().map(|s| s.mid_price),
        Err(error) => {
            tracing::error!(symbol, %error, "reconcile: failed to read latest price for hard-close");
            None
        }
    }
}

/// The position's unrealized loss as a fraction of `entry_price` (0.1 =
/// 10% underwater), negative when the position is actually in profit.
/// Pure, so the stop-loss threshold comparison is directly testable
/// without a database or fake adapters.
fn unrealized_loss_fraction(direction: crate::decision::Direction, entry_price: f64, mid_price: f64) -> f64 {
    use crate::decision::Direction;

    match direction {
        Direction::Long => (entry_price - mid_price) / entry_price,
        Direction::Short => (mid_price - entry_price) / entry_price,
    }
}

/// Every session with both an open position and a configured stop-loss
/// whose unrealized loss has reached that threshold. `hard_closing`
/// sessions are skipped — `dispatch_hard_closes` already flattens them
/// unconditionally this same tick.
async fn breached_stop_losses(
    sessions: &HashMap<String, TradingSessionConfig>,
    wallets: &WalletRegistry,
    mode: &ModeStore,
    history: &dyn MarketDataHistoryReader,
) -> Vec<(String, String, f64, f64)> {
    let mut breached = Vec::new();

    for config in sessions.values() {
        if config.status == TradingSessionStatus::HardClosing {
            continue;
        }
        let Some(stop_loss_pct) = config.stop_loss_pct else {
            continue;
        };
        let Some(wallet_id) = &config.wallet_id else {
            continue;
        };
        let Some((kind, adapter)) = wallets.resolve(wallet_id) else {
            continue;
        };
        if !kind.matches_mode(mode.get()) {
            continue;
        }

        let position = match adapter.get_position(&config.id, &config.symbol).await {
            Ok(position) => position,
            Err(error) => {
                tracing::error!(session_id = %config.id, symbol = %config.symbol, %error, "reconcile: failed to read position for stop-loss check");
                continue;
            }
        };
        let Some(position) = position else { continue };

        let Some(mid_price) = latest_mid_price(&config.symbol, history).await else {
            continue;
        };

        let loss_fraction = unrealized_loss_fraction(position.direction, position.entry_price, mid_price);
        if loss_fraction >= stop_loss_pct {
            breached.push((config.id.clone(), config.symbol.clone(), loss_fraction, mid_price));
        }
    }

    breached
}

/// Force-closes every session in `breached` (see `breached_stop_losses`)
/// and logs the close distinctly from an ordinary decision-driven one.
/// Only the position is closed — the session itself keeps running, same
/// as an ordinary decision-driven `Close` — a stop-loss is not a request
/// to end the session.
/// Closes one session's position because its stop-loss tripped, and
/// logs the close distinctly from an ordinary decision-driven one. Only
/// the position is closed — the session itself keeps running, same as
/// an ordinary decision-driven `Close` — a stop-loss is not a request
/// to end the session. Takes the adapter directly (mirroring
/// `hard_close`) so it's testable against a fake without a
/// `WalletRegistry`/database.
async fn close_for_stop_loss(
    session_id: &str,
    symbol: &str,
    mid_price: f64,
    loss_fraction: f64,
    stop_loss_pct: f64,
    execution: &dyn ExecutionAdapter,
    decision_log: &dyn DecisionLogWriter,
) {
    let result = execution.close(session_id, symbol, mid_price).await;
    let error = result.as_ref().err().map(|e| e.to_string());

    tracing::warn!(
        session_id,
        symbol,
        loss_fraction,
        stop_loss_pct,
        "reconcile: stop-loss triggered"
    );

    let context_summary = format!(
        "reconcile: stop-loss triggered (unrealized loss {:.2}% >= threshold {:.2}%)",
        loss_fraction * 100.0,
        stop_loss_pct * 100.0
    );

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary: &context_summary,
            decision: None,
            position_action: Some(PositionAction::Close),
            error: error.as_deref(),
            auto_flatten: false,
            raw_request: None,
            raw_response: None,
        })
        .await;
}

async fn dispatch_stop_losses(
    breached: Vec<(String, String, f64, f64)>,
    sessions: &HashMap<String, TradingSessionConfig>,
    wallets: &WalletRegistry,
    decision_log: &dyn DecisionLogWriter,
) {
    for (session_id, symbol, loss_fraction, mid_price) in breached {
        let Some(config) = sessions.get(&session_id) else {
            continue;
        };
        let Some(stop_loss_pct) = config.stop_loss_pct else {
            continue;
        };
        let Some(wallet_id) = &config.wallet_id else {
            continue;
        };
        let Some((_, adapter)) = wallets.resolve(wallet_id) else {
            continue;
        };

        close_for_stop_loss(
            &session_id,
            &symbol,
            mid_price,
            loss_fraction,
            stop_loss_pct,
            adapter.as_ref(),
            decision_log,
        )
        .await;
    }
}

/// Force-flattens one hard-closing session and marks it closed, logging
/// the result distinctly from an ordinary decision-driven close — same
/// spirit as `run_decision_cycle`'s auto-flatten entry. A failure here
/// just leaves the session `hard_closing`; the next reconcile tick (or
/// the decision loop's own fallback branch) retries it.
async fn hard_close(
    session_id: &str,
    symbol: &str,
    execution: &dyn ExecutionAdapter,
    history: &dyn MarketDataHistoryReader,
    decision_log: &dyn DecisionLogWriter,
    lifecycle: &dyn SessionLifecycle,
) {
    let Some(mid_price) = latest_mid_price(symbol, history).await else {
        return;
    };

    let result = execution.close(session_id, symbol, mid_price).await;
    let error = result.as_ref().err().map(|e| e.to_string());

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary: "reconcile: hard-close flattening immediately",
            decision: None,
            position_action: Some(PositionAction::Close),
            error: error.as_deref(),
            auto_flatten: false,
            raw_request: None,
            raw_response: None,
        })
        .await;

    match result {
        Ok(()) => {
            tracing::warn!(session_id, symbol, "reconcile: hard-close flattened position");
            lifecycle.mark_closed(session_id).await;
        }
        Err(error) => {
            tracing::error!(session_id, symbol, %error, "reconcile: hard-close failed to flatten position; will retry");
        }
    }
}

/// Force-flattens every currently hard-closing session found in
/// `sessions`, resolving each one's wallet fresh from `wallets` (and
/// skipping it if the wallet's kind disagrees with the engine's current
/// mode, the same safety net the decision loop enforces).
async fn dispatch_hard_closes(
    sessions: &HashMap<String, TradingSessionConfig>,
    wallets: &WalletRegistry,
    mode: &ModeStore,
    history: &dyn MarketDataHistoryReader,
    decision_log: &dyn DecisionLogWriter,
    lifecycle: &dyn SessionLifecycle,
) {
    for config in hard_closing_sessions(sessions) {
        let Some(wallet_id) = &config.wallet_id else {
            continue;
        };
        let Some((kind, adapter)) = wallets.resolve(wallet_id) else {
            continue;
        };
        if !kind.matches_mode(mode.get()) {
            continue;
        }

        hard_close(
            &config.id,
            &config.symbol,
            adapter.as_ref(),
            history,
            decision_log,
            lifecycle,
        )
        .await;
    }
}

/// Writes one decision-log entry per drift outcome, distinctly from
/// ordinary decision-cycle activity — an outcome is recorded whether or
/// not the adapter's policy action against it succeeded, so drift is
/// never silently dropped.
async fn log_drift_outcome(
    wallet_id: &str,
    outcome: &DriftOutcome,
    decision_log: &dyn DecisionLogWriter,
) {
    let context_summary = format!(
        "reconcile: drift detected on wallet {wallet_id} ({:?}); policy action: {:?}",
        outcome.event, outcome.action
    );

    tracing::warn!(
        wallet_id,
        symbol = outcome.event.symbol(),
        session_id = outcome.event.session_id(),
        action = ?outcome.action,
        error = outcome.error.as_deref(),
        "reconcile: drift observed"
    );

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol: outcome.event.symbol(),
            context_summary: &context_summary,
            decision: None,
            position_action: None,
            error: outcome.error.as_deref(),
            auto_flatten: false,
            raw_request: None,
            raw_response: None,
        })
        .await;
}

/// Runs one reconcile pass over every currently known wallet: force-
/// flattens any hard-closing session immediately, then for every wallet
/// calls its `ExecutionAdapter::reconcile` with the sessions it drives,
/// applying that adapter's own drift policy, and logs every outcome.
/// Skips a wallet whose kind disagrees with the engine's current mode —
/// the same safety net `run_decision_cycle` enforces before trading it.
#[allow(clippy::too_many_arguments)]
pub async fn run_reconcile_cycle(
    sessions: &crate::session::SessionStore,
    wallets: &WalletRegistry,
    mode: &ModeStore,
    history: &dyn MarketDataHistoryReader,
    decision_log: &dyn DecisionLogWriter,
    lifecycle: &dyn SessionLifecycle,
) {
    let all_sessions = sessions.snapshot();

    dispatch_hard_closes(&all_sessions, wallets, mode, history, decision_log, lifecycle).await;

    let breached = breached_stop_losses(&all_sessions, wallets, mode, history).await;
    dispatch_stop_losses(breached, &all_sessions, wallets, decision_log).await;

    let mut targets = targets_by_wallet(&all_sessions);

    for (wallet_id, kind, adapter) in wallets.snapshot() {
        if !kind.matches_mode(mode.get()) {
            continue;
        }

        let wallet_targets = targets.remove(&wallet_id).unwrap_or_default();

        match adapter.reconcile(&wallet_targets).await {
            Ok(outcomes) => {
                for outcome in &outcomes {
                    log_drift_outcome(&wallet_id, outcome, decision_log).await;
                }
            }
            Err(error) => {
                tracing::error!(wallet_id = %wallet_id, %error, "reconcile cycle failed for wallet");
            }
        }
    }
}

/// Runs the reconcile loop forever on `poll_interval` — a single pass
/// over every wallet, not one task per session, so it also catches
/// positions no session's task is currently watching (e.g. after an
/// engine restart or a session that no longer exists). Runs
/// independently of, and much more frequently than, any session's own
/// `decision_frequency_seconds`, which is what lets it flatten a
/// hard-closing session immediately instead of waiting on that
/// session's next decision tick.
pub async fn run(
    sessions: crate::session::SessionStore,
    wallets: Arc<WalletRegistry>,
    mode: ModeStore,
    history: Arc<dyn MarketDataHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    lifecycle: Arc<dyn SessionLifecycle>,
    poll_interval: Duration,
) -> ! {
    loop {
        run_reconcile_cycle(
            &sessions,
            wallets.as_ref(),
            &mode,
            history.as_ref(),
            decision_log.as_ref(),
            lifecycle.as_ref(),
        )
        .await;
        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::{DecisionMakerKind, HistoryFormat};

    fn sample_config(
        id: &str,
        symbol: &str,
        wallet_id: Option<&str>,
        status: TradingSessionStatus,
    ) -> TradingSessionConfig {
        TradingSessionConfig {
            id: id.to_string(),
            symbol: symbol.to_string(),
            decision_maker: DecisionMakerKind::Random,
            decision_frequency_seconds: 30.0,
            leverage: 1.0,
            position_size_usd: 100.0,
            history_window_samples: 250,
            history_format: HistoryFormat::Summary,
            wallet_id: wallet_id.map(|s| s.to_string()),
            status,
            store_decision_payloads: false,
            stop_loss_pct: None,
        }
    }

    #[test]
    fn groups_sessions_by_wallet_and_skips_unassigned_ones() {
        let sessions = HashMap::from([
            (
                "s1".to_string(),
                sample_config("s1", "BTC", Some("wallet-a"), TradingSessionStatus::Active),
            ),
            (
                "s2".to_string(),
                sample_config("s2", "ETH", Some("wallet-a"), TradingSessionStatus::Active),
            ),
            (
                "s3".to_string(),
                sample_config("s3", "SOL", Some("wallet-b"), TradingSessionStatus::Active),
            ),
            (
                "s4".to_string(),
                sample_config("s4", "DOGE", None, TradingSessionStatus::Active),
            ),
        ]);

        let grouped = targets_by_wallet(&sessions);

        assert_eq!(grouped.get("wallet-a").map(|v| v.len()), Some(2));
        assert_eq!(grouped.get("wallet-b").map(|v| v.len()), Some(1));
        assert_eq!(grouped.len(), 2);
    }

    #[test]
    fn a_wallet_with_no_sessions_is_simply_absent_from_the_grouping() {
        let sessions = HashMap::new();
        let grouped = targets_by_wallet(&sessions);
        assert!(grouped.is_empty());
    }

    #[test]
    fn hard_closing_sessions_finds_only_that_status() {
        let sessions = HashMap::from([
            (
                "s1".to_string(),
                sample_config("s1", "BTC", Some("wallet-a"), TradingSessionStatus::Active),
            ),
            (
                "s2".to_string(),
                sample_config(
                    "s2",
                    "ETH",
                    Some("wallet-a"),
                    TradingSessionStatus::HardClosing,
                ),
            ),
            (
                "s3".to_string(),
                sample_config(
                    "s3",
                    "SOL",
                    Some("wallet-b"),
                    TradingSessionStatus::SoftClosing,
                ),
            ),
        ]);

        let found = hard_closing_sessions(&sessions);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "s2");
    }

    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use async_trait::async_trait;

    use crate::decision::{
        DriftOutcome, ExecutionError, HistoryError, LogError, OpenPosition, ReconcileTarget,
    };
    use crate::market_data::MarketDataSample;

    #[derive(Default)]
    struct FakeExecution {
        position: Mutex<Option<OpenPosition>>,
        close_calls: AtomicUsize,
    }

    impl FakeExecution {
        fn with_open_position() -> Self {
            Self {
                position: Mutex::new(Some(OpenPosition {
                    direction: crate::decision::Direction::Long,
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
            direction: crate::decision::Direction,
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

        async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
            Ok(Vec::new())
        }

        async fn apply_funding(&self, _symbol: &str, _amount_usd: f64) -> Result<(), ExecutionError> {
            Ok(())
        }

        async fn reconcile(
            &self,
            _sessions: &[ReconcileTarget],
        ) -> Result<Vec<DriftOutcome>, ExecutionError> {
            Ok(Vec::new())
        }
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

    #[tokio::test]
    async fn hard_close_flattens_and_marks_the_session_closed() {
        let execution = FakeExecution::with_open_position();
        let lifecycle = FakeLifecycle::default();

        hard_close(
            "session-1",
            "BTC",
            &execution,
            &FakeHistory,
            &NoopDecisionLog,
            &lifecycle,
        )
        .await;

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution
            .get_position("session-1", "BTC")
            .await
            .unwrap()
            .is_none());
        assert_eq!(lifecycle.closed.lock().unwrap().as_slice(), ["session-1"]);
    }

    /// `close()` is a no-op when there's no position left to close, and
    /// `mark_closed` is an idempotent UPDATE — so a hard-close observed
    /// by both the reconcile loop and the decision loop in the same
    /// window is safe: the second caller's `hard_close` just re-confirms
    /// an already-flat, already-closed session instead of double-acting.
    #[tokio::test]
    async fn hard_close_is_safe_to_call_twice_in_a_row() {
        let execution = FakeExecution::with_open_position();
        let lifecycle = FakeLifecycle::default();

        for _ in 0..2 {
            hard_close(
                "session-1",
                "BTC",
                &execution,
                &FakeHistory,
                &NoopDecisionLog,
                &lifecycle,
            )
            .await;
        }

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 2);
        assert!(execution
            .get_position("session-1", "BTC")
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            lifecycle.closed.lock().unwrap().as_slice(),
            ["session-1", "session-1"]
        );
    }

    #[test]
    fn unrealized_loss_fraction_is_positive_when_a_long_loses() {
        let loss = unrealized_loss_fraction(crate::decision::Direction::Long, 100.0, 90.0);
        assert!((loss - 0.1).abs() < 1e-9);
    }

    #[test]
    fn unrealized_loss_fraction_is_negative_when_a_long_gains() {
        let loss = unrealized_loss_fraction(crate::decision::Direction::Long, 100.0, 110.0);
        assert!((loss + 0.1).abs() < 1e-9);
    }

    #[test]
    fn unrealized_loss_fraction_is_positive_when_a_short_loses() {
        let loss = unrealized_loss_fraction(crate::decision::Direction::Short, 100.0, 110.0);
        assert!((loss - 0.1).abs() < 1e-9);
    }

    #[test]
    fn unrealized_loss_fraction_is_negative_when_a_short_gains() {
        let loss = unrealized_loss_fraction(crate::decision::Direction::Short, 100.0, 90.0);
        assert!((loss + 0.1).abs() < 1e-9);
    }

    #[tokio::test]
    async fn close_for_stop_loss_closes_the_position_and_logs_distinctly() {
        let execution = FakeExecution::with_open_position();
        let log = CapturingDecisionLog::default();

        close_for_stop_loss(
            "session-1",
            "BTC",
            90.0,
            0.1,
            0.05,
            &execution,
            &log,
        )
        .await;

        assert_eq!(execution.close_calls.load(Ordering::SeqCst), 1);
        assert!(execution
            .get_position("session-1", "BTC")
            .await
            .unwrap()
            .is_none());

        let entries = log.entries.lock().unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].contains("stop-loss triggered"));
    }

    #[derive(Default)]
    struct CapturingDecisionLog {
        entries: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl DecisionLogWriter for CapturingDecisionLog {
        async fn write(&self, entry: DecisionLogEntry<'_>) -> Result<(), LogError> {
            self.entries
                .lock()
                .unwrap()
                .push(entry.context_summary.to_string());
            Ok(())
        }
    }
}
