import type { Pool } from "pg";

export interface MockWallet {
  initialBalanceUsd: number;
  currentBalanceUsd: number;
  allTimePnlUsd: number;
  createdAt: string;
}

export class MockWalletAlreadyExistsError extends Error {
  constructor() {
    super("A mock wallet already exists");
    this.name = "MockWalletAlreadyExistsError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

function toMockWallet(row: {
  initial_balance_usd: string;
  current_balance_usd: string;
  created_at: Date;
}): MockWallet {
  const initialBalanceUsd = Number(row.initial_balance_usd);
  const currentBalanceUsd = Number(row.current_balance_usd);
  return {
    initialBalanceUsd,
    currentBalanceUsd,
    allTimePnlUsd: currentBalanceUsd - initialBalanceUsd,
    createdAt: row.created_at.toISOString(),
  };
}

export async function getMockWallet(pool: Pool): Promise<MockWallet | null> {
  const result = await pool.query<{
    initial_balance_usd: string;
    current_balance_usd: string;
    created_at: Date;
  }>(
    "SELECT initial_balance_usd, current_balance_usd, created_at FROM mock_wallet WHERE id = 1",
  );
  const row = result.rows[0];
  return row ? toMockWallet(row) : null;
}

export async function createMockWallet(
  pool: Pool,
  initialBalanceUsd: number,
): Promise<MockWallet> {
  try {
    const result = await pool.query<{
      initial_balance_usd: string;
      current_balance_usd: string;
      created_at: Date;
    }>(
      `INSERT INTO mock_wallet (id, initial_balance_usd, current_balance_usd)
       VALUES (1, $1, $1)
       RETURNING initial_balance_usd, current_balance_usd, created_at`,
      [initialBalanceUsd],
    );
    return toMockWallet(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new MockWalletAlreadyExistsError();
    }
    throw error;
  }
}
