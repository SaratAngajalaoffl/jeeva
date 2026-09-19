import type { Pool } from "pg";

/**
 * Reads the live wallet's derived public address, as written by the
 * engine (see engine/src/decision/live_execution.rs). Never reads or
 * exposes the private key itself — the engine_wallet table has no
 * column for it.
 */
const POSTGRES_UNDEFINED_TABLE = "42P01";

export async function getLiveWalletPublicAddress(
  pool: Pool,
): Promise<string | null> {
  try {
    const result = await pool.query<{ public_address: string }>(
      "SELECT public_address FROM engine_wallet WHERE id = 1",
    );
    return result.rows[0]?.public_address ?? null;
  } catch (error) {
    // The engine creates this table on startup; before that (or if the
    // engine has never run in live mode), there's simply no address to
    // show yet rather than an error.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === POSTGRES_UNDEFINED_TABLE
    ) {
      return null;
    }
    throw error;
  }
}
