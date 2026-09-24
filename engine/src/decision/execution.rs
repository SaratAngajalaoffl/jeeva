use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;
use tokio::sync::Mutex as AsyncMutex;
use tokio::sync::OwnedMutexGuard;

use super::model::Direction;

#[derive(Debug)]
pub struct ExecutionError(pub String);

impl fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ExecutionError {}

/// Process-wide coordination for work that can change a PERP's
/// execution state. The decision and reconcile loops share one instance
/// so a stale decision cannot race a drift/safety remediation, even
/// while different wallet adapters are being refreshed.
#[derive(Debug, Default)]
pub struct ExecutionCoordinator {
    symbols: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl ExecutionCoordinator {
    fn guard(&self, symbol: &str) -> Arc<AsyncMutex<()>> {
        self.symbols
            .lock()
            .unwrap()
            .entry(symbol.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }

    /// Claims a PERP without waiting. Callers skip this pass when a
    /// decision cycle or reconciliation is already in flight for the
    /// symbol. A per-PERP nonblocking claim avoids serializing unrelated
    /// markets and keeps the reconcile loop from blocking behind a slow
    /// decision maker network call. Only live adapters opt in, so mock
    /// and backtest behavior remains fully sequential.
    pub fn try_lock(&self, symbol: &str) -> Option<OwnedMutexGuard<()>> {
        let guard = self.guard(symbol);
        guard.try_lock_owned().ok()
    }
}

/// Shared by the decision and reconciliation loops. Keeping it in one
/// process-level place means the safety contract also holds when the
/// wallet registry replaces adapter instances during a refresh.
pub fn execution_coordinator() -> &'static ExecutionCoordinator {
    static COORDINATOR: OnceLock<ExecutionCoordinator> = OnceLock::new();
    COORDINATOR.get_or_init(ExecutionCoordinator::default)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenPosition {
    pub direction: Direction,
    pub entry_price: f64,
    pub notional_usd: f64,
    pub opened_at: DateTime<Utc>,
}

/// One session the reconcile loop asks an `ExecutionAdapter` to check
/// on a given tick — every non-closed session currently attached to
/// that adapter's wallet (in practice at most one, since a wallet may
/// drive only one non-closed session at a time).
#[derive(Debug, Clone, PartialEq)]
pub struct ReconcileTarget {
    pub session_id: String,
    pub symbol: String,
    pub status: crate::session::TradingSessionStatus,
}

/// A deviation an `ExecutionAdapter::reconcile` call observed between
/// its virtual state and the real exchange.
#[derive(Debug, Clone, PartialEq)]
pub enum DriftEvent {
    /// Virtual state believes a session has an open position, but the
    /// exchange reports none.
    MissingOnExchange { session_id: String, symbol: String },
    /// The exchange reports an open position for a symbol no known
    /// session's virtual state accounts for.
    UnknownOnExchange { symbol: String },
    /// Both sides agree a position is open, but disagree on its
    /// direction or size — also used when the exchange has a position
    /// for a symbol a session tracks, but that session's own virtual
    /// state doesn't (`virtual_notional_usd: 0.0`).
    SizeMismatch {
        session_id: String,
        symbol: String,
        virtual_notional_usd: f64,
        exchange_notional_usd: f64,
    },
}

impl DriftEvent {
    pub fn symbol(&self) -> &str {
        match self {
            DriftEvent::MissingOnExchange { symbol, .. } => symbol,
            DriftEvent::UnknownOnExchange { symbol } => symbol,
            DriftEvent::SizeMismatch { symbol, .. } => symbol,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            DriftEvent::MissingOnExchange { session_id, .. } => Some(session_id),
            DriftEvent::UnknownOnExchange { .. } => None,
            DriftEvent::SizeMismatch { session_id, .. } => Some(session_id),
        }
    }
}

/// What an `ExecutionAdapter::reconcile` should do about a given
/// `DriftEvent`. Configurable per adapter instance (see
/// `LiveExecutionAdapter::with_drift_policy`), not a single engine-wide
/// setting, since different wallets can warrant different risk
/// tolerances.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriftAction {
    /// Accept the exchange's state as truth and update virtual state to
    /// match it, without placing any order.
    AdoptAndLog,
    /// Attempt to re-place whatever order is needed to bring the
    /// exchange in line with virtual state's own target.
    ReSubmit,
    /// Force the exchange position for this symbol to flat via the
    /// adapter's normal close path.
    Flatten,
    /// Take no automatic action beyond logging — the wallet/PERP is
    /// left for an operator to look at.
    Halt,
}

/// Per-drift-kind policy an `ExecutionAdapter::reconcile` applies.
/// Defaults are conservative, per the safety note on issue #31: never
/// silently re-submit against a live exchange. `missing_on_exchange`
/// defaults to `AdoptAndLog` rather than `Flatten` because the exchange
/// is already flat in that case — there's nothing to close, only
/// virtual state to correct.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DriftPolicy {
    pub missing_on_exchange: DriftAction,
    pub unknown_on_exchange: DriftAction,
    pub size_mismatch: DriftAction,
}

