import type { Pool } from "pg";

export interface MarketDataPoint {
  time: string;
  price: number;
  openInterest: number;
  volume: number;
  spread: number;
  midPrice: number;
}

export async function getOldestSampleTime(
  pool: Pool,
  symbol: string,
): Promise<Date | null> {
  const result = await pool.query<{ time: Date | null }>(
    `SELECT MIN(time) AS time FROM market_data WHERE symbol = $1`,
    [symbol],
  );
  return result.rows[0]?.time ?? null;
}

export async function getMarketDataHistory(
  pool: Pool,
  symbol: string,
  from: Date,
  to: Date,
): Promise<MarketDataPoint[]> {
  const result = await pool.query<{
    time: Date;
    price: string;
    open_interest: string;
    volume: string;
    spread: string;
    mid_price: string;
  }>(
    `SELECT time, price, open_interest, volume, spread, mid_price
     FROM market_data
     WHERE symbol = $1 AND time >= $2 AND time <= $3
     ORDER BY time ASC`,
    [symbol, from, to],
  );

  return result.rows.map((row) => ({
    time: row.time.toISOString(),
    price: Number(row.price),
    openInterest: Number(row.open_interest),
    volume: Number(row.volume),
    spread: Number(row.spread),
    midPrice: Number(row.mid_price),
  }));
}
