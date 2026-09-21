import type { Pool } from "pg";
import type { HistoryFormat } from "../trading-sessions/historyWindow.js";
import type { DecisionMaker } from "../trading-sessions/repository.js";

export type BacktestStatus = "pending" | "running" | "completed" | "failed";

export interface BacktestRun {
  id: string;
  symbol: string;
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  historyWindowSamples: number;
  historyFormat: HistoryFormat;
  startTime: string;
  endTime: string;
  initialBalanceUsd: number;
  currentBalanceUsd: number;
  status: BacktestStatus;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface BacktestRunRow {
  id: string;
  symbol: string;
  decision_maker: DecisionMaker;
  decision_frequency_seconds: string;
  leverage: string;
  position_size_usd: string;
  history_window_samples: number;
  history_format: HistoryFormat;
  start_time: Date;
  end_time: Date;
  initial_balance_usd: string;
  current_balance_usd: string;
  status: BacktestStatus;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function toBacktestRun(row: BacktestRunRow): BacktestRun {
  return {
    id: row.id,
    symbol: row.symbol,
    decisionMaker: row.decision_maker,
    decisionFrequencySeconds: Number(row.decision_frequency_seconds),
    leverage: Number(row.leverage),
    positionSizeUsd: Number(row.position_size_usd),
    historyWindowSamples: row.history_window_samples,
    historyFormat: row.history_format,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time.toISOString(),
    initialBalanceUsd: Number(row.initial_balance_usd),
    currentBalanceUsd: Number(row.current_balance_usd),
    status: row.status,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

const COLUMNS =
  "id, symbol, decision_maker, decision_frequency_seconds, leverage, position_size_usd, " +
  "history_window_samples, history_format, start_time, end_time, initial_balance_usd, " +
  "current_balance_usd, status, error, created_at, completed_at";

export interface CreateBacktestRunInput {
  symbol: string;
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  historyWindowSamples: number;
  historyFormat: HistoryFormat;
  startTime: string;
  endTime: string;
  initialBalanceUsd: number;
}

export async function createBacktestRun(
  pool: Pool,
  input: CreateBacktestRunInput,
): Promise<BacktestRun> {
  const result = await pool.query<BacktestRunRow>(
    `INSERT INTO backtest_runs
       (symbol, decision_maker, decision_frequency_seconds, leverage, position_size_usd,
        history_window_samples, history_format, start_time, end_time,
        initial_balance_usd, current_balance_usd, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 'pending')
     RETURNING ${COLUMNS}`,
    [
      input.symbol,
      input.decisionMaker,
      input.decisionFrequencySeconds,
      input.leverage,
      input.positionSizeUsd,
      input.historyWindowSamples,
      input.historyFormat,
      input.startTime,
      input.endTime,
      input.initialBalanceUsd,
    ],
  );
  return toBacktestRun(result.rows[0]);
}

export async function listBacktestRuns(
  pool: Pool,
  symbol?: string,
): Promise<BacktestRun[]> {
  if (symbol) {
    const result = await pool.query<BacktestRunRow>(
      `SELECT ${COLUMNS} FROM backtest_runs WHERE symbol = $1 ORDER BY created_at DESC`,
      [symbol],
    );
    return result.rows.map(toBacktestRun);
  }
  const result = await pool.query<BacktestRunRow>(
    `SELECT ${COLUMNS} FROM backtest_runs ORDER BY created_at DESC`,
  );
  return result.rows.map(toBacktestRun);
}

export async function getBacktestRun(
  pool: Pool,
  id: string,
): Promise<BacktestRun | null> {
  const result = await pool.query<BacktestRunRow>(
    `SELECT ${COLUMNS} FROM backtest_runs WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toBacktestRun(row) : null;
}

/** Oldest market-data sample available for a symbol, or null if there is none. */
export async function earliestMarketDataTime(
  pool: Pool,
  symbol: string,
): Promise<string | null> {
  const result = await pool.query<{ min: Date | null }>(
    `SELECT MIN(time) AS min FROM market_data WHERE symbol = $1`,
    [symbol],
  );
  const min = result.rows[0]?.min ?? null;
  return min ? min.toISOString() : null;
}

export interface BacktestDecisionEntry {
  id: string;
  simTime: string;
  symbol: string;
  contextSummary: string;
  targetDirection: string | null;
  confidence: number | null;
  probLong: number | null;
  probShort: number | null;
  probFlat: number | null;
  positionAction: string | null;
  success: boolean;
  error: string | null;
  autoFlatten: boolean;
  createdAt: string;
}

interface BacktestDecisionRow {
  id: string;
  sim_time: Date;
  symbol: string;
  context_summary: string;
  target_direction: string | null;
  confidence: string | null;
  prob_long: string | null;
  prob_short: string | null;
  prob_flat: string | null;
  position_action: string | null;
  success: boolean;
  error: string | null;
  auto_flatten: boolean;
  created_at: Date;
}

function toBacktestDecision(row: BacktestDecisionRow): BacktestDecisionEntry {
  return {
    id: row.id,
    simTime: row.sim_time.toISOString(),
    symbol: row.symbol,
    contextSummary: row.context_summary,
    targetDirection: row.target_direction,
    confidence: row.confidence !== null ? Number(row.confidence) : null,
    probLong: row.prob_long !== null ? Number(row.prob_long) : null,
    probShort: row.prob_short !== null ? Number(row.prob_short) : null,
    probFlat: row.prob_flat !== null ? Number(row.prob_flat) : null,
    positionAction: row.position_action,
    success: row.success,
    error: row.error,
    autoFlatten: row.auto_flatten,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listBacktestDecisions(
  pool: Pool,
  backtestRunId: string,
): Promise<BacktestDecisionEntry[]> {
  const result = await pool.query<BacktestDecisionRow>(
    `SELECT id, sim_time, symbol, context_summary, target_direction, confidence,
            prob_long, prob_short, prob_flat, position_action, success, error,
            auto_flatten, created_at
     FROM backtest_decisions
     WHERE backtest_run_id = $1
     ORDER BY sim_time`,
    [backtestRunId],
  );
  return result.rows.map(toBacktestDecision);
}

export interface BacktestPosition {
  backtestRunId: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
}

interface BacktestPositionRow {
  backtest_run_id: string;
  symbol: string;
  direction: string;
  entry_price: string;
  notional_usd: string;
  opened_at: Date;
}

export async function getBacktestPosition(
  pool: Pool,
  backtestRunId: string,
): Promise<BacktestPosition | null> {
  const result = await pool.query<BacktestPositionRow>(
    `SELECT backtest_run_id, symbol, direction, entry_price, notional_usd, opened_at
     FROM backtest_positions WHERE backtest_run_id = $1`,
    [backtestRunId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    backtestRunId: row.backtest_run_id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    notionalUsd: Number(row.notional_usd),
    openedAt: row.opened_at.toISOString(),
  };
}

export interface BacktestTrade {
  id: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
  exitPrice: number;
  pnlUsd: number;
  closedAt: string;
}

interface BacktestTradeRow {
  id: string;
  symbol: string;
  direction: string;
  entry_price: string;
  notional_usd: string;
  opened_at: Date;
  exit_price: string;
  pnl_usd: string;
  closed_at: Date;
}

export async function listBacktestTrades(
  pool: Pool,
  backtestRunId: string,
): Promise<BacktestTrade[]> {
  const result = await pool.query<BacktestTradeRow>(
    `SELECT id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd, closed_at
     FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY closed_at`,
    [backtestRunId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    notionalUsd: Number(row.notional_usd),
    openedAt: row.opened_at.toISOString(),
    exitPrice: Number(row.exit_price),
    pnlUsd: Number(row.pnl_usd),
    closedAt: row.closed_at.toISOString(),
  }));
}
