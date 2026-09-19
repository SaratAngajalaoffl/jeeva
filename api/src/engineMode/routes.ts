import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { getAllConfigs, updatePerpConfig } from "../perps/repository.js";
import { listWallets } from "../wallets/repository.js";
import { getEngineMode, setEngineMode, type EngineMode } from "./repository.js";

function isValidMode(value: unknown): value is EngineMode {
  return value === "mock" || value === "live";
}

/**
 * A market must never be left "enabled" against a real wallet while
 * live trading is disabled. When the engine mode switches to mock,
 * force-disable trading on any perp currently pointed at a live
 * wallet, rather than leaving it enabled but unable to execute.
 */
async function disableTradingOnLiveWallets(
  db: Db,
  pgPool: Pool,
): Promise<void> {
  const [configs, wallets] = await Promise.all([
    getAllConfigs(db),
    listWallets(pgPool),
  ]);
  const liveWalletIds = new Set(
    wallets.filter((w) => w.kind === "live").map((w) => w.id),
  );

  await Promise.all(
    configs
      .filter(
        (c) =>
          c.tradingEnabled && c.walletId && liveWalletIds.has(c.walletId),
      )
      .map((c) =>
        updatePerpConfig(db, c.symbol, { tradingEnabled: false }),
      ),
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
      await disableTradingOnLiveWallets(db, pgPool);
    }
    res.status(200).json({ mode: updated });
  });

  return router;
}