impl Default for DriftPolicy {
    fn default() -> Self {
        Self {
            missing_on_exchange: DriftAction::AdoptAndLog,
            unknown_on_exchange: DriftAction::Flatten,
            size_mismatch: DriftAction::Flatten,
        }
    }
}

impl DriftPolicy {
    pub fn action_for(&self, event: &DriftEvent) -> DriftAction {
        match event {
            DriftEvent::MissingOnExchange { .. } => self.missing_on_exchange,
            DriftEvent::UnknownOnExchange { .. } => self.unknown_on_exchange,
            DriftEvent::SizeMismatch { .. } => self.size_mismatch,
        }
    }
}

/// One drift event `reconcile` observed, the policy action taken in
/// response, and whether that action itself succeeded — the caller
/// (the reconcile loop) writes one of these to the decision log per
/// outcome, so drift is never silently dropped even when remediation
/// fails.
#[derive(Debug, Clone, PartialEq)]
pub struct DriftOutcome {
    pub event: DriftEvent,
    pub action: DriftAction,
    pub error: Option<String>,
}

/// Opens/closes a PERP's mock position against the shared mock wallet.
/// The real (only, for now) implementation simulates fills at
/// mid-price plus/minus slippage and realizes P&L into the wallet's
/// balance on close; a fake implementation lets the decision loop be
/// tested without a database.
#[async_trait]
pub trait ExecutionAdapter: Send + Sync {
    /// `session_id` disambiguates concurrent trading sessions on the
    /// same symbol (each session's position is tracked independently);
    /// `symbol` is still needed for logging and, on `LiveExecutionAdapter`,
    /// for the exchange calls themselves (Hyperliquid has no session
    /// concept — it nets to one position per wallet+symbol regardless).
    async fn get_position(
        &self,
        session_id: &str,
        symbol: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError>;

    async fn open(
        &self,
        session_id: &str,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError>;

    /// No-ops if there is no open position for the session.
    async fn close(
        &self,
        session_id: &str,
        symbol: &str,
        mid_price: f64,
    ) -> Result<(), ExecutionError>;

    /// Every currently open mock position, symbol-keyed. Used by the
    /// funding sweep, which applies to all open positions regardless of
    /// which PERP's decision loop opened them.
    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError>;

    /// Directly credits/debits the wallet by `amount_usd` (positive
    /// credits, negative debits) without touching any position — used
    /// for funding payments, which are distinct from decision-driven
    /// realized P&L on close.
    async fn apply_funding(&self, symbol: &str, amount_usd: f64) -> Result<(), ExecutionError>;

    /// Records when a decision cycle began. Live adapters use this to
    /// reject a decision whose network call exceeded the freshness
    /// window; mock/backtest adapters are authoritative and no-op.
    async fn mark_decision_started(&self, _symbol: &str) {}

    /// Whether this adapter participates in the process-wide per-PERP
    /// execution claim. Mock and backtest adapters are sequential and
    /// do not need process-global coordination.
    async fn needs_execution_coordination(&self) -> bool {
        false
    }

    /// Re-checks the market context after `DecisionMaker::decide`
    /// returns. Implementations may reject stale decisions; the
    /// default keeps the existing mock/backtest behavior.
    async fn decision_is_fresh(
        &self,
        _symbol: &str,
        _latest_mid_price: f64,
        _reference_mid_price: f64,
        _max_age: Duration,
    ) -> Result<bool, ExecutionError> {
        Ok(true)
    }

    /// Checks this adapter's virtual state against the real exchange for
    /// each of `sessions` (every non-closed session currently attached
    /// to this adapter's wallet), applies this adapter's configured
    /// `DriftPolicy` to whatever drift it finds, and reports what
    /// happened. Called by the reconcile loop (`crate::reconcile::run`)
    /// on a tighter interval than any session's decision frequency —
    /// independent of, and much more frequent than, `run_decision_cycle`.
    ///
    /// `MockExecutionAdapter`'s virtual state is authoritative by
    /// construction and can never drift from itself, so its
    /// implementation is a no-op.
    async fn reconcile(
        &self,
        sessions: &[ReconcileTarget],
    ) -> Result<Vec<DriftOutcome>, ExecutionError>;
}

/// Simulates a fill at `mid_price` adjusted by `slippage_bps` (basis
/// points) against the direction being traded — buying (opening long,
/// or buying back to close a short) fills slightly above mid; selling
/// (opening short, or selling to close a long) fills slightly below
/// mid. Pure and free of any DB dependency, so it's directly testable.
pub fn fill_price(mid_price: f64, direction: Direction, opening: bool, slippage_bps: f64) -> f64 {
    let bps = slippage_bps / 10_000.0;
    let is_buy = matches!(
        (direction, opening),
        (Direction::Long, true) | (Direction::Short, false)
    );
    if is_buy {
        mid_price * (1.0 + bps)
    } else {
        mid_price * (1.0 - bps)
    }
}

/// Realized P&L in USD for closing a position at `exit_price`, given
/// its `entry_price` and `notional_usd` exposure. Pure and testable
/// independent of the DB.
pub fn realized_pnl_usd(
    direction: Direction,
    entry_price: f64,
    exit_price: f64,
    notional_usd: f64,
) -> f64 {
    match direction {
        Direction::Long => (exit_price - entry_price) / entry_price * notional_usd,
        Direction::Short => (entry_price - exit_price) / entry_price * notional_usd,
    }
}

/// The notional we can actually trade given a requested position size
/// and the wallet's available USD balance: capped at the balance, and
/// rejected outright when there is nothing left to trade with.
pub fn clamp_position_size_usd(requested_size_usd: f64, available_usd: f64) -> Result<f64, String> {
    if available_usd <= f64::EPSILON {
        return Err(format!(
            "insufficient balance: have ${available_usd:.2}, need at least ${requested_size_usd:.2}"
        ));
    }
    Ok(requested_size_usd.min(available_usd))
}

pub struct MockExecutionAdapter {
    pool: PgPool,
    slippage_bps: f64,
    wallet_id: String,
}

impl MockExecutionAdapter {
    /// `wallet_id` identifies the row in the `wallets` table this
    /// adapter's fills are settled against — every instance is scoped to
    /// exactly one mock wallet.
    pub fn new(pool: PgPool, slippage_bps: f64, wallet_id: String) -> Self {
        Self {
            pool,
            slippage_bps,
            wallet_id,
        }
    }
}

#[async_trait]
impl ExecutionAdapter for MockExecutionAdapter {
    async fn get_position(
        &self,
        session_id: &str,
        _symbol: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError> {
        let row = sqlx::query_as::<_, (String, f64, f64, DateTime<Utc>)>(
            "SELECT direction, entry_price, notional_usd, opened_at FROM mock_positions WHERE session_id = $1::uuid",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read position: {e}")))?;

        Ok(row.map(
            |(direction, entry_price, notional_usd, opened_at)| OpenPosition {
                direction: if direction == "long" {
                    Direction::Long
                } else {
                    Direction::Short
                },
                entry_price,
                notional_usd,
                opened_at,
            },
        ))
    }

    async fn open(
        &self,
        session_id: &str,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        let (available_usd,) = sqlx::query_as::<_, (f64,)>(
            "SELECT current_balance_usd FROM wallets WHERE id = $1::uuid AND kind = 'mock'",
        )
        .bind(&self.wallet_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read wallet balance: {e}")))?;

        // A fixed session size may exceed what the wallet has left after
        // earlier losses; trade whatever is affordable instead.
        let position_size_usd =
            clamp_position_size_usd(position_size_usd, available_usd).map_err(ExecutionError)?;
        let notional_usd = position_size_usd * leverage;
        let entry_price = fill_price(mid_price, direction, true, self.slippage_bps);

        let (opened_at,) = sqlx::query_as::<_, (DateTime<Utc>,)>(
            r#"
            INSERT INTO mock_positions (session_id, symbol, direction, entry_price, notional_usd, wallet_id)
            VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)
            RETURNING opened_at
            "#,
        )
        .bind(session_id)
        .bind(symbol)
        .bind(direction.as_str())
        .bind(entry_price)
        .bind(notional_usd)
        .bind(&self.wallet_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to open position: {e}")))?;

        tracing::info!(
            symbol,
            session_id,
            direction = direction.as_str(),
            entry_price,
            notional_usd,
            "opened mock position"
        );

        Ok(OpenPosition {
            direction,
            entry_price,
            notional_usd,
            opened_at,
        })
    }

    async fn close(
        &self,
        session_id: &str,
        symbol: &str,
        mid_price: f64,
    ) -> Result<(), ExecutionError> {
        let Some(position) = self.get_position(session_id, symbol).await? else {
            return Ok(());
        };

        let exit_price = fill_price(mid_price, position.direction, false, self.slippage_bps);
        let pnl_usd = realized_pnl_usd(
            position.direction,
            position.entry_price,
            exit_price,
            position.notional_usd,
        );

        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ExecutionError(format!("failed to start transaction: {e}")))?;

        sqlx::query(
            "UPDATE wallets SET current_balance_usd = current_balance_usd + $1 WHERE id = $2::uuid AND kind = 'mock'",
        )
        .bind(pnl_usd)
        .bind(&self.wallet_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ExecutionError(format!("failed to update wallet balance: {e}")))?;

        sqlx::query("DELETE FROM mock_positions WHERE session_id = $1::uuid")
            .bind(session_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| ExecutionError(format!("failed to delete position: {e}")))?;

        sqlx::query(
            r#"
            INSERT INTO trade_history
                (session_id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
            "#,
        )
        .bind(session_id)
        .bind(symbol)
        .bind(position.direction.as_str())
        .bind(position.entry_price)
        .bind(position.notional_usd)
        .bind(position.opened_at)
        .bind(exit_price)
        .bind(pnl_usd)
        .execute(&mut *tx)
        .await
        .map_err(|e| ExecutionError(format!("failed to record trade history: {e}")))?;

        tx.commit()
            .await
            .map_err(|e| ExecutionError(format!("failed to commit transaction: {e}")))?;

        tracing::info!(
            symbol,
            session_id,
            direction = position.direction.as_str(),
            entry_price = position.entry_price,
            exit_price,
            pnl_usd,
            "closed mock position"
        );

        Ok(())
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        // Scoped to this adapter's own wallet: each `MockExecutionAdapter`
        // is wallet-scoped, and the funding sweep runs one cycle per
        // wallet (see `crate::funding::run`), so an unscoped query here
        // would double-apply funding once per other wallet in the system.
        let rows = sqlx::query_as::<_, (String, String, f64, f64, DateTime<Utc>)>(
            "SELECT symbol, direction, entry_price, notional_usd, opened_at FROM mock_positions WHERE wallet_id = $1::uuid",
        )
        .bind(&self.wallet_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to list positions: {e}")))?;

        Ok(rows
            .into_iter()
            .map(
                |(symbol, direction, entry_price, notional_usd, opened_at)| {
                    let position = OpenPosition {
                        direction: if direction == "long" {
                            Direction::Long
                        } else {
                            Direction::Short
                        },
                        entry_price,
                        notional_usd,
                        opened_at,
                    };
                    (symbol, position)
                },
            )
            .collect())
    }

    async fn apply_funding(&self, symbol: &str, amount_usd: f64) -> Result<(), ExecutionError> {
        sqlx::query(
            "UPDATE wallets SET current_balance_usd = current_balance_usd + $1 WHERE id = $2::uuid AND kind = 'mock'",
        )
        .bind(amount_usd)
        .bind(&self.wallet_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to apply funding payment: {e}")))?;

        tracing::info!(symbol, amount_usd, "applied funding payment");

        Ok(())
    }

    /// The mock ledger (`mock_positions`) is itself the engine's virtual
    /// state — there is no separate exchange to drift from it.
    async fn reconcile(
        &self,
        _sessions: &[ReconcileTarget],
    ) -> Result<Vec<DriftOutcome>, ExecutionError> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_coordinator_allows_only_one_in_flight_claim_per_perp() {
        let coordinator = ExecutionCoordinator::default();
        let first = coordinator.try_lock("BTC").unwrap();
        assert!(coordinator.try_lock("BTC").is_none());
        assert!(coordinator.try_lock("ETH").is_some());
        drop(first);
        assert!(coordinator.try_lock("BTC").is_some());
    }

    #[test]
    fn opening_long_fills_above_mid() {
        assert_eq!(fill_price(100.0, Direction::Long, true, 10.0), 100.1);
    }

    #[test]
    fn closing_long_fills_below_mid() {
        assert_eq!(fill_price(100.0, Direction::Long, false, 10.0), 99.9);
    }

    #[test]
    fn opening_short_fills_below_mid() {
        assert_eq!(fill_price(100.0, Direction::Short, true, 10.0), 99.9);
    }

    #[test]
    fn closing_short_fills_above_mid() {
        assert_eq!(fill_price(100.0, Direction::Short, false, 10.0), 100.1);
    }

    #[test]
    fn zero_slippage_fills_exactly_at_mid() {
        assert_eq!(fill_price(100.0, Direction::Long, true, 0.0), 100.0);
        assert_eq!(fill_price(100.0, Direction::Short, false, 0.0), 100.0);
    }

    #[test]
    fn realized_pnl_is_positive_when_a_long_gains() {
        let pnl = realized_pnl_usd(Direction::Long, 100.0, 110.0, 1000.0);
        assert!((pnl - 100.0).abs() < 1e-9);
    }

    #[test]
    fn realized_pnl_is_negative_when_a_long_loses() {
        let pnl = realized_pnl_usd(Direction::Long, 100.0, 90.0, 1000.0);
        assert!((pnl + 100.0).abs() < 1e-9);
    }

    #[test]
    fn realized_pnl_is_positive_when_a_short_gains() {
        // price fell from 100 to 90: a short gains
        let pnl = realized_pnl_usd(Direction::Short, 100.0, 90.0, 1000.0);
        assert!((pnl - 100.0).abs() < 1e-9);
    }

    #[test]
    fn realized_pnl_is_negative_when_a_short_loses() {
        // price rose from 100 to 110: a short loses
        let pnl = realized_pnl_usd(Direction::Short, 100.0, 110.0, 1000.0);
        assert!((pnl + 100.0).abs() < 1e-9);
    }

    #[test]
    fn position_size_is_unchanged_when_balance_covers_it() {
        assert_eq!(clamp_position_size_usd(100.0, 500.0).unwrap(), 100.0);
    }

    #[test]
    fn position_size_is_capped_at_the_wallet_balance() {
        assert_eq!(clamp_position_size_usd(100.0, 37.5).unwrap(), 37.5);
    }

    #[test]
    fn opening_fails_when_the_wallet_has_nothing_left() {
        assert!(clamp_position_size_usd(100.0, 0.0).is_err());
        assert!(clamp_position_size_usd(100.0, -5.0).is_err());
    }
}
