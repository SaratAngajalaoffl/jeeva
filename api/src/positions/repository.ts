import type { Pool } from "pg";

export interface Position {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
}

/**
 * All currently open mock positions. A PERP with no row here is flat —
 * the mock_positions table (owned/written by the engine) only ever
 * holds long/short rows, never an explicit "flat" entry.
 */
export async function getOpenPositions(pool: Pool): Promise<Position[]> {
  const result = await pool.query<{
    symbol: string;
    direction: "long" | "short";
    entry_price: string;
    notional_usd: string;
    opened_at: Date;
  }>(
    "SELECT symbol, direction, entry_price, notional_usd, opened_at FROM mock_positions ORDER BY symbol ASC",
  );

  return result.rows.map((row) => ({
    symbol: row.symbol,
    direction: row.direction,
    entryPrice: Number(row.entry_price),
    notionalUsd: Number(row.notional_usd),
    openedAt: row.opened_at.toISOString(),
  }));
}
