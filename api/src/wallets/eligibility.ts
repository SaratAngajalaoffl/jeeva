import type { Db } from "mongodb";
import type { Pool } from "pg";
import { getEngineMode } from "../engineMode/repository.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import {
  getWallet,
  getWalletSessionId,
  listWallets,
  type Wallet,
} from "./repository.js";

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
 * Wallets eligible to be attached to a new/existing trading session:
 * only wallets matching the current global engine mode (a session must
 * never be left trading a real wallet while live trading is disabled,
 * and vice versa), with enough balance to cover the requested trading
 * size, and not already attached to another non-closed session.
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
  const [balances, sessionIds] = await Promise.all([
    Promise.all(
      candidates.map((wallet) => getWalletBalanceUsd(wallet, hyperliquidClient)),
    ),
    Promise.all(
      candidates.map((wallet) => getWalletSessionId(pgPool, wallet.id)),
    ),
  ]);

  return candidates.filter(
    (_, i) => balances[i] >= sizeUsd && sessionIds[i] === null,
  );
}

/**
 * Validates that a wallet is a legal choice for a trading session: it
 * must exist, match the current engine mode, have enough balance for
 * the requested position size, and not already be attached to another
 * non-closed session.
 */
export async function isWalletEligible(
  db: Db,
  pgPool: Pool,
  hyperliquidClient: HyperliquidClient,
  walletId: string,
  sizeUsd: number,
): Promise<boolean> {
  const [mode, wallet, sessionId] = await Promise.all([
    getEngineMode(db),
    getWallet(pgPool, walletId),
    getWalletSessionId(pgPool, walletId),
  ]);

  if (!wallet || wallet.kind !== mode || sessionId !== null) {
    return false;
  }

  const balance = await getWalletBalanceUsd(wallet, hyperliquidClient);
  return balance >= sizeUsd;
}
