import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { getOpenPositions } from "./repository.js";

export function createPositionsRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const positions = await getOpenPositions(pgPool);
    res.status(200).json({ positions });
  });

  return router;
}
