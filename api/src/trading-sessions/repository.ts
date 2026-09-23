import type { Pool } from "pg";
import {
  DEFAULT_HISTORY_FORMAT,
  DEFAULT_HISTORY_WINDOW_SAMPLES,
  type HistoryFormat,
} from "./historyWindow.js";

export type DecisionMaker = "random" | "typesafe" | "openrouter";

export type TradingSessionStatus =
  | "active"
  | "soft_closing"
  | "hard_closing"
  | "closed";

export interface TradingSession {
  id: string;
  symbol: string;
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  /** How many recent market-data samples the engine reads for this session's decision context. */
  historyWindowSamples: number;
  /** Whether that window reaches the decision maker raw, or averaged into a min/max/avg summary. */
  historyFormat: HistoryFormat;
  /** Whether every decision cycle's raw Jev request/response JSON is persisted, not just the parsed fields. */
  storeDecisionPayloads: boolean;
  /** Fraction of notional (0-1] at which an open position is force-closed; null means no stop-loss. */
  stopLossPct: number | null;
  walletId: string | null;
  status: TradingSessionStatus;
  createdAt: string;
  closedAt: string | null;
}

export class WalletInUseError extends Error {
  constructor() {
    super("This wallet is already attached to another active trading session");
    this.name = "WalletInUseError";
  }
}

