import type { Pool } from "pg";

export interface Position {
  sessionId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
}

/**
 * All currently open mock and live positions, across every trading
 * session. A session with no row here is flat — both position tables
 * (owned/written by the engine, keyed by session_id) only ever hold
 * long/short rows, never an explicit "flat" entry.
 */
export async function getOpenPositions(pool: Pool): Promise<Position[]> {
  const result = await pool.query<{
    session_id: string;
    symbol: string;
    direction: "long" | "short";
    entry_price: string;
    notional_usd: string;
    opened_at: Date;
  }>(
    `SELECT session_id, symbol, direction, entry_price, notional_usd, opened_at
     FROM (
       SELECT session_id, symbol, direction, entry_price, notional_usd, opened_at
       FROM mock_positions
       UNION ALL
       SELECT session_id, symbol, direction, entry_price, notional_usd, opened_at
       FROM live_positions
     ) positions
     ORDER BY symbol ASC`,
  );

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    notionalUsd: Number(row.notional_usd),
    openedAt: row.opened_at.toISOString(),
  }));
}
