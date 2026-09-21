use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::PgPool;

use crate::decision::{
    clamp_position_size_usd, fill_price, realized_pnl_usd, Direction, ExecutionAdapter,
    ExecutionError, OpenPosition,
};

use super::clock::SimClock;

/// Simulates fills the same way `MockExecutionAdapter` does (same
/// `fill_price`/`realized_pnl_usd` math and slippage model), but
/// against a backtest run's own isolated state: `backtest_positions`,
/// `backtest_trades`, and `backtest_runs.current_balance_usd` — never
/// the real `wallets`/`mock_positions`/`trade_history` tables. Position
/// timestamps use the replay's `SimClock`, not wall-clock time.
pub struct BacktestExecutionAdapter {
    pool: PgPool,
    backtest_run_id: String,
    slippage_bps: f64,
    clock: Arc<SimClock>,
}

impl BacktestExecutionAdapter {
    pub fn new(pool: PgPool, backtest_run_id: String, slippage_bps: f64, clock: Arc<SimClock>) -> Self {
        Self {
            pool,
            backtest_run_id,
            slippage_bps,
            clock,
        }
    }
}

#[async_trait]
impl ExecutionAdapter for BacktestExecutionAdapter {
    async fn get_position(
        &self,
        _session_id: &str,
        _symbol: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError> {
        let row = sqlx::query_as::<_, (String, f64, f64, DateTime<Utc>)>(
            "SELECT direction, entry_price, notional_usd, opened_at FROM backtest_positions WHERE backtest_run_id = $1::uuid",
        )
        .bind(&self.backtest_run_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read backtest position: {e}")))?;

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
        _session_id: &str,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        let (available_usd,) = sqlx::query_as::<_, (f64,)>(
            "SELECT current_balance_usd FROM backtest_runs WHERE id = $1::uuid",
        )
        .bind(&self.backtest_run_id)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read backtest balance: {e}")))?;

        let position_size_usd =
            clamp_position_size_usd(position_size_usd, available_usd).map_err(ExecutionError)?;
        let notional_usd = position_size_usd * leverage;
        let entry_price = fill_price(mid_price, direction, true, self.slippage_bps);
        let opened_at = self.clock.get();

        sqlx::query(
            r#"
            INSERT INTO backtest_positions (backtest_run_id, symbol, direction, entry_price, notional_usd, opened_at)
            VALUES ($1::uuid, $2, $3, $4, $5, $6)
            "#,
        )
        .bind(&self.backtest_run_id)
        .bind(symbol)
        .bind(direction.as_str())
        .bind(entry_price)
        .bind(notional_usd)
        .bind(opened_at)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to open backtest position: {e}")))?;

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
        let closed_at = self.clock.get();

        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| ExecutionError(format!("failed to start transaction: {e}")))?;

        sqlx::query(
            "UPDATE backtest_runs SET current_balance_usd = current_balance_usd + $1 WHERE id = $2::uuid",
        )
        .bind(pnl_usd)
        .bind(&self.backtest_run_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| ExecutionError(format!("failed to update backtest balance: {e}")))?;

        sqlx::query("DELETE FROM backtest_positions WHERE backtest_run_id = $1::uuid")
            .bind(&self.backtest_run_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| ExecutionError(format!("failed to delete backtest position: {e}")))?;

        sqlx::query(
            r#"
            INSERT INTO backtest_trades
                (backtest_run_id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd, closed_at)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
            "#,
        )
        .bind(&self.backtest_run_id)
        .bind(symbol)
        .bind(position.direction.as_str())
        .bind(position.entry_price)
        .bind(position.notional_usd)
        .bind(position.opened_at)
        .bind(exit_price)
        .bind(pnl_usd)
        .bind(closed_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| ExecutionError(format!("failed to record backtest trade: {e}")))?;

        tx.commit()
            .await
            .map_err(|e| ExecutionError(format!("failed to commit transaction: {e}")))?;

        Ok(())
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        // Scoped to this run's own single position, mirroring
        // `MockExecutionAdapter::list_open_positions`'s per-wallet scoping
        // — one backtest run is one isolated "wallet".
        let row = self.get_position("", "").await?;
        Ok(match row {
            Some(position) => {
                let (symbol,) = sqlx::query_as::<_, (String,)>(
                    "SELECT symbol FROM backtest_positions WHERE backtest_run_id = $1::uuid",
                )
                .bind(&self.backtest_run_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| ExecutionError(format!("failed to read backtest position symbol: {e}")))?;
                vec![(symbol, position)]
            }
            None => vec![],
        })
    }

    async fn apply_funding(&self, _symbol: &str, amount_usd: f64) -> Result<(), ExecutionError> {
        sqlx::query(
            "UPDATE backtest_runs SET current_balance_usd = current_balance_usd + $1 WHERE id = $2::uuid",
        )
        .bind(amount_usd)
        .bind(&self.backtest_run_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to apply backtest funding payment: {e}")))?;

        Ok(())
    }
}
