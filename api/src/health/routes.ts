import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { getPerpHealth } from "./repository.js";

export function createPerpHealthRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const health = await getPerpHealth(pgPool);
    res.status(200).json({ health });
  });

  return router;
}
