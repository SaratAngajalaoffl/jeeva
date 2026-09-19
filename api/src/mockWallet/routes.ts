import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { isValidInitialBalanceUsd } from "./balance.js";
import {
  createMockWallet,
  getMockWallet,
  MockWalletAlreadyExistsError,
} from "./repository.js";

export function createMockWalletRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const wallet = await getMockWallet(pgPool);
    if (!wallet) {
      res.status(404).json({ error: "no mock wallet exists yet" });
      return;
    }
    res.status(200).json(wallet);
  });

  router.post("/", async (req, res) => {
    const { initialBalanceUsd } = req.body ?? {};

    if (!isValidInitialBalanceUsd(initialBalanceUsd)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    try {
      const wallet = await createMockWallet(pgPool, initialBalanceUsd);
      res.status(201).json(wallet);
    } catch (error) {
      if (error instanceof MockWalletAlreadyExistsError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  return router;
}
