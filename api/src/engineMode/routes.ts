import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { getEngineMode, setEngineMode, type EngineMode } from "./repository.js";
import { getLiveWalletPublicAddress } from "./walletRepository.js";

function isValidMode(value: unknown): value is EngineMode {
  return value === "mock" || value === "live";
}

export function createEngineModeRouter(db: Db, pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const [mode, liveWalletPublicAddress] = await Promise.all([
      getEngineMode(db),
      getLiveWalletPublicAddress(pgPool),
    ]);
    res.status(200).json({ mode, liveWalletPublicAddress });
  });

  router.put("/", async (req, res) => {
    const { mode } = req.body ?? {};

    if (!isValidMode(mode)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const updated = await setEngineMode(db, mode);
    res.status(200).json({ mode: updated });
  });

  return router;
}
