use std::fmt;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::pg::execute_idempotent;

use super::model::Direction;

#[derive(Debug)]
pub struct ExecutionError(pub String);

impl fmt::Display for ExecutionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ExecutionError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OpenPosition {
    pub direction: Direction,
    pub entry_price: f64,
    pub notional_usd: f64,
    pub opened_at: DateTime<Utc>,
}

/// Opens/closes a PERP's mock position against the shared mock wallet.
/// The real (only, for now) implementation simulates fills at
/// mid-price plus/minus slippage and realizes P&L into the wallet's
/// balance on close; a fake implementation lets the decision loop be
/// tested without a database.
#[async_trait]
pub trait ExecutionAdapter: Send + Sync {
    async fn get_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError>;

    async fn open(
        &self,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError>;

    /// No-ops if there is no open position for the symbol.
    async fn close(&self, symbol: &str, mid_price: f64) -> Result<(), ExecutionError>;

    /// Every currently open mock position, symbol-keyed. Used by the
    /// funding sweep, which applies to all open positions regardless of
    /// which PERP's decision loop opened them.
    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError>;

    /// Directly credits/debits the wallet by `amount_usd` (positive
    /// credits, negative debits) without touching any position — used
    /// for funding payments, which are distinct from decision-driven
    /// realized P&L on close.
    async fn apply_funding(&self, symbol: &str, amount_usd: f64) -> Result<(), ExecutionError>;
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

pub struct MockExecutionAdapter {
    pool: PgPool,
    slippage_bps: f64,
}

impl MockExecutionAdapter {
    pub fn new(pool: PgPool, slippage_bps: f64) -> Self {
        Self { pool, slippage_bps }
    }

    pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::Error> {
        execute_idempotent(
            pool,
            r#"
            CREATE TABLE IF NOT EXISTS mock_positions (
                symbol TEXT PRIMARY KEY,
                direction TEXT NOT NULL,
                entry_price DOUBLE PRECISION NOT NULL,
                notional_usd DOUBLE PRECISION NOT NULL,
                opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            "#,
        )
        .await
    }
}

#[async_trait]
impl ExecutionAdapter for MockExecutionAdapter {
    async fn get_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        let row = sqlx::query_as::<_, (String, f64, f64, DateTime<Utc>)>(
            "SELECT direction, entry_price, notional_usd, opened_at FROM mock_positions WHERE symbol = $1",
        )
        .bind(symbol)
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
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        let notional_usd = position_size_usd * leverage;
        let entry_price = fill_price(mid_price, direction, true, self.slippage_bps);

        let (opened_at,) = sqlx::query_as::<_, (DateTime<Utc>,)>(
            r#"
            INSERT INTO mock_positions (symbol, direction, entry_price, notional_usd)
            VALUES ($1, $2, $3, $4)
            RETURNING opened_at
            "#,
        )
        .bind(symbol)
        .bind(direction.as_str())
        .bind(entry_price)
        .bind(notional_usd)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to open position: {e}")))?;

        tracing::info!(
            symbol,
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

    async fn close(&self, symbol: &str, mid_price: f64) -> Result<(), ExecutionError> {
        let Some(position) = self.get_position(symbol).await? else {
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
            "UPDATE mock_wallet SET current_balance_usd = current_balance_usd + $1 WHERE id = 1",
        )
        .bind(pnl_usd)
        .execute(&mut *tx)
        .await
        .map_err(|e| ExecutionError(format!("failed to update wallet balance: {e}")))?;

        sqlx::query("DELETE FROM mock_positions WHERE symbol = $1")
            .bind(symbol)
            .execute(&mut *tx)
            .await
            .map_err(|e| ExecutionError(format!("failed to delete position: {e}")))?;

        tx.commit()
            .await
            .map_err(|e| ExecutionError(format!("failed to commit transaction: {e}")))?;

        tracing::info!(
            symbol,
            direction = position.direction.as_str(),
            entry_price = position.entry_price,
            exit_price,
            pnl_usd,
            "closed mock position"
        );

        Ok(())
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        let rows = sqlx::query_as::<_, (String, String, f64, f64, DateTime<Utc>)>(
            "SELECT symbol, direction, entry_price, notional_usd, opened_at FROM mock_positions",
        )
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
            "UPDATE mock_wallet SET current_balance_usd = current_balance_usd + $1 WHERE id = 1",
        )
        .bind(amount_usd)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to apply funding payment: {e}")))?;

        tracing::info!(symbol, amount_usd, "applied funding payment");

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
