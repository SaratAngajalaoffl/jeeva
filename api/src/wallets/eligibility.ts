import type { Db } from "mongodb";
import type { Pool } from "pg";
import { getEngineMode } from "../engineMode/repository.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { getWallet, listWallets, type Wallet } from "./repository.js";

export async function getWalletBalanceUsd(
  wallet: Wallet,
  hyperliquidClient: HyperliquidClient,
): Promise<number> {
  if (wallet.kind === "mock") {
    return wallet.currentBalanceUsd ?? 0;
  }

  if (!wallet.publicAddress) {
    return 0;
  }

  const state = await hyperliquidClient.getClearinghouseState(
    wallet.publicAddress,
  );
  return state.withdrawableUsd;
}

/**
 * Wallets eligible to be selected for a market's trading config: only
 * wallets matching the current global engine mode (a market must never
 * be left trading a real wallet while live trading is disabled, and
 * vice versa) with enough balance to cover the requested trading size.
 */
export async function listSelectableWallets(
  db: Db,
  pgPool: Pool,
  hyperliquidClient: HyperliquidClient,
  sizeUsd: number,
): Promise<Wallet[]> {
  const [mode, wallets] = await Promise.all([
    getEngineMode(db),
    listWallets(pgPool),
  ]);

  const candidates = wallets.filter((wallet) => wallet.kind === mode);
  const balances = await Promise.all(
    candidates.map((wallet) => getWalletBalanceUsd(wallet, hyperliquidClient)),
  );

  return candidates.filter((_, i) => balances[i] >= sizeUsd);
}

/**
 * Validates that a wallet is a legal choice for enabling trading on a
 * market: it must exist, match the current engine mode, and have
 * enough balance for the requested position size.
 */
export async function isWalletEligible(
  db: Db,
  pgPool: Pool,
  hyperliquidClient: HyperliquidClient,
  walletId: string,
  sizeUsd: number,
): Promise<boolean> {
  const [mode, wallet] = await Promise.all([
    getEngineMode(db),
    getWallet(pgPool, walletId),
  ]);

  if (!wallet || wallet.kind !== mode) {
    return false;
  }

  const balance = await getWalletBalanceUsd(wallet, hyperliquidClient);
  return balance >= sizeUsd;
}
