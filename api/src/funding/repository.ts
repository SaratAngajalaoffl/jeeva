import type { Pool } from "pg";

export interface FundingPayment {
  time: string;
  sessionId: string | null;
  symbol: string;
  direction: "long" | "short";
  fundingRate: number;
  notionalUsd: number;
  amountUsd: number;
}

export interface FundingHistoryFilter {
  symbol?: string;
  sessionId?: string;
  from: Date;
  to: Date;
  limit: number;
}

export async function getFundingHistory(
  pool: Pool,
  filter: FundingHistoryFilter,
): Promise<FundingPayment[]> {
  const conditions: string[] = ["time >= $1", "time <= $2"];
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
    time: Date;
    session_id: string | null;
    symbol: string;
    direction: "long" | "short";
    funding_rate: string;
    notional_usd: string;
    amount_usd: string;
  }>(
    `SELECT time, session_id, symbol, direction, funding_rate, notional_usd, amount_usd
     FROM funding_payments
     WHERE ${conditions.join(" AND ")}
     ORDER BY time DESC
     LIMIT ${limitParam}`,
    params,
  );

  return result.rows.map((row) => ({
    time: row.time.toISOString(),
    sessionId: row.session_id,
    symbol: row.symbol,
    direction: row.direction,
    fundingRate: Number(row.funding_rate),
    notionalUsd: Number(row.notional_usd),
    amountUsd: Number(row.amount_usd),
  }));
}
