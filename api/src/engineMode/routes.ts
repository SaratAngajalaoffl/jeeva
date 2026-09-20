import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import {
  hardCloseTradingSession,
  listTradingSessions,
} from "../trading-sessions/repository.js";
import { listWallets } from "../wallets/repository.js";
import { getEngineMode, setEngineMode, type EngineMode } from "./repository.js";

function isValidMode(value: unknown): value is EngineMode {
  return value === "mock" || value === "live";
}

/**
 * A trading session must never be left running against a real wallet
 * while live trading is disabled. When the engine mode switches to
 * mock, force-close any non-closed session currently attached to a
 * live wallet, rather than leaving it running but unable to execute.
 */
async function closeSessionsOnLiveWallets(pgPool: Pool): Promise<void> {
  const [sessions, wallets] = await Promise.all([
    listTradingSessions(pgPool),
    listWallets(pgPool),
  ]);
  const liveWalletIds = new Set(
    wallets.filter((w) => w.kind === "live").map((w) => w.id),
  );

  await Promise.all(
    sessions
      .filter(
        (s) =>
          s.status !== "closed" &&
          s.walletId &&
          liveWalletIds.has(s.walletId),
      )
      .map((s) => hardCloseTradingSession(pgPool, s.id)),
  );
}

export function createEngineModeRouter(db: Db, pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const mode = await getEngineMode(db);
    res.status(200).json({ mode });
  });

  router.put("/", async (req, res) => {
    const { mode } = req.body ?? {};

    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const updated = await setEngineMode(db, mode);
    if (updated === "mock") {
      await closeSessionsOnLiveWallets(pgPool);
    }
    res.status(200).json({ mode: updated });
  });

  return router;
}
