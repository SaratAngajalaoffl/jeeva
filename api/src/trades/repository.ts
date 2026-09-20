import type { Pool } from "pg";

export interface ClosedTrade {
  sessionId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
  exitPrice: number;
  pnlUsd: number;
  closedAt: string;
}

export interface TradeHistoryFilter {
  symbol?: string;
  sessionId?: string;
  from: Date;
  to: Date;
  limit: number;
}

export async function getTradeHistory(
  pool: Pool,
  filter: TradeHistoryFilter,
): Promise<ClosedTrade[]> {
  const conditions: string[] = ["closed_at >= $1", "closed_at <= $2"];
  const params: unknown[] = [filter.from, filter.to];

  if (filter.symbol) {
    params.push(filter.symbol);
    conditions.push(`symbol = $${params.length}`);
  }

  if (filter.sessionId) {
    params.push(filter.sessionId);
    conditions.push(`session_id = $${params.length}`);
  }

  params.push(filter.limit);
  const limitParam = `$${params.length}`;

  const result = await pool.query<{
    session_id: string;
    symbol: string;
    direction: "long" | "short";
    entry_price: string;
    notional_usd: string;
    opened_at: Date;
    exit_price: string;
    pnl_usd: string;
    closed_at: Date;
  }>(
    `SELECT session_id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd, closed_at
     FROM trade_history
     WHERE ${conditions.join(" AND ")}
     ORDER BY closed_at DESC
     LIMIT ${limitParam}`,
    params,
  );

  return result.rows.map((row) => ({
    sessionId: row.session_id,
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