export class TradingSessionNotFoundError extends Error {
  constructor() {
    super("Trading session not found");
    this.name = "TradingSessionNotFoundError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

interface TradingSessionRow {
  id: string;
  symbol: string;
  decision_maker: DecisionMaker;
  decision_frequency_seconds: string;
  leverage: string;
  position_size_usd: string;
  history_window_samples: number;
  history_format: HistoryFormat;
  store_decision_payloads: boolean;
  stop_loss_pct: string | null;
  wallet_id: string | null;
  status: TradingSessionStatus;
  created_at: Date;
  closed_at: Date | null;
}

function toTradingSession(row: TradingSessionRow): TradingSession {
  return {
    id: row.id,
    symbol: row.symbol,
    decisionMaker: row.decision_maker,
    decisionFrequencySeconds: Number(row.decision_frequency_seconds),
    leverage: Number(row.leverage),
    positionSizeUsd: Number(row.position_size_usd),
    historyWindowSamples: row.history_window_samples,
    historyFormat: row.history_format,
    storeDecisionPayloads: row.store_decision_payloads,
    stopLossPct: row.stop_loss_pct === null ? null : Number(row.stop_loss_pct),
    walletId: row.wallet_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}

const COLUMNS =
  "id, symbol, decision_maker, decision_frequency_seconds, leverage, position_size_usd, history_window_samples, history_format, store_decision_payloads, stop_loss_pct, wallet_id, status, created_at, closed_at";

export async function listTradingSessions(
  pool: Pool,
  symbol?: string,
): Promise<TradingSession[]> {
  if (symbol) {
    const result = await pool.query<TradingSessionRow>(
      `SELECT ${COLUMNS} FROM trading_sessions WHERE symbol = $1 ORDER BY created_at`,
      [symbol],
    );
    return result.rows.map(toTradingSession);
  }

  const result = await pool.query<TradingSessionRow>(
    `SELECT ${COLUMNS} FROM trading_sessions ORDER BY created_at`,
  );
  return result.rows.map(toTradingSession);
}

export async function getTradingSession(
  pool: Pool,
  id: string,
): Promise<TradingSession | null> {
  const result = await pool.query<TradingSessionRow>(
    `SELECT ${COLUMNS} FROM trading_sessions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toTradingSession(row) : null;
}

export interface CreateTradingSessionInput {
  symbol: string;
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  historyWindowSamples?: number;
  historyFormat?: HistoryFormat;
  storeDecisionPayloads?: boolean;
  stopLossPct?: number | null;
  walletId: string | null;
}

async function handleWalletUniqueViolation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new WalletInUseError();
    }
    throw error;
  }
}

export async function createTradingSession(
  pool: Pool,
  input: CreateTradingSessionInput,
): Promise<TradingSession> {
  return handleWalletUniqueViolation(async () => {
    const result = await pool.query<TradingSessionRow>(
      `INSERT INTO trading_sessions
         (symbol, decision_maker, decision_frequency_seconds, leverage, position_size_usd,
          history_window_samples, history_format, store_decision_payloads, stop_loss_pct, wallet_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active')
       RETURNING ${COLUMNS}`,
      [
        input.symbol,
        input.decisionMaker,
        input.decisionFrequencySeconds,
        input.leverage,
        input.positionSizeUsd,
        input.historyWindowSamples ?? DEFAULT_HISTORY_WINDOW_SAMPLES,
        input.historyFormat ?? DEFAULT_HISTORY_FORMAT,
        input.storeDecisionPayloads ?? false,
        input.stopLossPct ?? null,
        input.walletId,
      ],
    );
    return toTradingSession(result.rows[0]);
  });
}

export type TradingSessionConfigPatch = Partial<
  Pick<
    TradingSession,
    | "decisionMaker"
    | "decisionFrequencySeconds"
    | "leverage"
    | "positionSizeUsd"
    | "historyWindowSamples"
    | "historyFormat"
    | "storeDecisionPayloads"
    | "stopLossPct"
  >
>;

/**
 * Applies a partial config patch over an existing session, leaving every
 * field the patch omits untouched. Pure, so the merge semantics are
 * testable without a database.
 */
export function mergeTradingSessionConfig(
  existing: TradingSession,
  patch: TradingSessionConfigPatch,
): Omit<TradingSessionConfigPatch, "decisionMaker"> & {
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  historyWindowSamples: number;
  historyFormat: HistoryFormat;
  storeDecisionPayloads: boolean;
  stopLossPct: number | null;
} {
  return {
    decisionMaker: patch.decisionMaker ?? existing.decisionMaker,
    decisionFrequencySeconds:
      patch.decisionFrequencySeconds ?? existing.decisionFrequencySeconds,
    leverage: patch.leverage ?? existing.leverage,
    positionSizeUsd: patch.positionSizeUsd ?? existing.positionSizeUsd,
    historyWindowSamples:
      patch.historyWindowSamples ?? existing.historyWindowSamples,
    historyFormat: patch.historyFormat ?? existing.historyFormat,
    storeDecisionPayloads:
      patch.storeDecisionPayloads ?? existing.storeDecisionPayloads,
    // `stopLossPct` is nullable itself (null clears the stop-loss), so
    // an omitted key (undefined) means "leave it alone" while an
    // explicit `null` means "clear it" — `??` can't tell those apart.
    stopLossPct:
      "stopLossPct" in patch ? (patch.stopLossPct ?? null) : existing.stopLossPct,
  };
}

export async function updateTradingSessionConfig(
  pool: Pool,
  id: string,
  patch: TradingSessionConfigPatch,
): Promise<TradingSession | null> {
  const existing = await getTradingSession(pool, id);
  if (!existing) {
    return null;
  }

  const merged = mergeTradingSessionConfig(existing, patch);
  const result = await pool.query<TradingSessionRow>(
    `UPDATE trading_sessions
     SET decision_maker = $2,
         decision_frequency_seconds = $3,
         leverage = $4,
         position_size_usd = $5,
         history_window_samples = $6,
         history_format = $7,
         store_decision_payloads = $8,
         stop_loss_pct = $9
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [
      id,
      merged.decisionMaker,
      merged.decisionFrequencySeconds,
      merged.leverage,
      merged.positionSizeUsd,
      merged.historyWindowSamples,
      merged.historyFormat,
      merged.storeDecisionPayloads,
      merged.stopLossPct,
    ],
  );
  return toTradingSession(result.rows[0]);
}

/**
 * Attaches a wallet to a session, or detaches it if walletId is null.
 * Exclusivity (a wallet can only be attached to one non-closed session at
 * a time) is enforced by the partial unique index on trading_sessions —
 * this surfaces that as WalletInUseError instead of a raw DB error.
 */
export async function setSessionWallet(
  pool: Pool,
  id: string,
  walletId: string | null,
): Promise<TradingSession | null> {
  return handleWalletUniqueViolation(async () => {
    const result = await pool.query<TradingSessionRow>(
      `UPDATE trading_sessions SET wallet_id = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, walletId],
    );
    const row = result.rows[0];
    return row ? toTradingSession(row) : null;
  });
}

/**
 * Requests a soft close: the engine keeps running the session's decision
 * maker (flatten-only) until the position reports flat, then transitions
 * it to 'closed' itself.
 */
export async function softCloseTradingSession(
  pool: Pool,
  id: string,
): Promise<TradingSession | null> {
  const result = await pool.query<TradingSessionRow>(
    `UPDATE trading_sessions SET status = 'soft_closing'
     WHERE id = $1 AND status = 'active'
     RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ? toTradingSession(result.rows[0]) : null;
}

/**
 * Requests a hard close: the engine force-flattens the position on its
 * next tick and transitions the session to 'closed' immediately after.
 */
export async function hardCloseTradingSession(
  pool: Pool,
  id: string,
): Promise<TradingSession | null> {
  const result = await pool.query<TradingSessionRow>(
    `UPDATE trading_sessions SET status = 'hard_closing'
     WHERE id = $1 AND status IN ('active', 'soft_closing')
     RETURNING ${COLUMNS}`,
    [id],
  );
  return result.rows[0] ? toTradingSession(result.rows[0]) : null;
}
