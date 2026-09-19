import type { Pool } from "pg";

export interface PerpHealth {
  symbol: string;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
}

/**
 * Each PERP's current consecutive-failure count and most recent
 * failure, as written by the engine's decision loop after every
 * cycle. A PERP with no row here has never had a decision cycle run
 * for it yet.
 */
export async function getPerpHealth(pool: Pool): Promise<PerpHealth[]> {
  const result = await pool.query<{
    symbol: string;
    consecutive_failures: number;
    last_failure_reason: string | null;
    last_failure_at: Date | null;
  }>(
    "SELECT symbol, consecutive_failures, last_failure_reason, last_failure_at FROM perp_health ORDER BY symbol ASC",
  );

  return result.rows.map((row) => ({
    symbol: row.symbol,
    consecutiveFailures: row.consecutive_failures,
    lastFailureReason: row.last_failure_reason,
    lastFailureAt: row.last_failure_at
      ? row.last_failure_at.toISOString()
      : null,
  }));
}
