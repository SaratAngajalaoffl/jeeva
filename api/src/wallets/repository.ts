import type { Pool } from "pg";
import { encryptPrivateKey } from "./crypto.js";

export type WalletKind = "mock" | "live";

export interface Wallet {
  id: string;
  label: string;
  kind: WalletKind;
  publicAddress: string | null;
  initialBalanceUsd: number | null;
  currentBalanceUsd: number | null;
  createdAt: string;
}

export class WalletAlreadyExistsError extends Error {
  constructor() {
    super("A wallet with this label already exists");
    this.name = "WalletAlreadyExistsError";
  }
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

interface WalletRow {
  id: string;
  label: string;
  kind: WalletKind;
  public_address: string | null;
  initial_balance_usd: string | null;
  current_balance_usd: string | null;
  created_at: Date;
}

function toWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    publicAddress: row.public_address,
    initialBalanceUsd:
      row.initial_balance_usd === null ? null : Number(row.initial_balance_usd),
    currentBalanceUsd:
      row.current_balance_usd === null ? null : Number(row.current_balance_usd),
    createdAt: row.created_at.toISOString(),
  };
}

const WALLET_COLUMNS =
  "id, label, kind, public_address, initial_balance_usd, current_balance_usd, created_at";

export async function listWallets(pool: Pool): Promise<Wallet[]> {
  const result = await pool.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets ORDER BY created_at`,
  );
  return result.rows.map(toWallet);
}

export async function getWallet(
  pool: Pool,
  id: string,
): Promise<Wallet | null> {
  const result = await pool.query<WalletRow>(
    `SELECT ${WALLET_COLUMNS} FROM wallets WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toWallet(row) : null;
}

export interface CreateMockWalletInput {
  kind: "mock";
  label: string;
  initialBalanceUsd: number;
}

export interface CreateLiveWalletInput {
  kind: "live";
  label: string;
  publicAddress: string;
  privateKey: string;
}

export type CreateWalletInput = CreateMockWalletInput | CreateLiveWalletInput;

async function insertWallet(
  pool: Pool,
  params: {
    label: string;
    kind: WalletKind;
    publicAddress: string | null;
    encryptedPrivateKey: string | null;
    initialBalanceUsd: number | null;
    currentBalanceUsd: number | null;
  },
): Promise<Wallet> {
  try {
    const result = await pool.query<WalletRow>(
      `INSERT INTO wallets (label, kind, public_address, encrypted_private_key, initial_balance_usd, current_balance_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${WALLET_COLUMNS}`,
      [
        params.label,
        params.kind,
        params.publicAddress,
        params.encryptedPrivateKey,
        params.initialBalanceUsd,
        params.currentBalanceUsd,
      ],
    );
    return toWallet(result.rows[0]);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === POSTGRES_UNIQUE_VIOLATION
    ) {
      throw new WalletAlreadyExistsError();
    }
    throw error;
  }
}

export async function createWallet(
  pool: Pool,
  input: CreateWalletInput,
): Promise<Wallet> {
  if (input.kind === "mock") {
    return insertWallet(pool, {
      label: input.label,
      kind: "mock",
      publicAddress: null,
      encryptedPrivateKey: null,
      initialBalanceUsd: input.initialBalanceUsd,
      currentBalanceUsd: input.initialBalanceUsd,
    });
  }

  return insertWallet(pool, {
    label: input.label,
    kind: "live",
    publicAddress: input.publicAddress,
    encryptedPrivateKey: encryptPrivateKey(input.privateKey),
    initialBalanceUsd: null,
    currentBalanceUsd: null,
  });
}

export async function deleteWallet(pool: Pool, id: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM wallets WHERE id = $1", [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function updateMockBalance(
  pool: Pool,
  id: string,
  currentBalanceUsd: number,
): Promise<Wallet | null> {
  const result = await pool.query<WalletRow>(
    `UPDATE wallets SET current_balance_usd = $2
     WHERE id = $1 AND kind = 'mock'
     RETURNING ${WALLET_COLUMNS}`,
    [id, currentBalanceUsd],
  );
  const row = result.rows[0];
  return row ? toWallet(row) : null;
}
