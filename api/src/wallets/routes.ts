import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { isValidInitialBalanceUsd } from "./balance.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { isValidPositionSizeUsd } from "../perps/sizing.js";
import {
  createWallet,
  deleteWallet,
  getWallet,
  getWalletSessionId,
  listWallets,
  WalletAlreadyExistsError,
  WalletInUseError,
  type WalletKind,
} from "./repository.js";
import { getWalletBalanceUsd, listSelectableWallets } from "./eligibility.js";

function isValidKind(value: unknown): value is WalletKind {
  return value === "mock" || value === "live";
}

export function createWalletsRouter(
  db: Db,
  pgPool: Pool,
  hyperliquidClient: HyperliquidClient,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const wallets = await listWallets(pgPool);
    const withUsage = await Promise.all(
      wallets.map(async (wallet) => ({
        ...wallet,
        activeSessionId: await getWalletSessionId(pgPool, wallet.id),
      })),
    );
    res.status(200).json({ wallets: withUsage });
  });

  router.get("/selectable", async (req, res) => {
    const symbol = typeof req.query.symbol === "string" ? req.query.symbol : "";
    const sizeUsd = Number(req.query.sizeUsd);

    if (!symbol || !isValidPositionSizeUsd(sizeUsd)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const wallets = await listSelectableWallets(
      db,
      pgPool,
      hyperliquidClient,
      sizeUsd,
    );
    res.status(200).json({ wallets });
  });

  router.get("/:id/balance", async (req, res) => {
    const wallet = await getWallet(pgPool, req.params.id);
    if (!wallet) {
      res.status(404).json({ error: "wallet not found" });
      return;
    }

    const balanceUsd = await getWalletBalanceUsd(wallet, hyperliquidClient);
    res.status(200).json({ balanceUsd });
  });

  router.post("/", async (req, res) => {
    const { kind, label, initialBalanceUsd, publicAddress, privateKey } =
      req.body ?? {};

    if (!isValidKind(kind) || typeof label !== "string" || !label.trim()) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    try {
      if (kind === "mock") {
        if (!isValidInitialBalanceUsd(initialBalanceUsd)) {
          res.status(400).json({ error: "invalid request" });
          return;
        }
        const wallet = await createWallet(pgPool, {
          kind: "mock",
          label,
          initialBalanceUsd,
        });
        res.status(201).json(wallet);
        return;
      }

      if (
        typeof publicAddress !== "string" ||
        !publicAddress.trim() ||
        typeof privateKey !== "string" ||
        !privateKey.trim()
      ) {
        res.status(400).json({ error: "invalid request" });
        return;
      }

      const wallet = await createWallet(pgPool, {
        kind: "live",
        label,
        publicAddress,
        privateKey,
      });
      res.status(201).json(wallet);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const deleted = await deleteWallet(pgPool, req.params.id);
      if (!deleted) {
        res.status(404).json({ error: "wallet not found" });
        return;
      }
      res.status(204).send();
    } catch (error) {
      if (error instanceof WalletInUseError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  return router;
}
