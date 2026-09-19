import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { parseTimeRange } from "../marketData/timeRange.js";
import { getDecisionHistory } from "./repository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export function createDecisionsRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const range = parseTimeRange(req.query);
    if (!range) {
      res.status(400).json({ error: "invalid time range" });
      return;
    }

    const { symbol, limit: rawLimit } = req.query;
    if (symbol !== undefined && typeof symbol !== "string") {
      res.status(400).json({ error: "invalid symbol" });
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        res.status(400).json({ error: "invalid limit" });
        return;
      }
      limit = parsed;
    }

    const decisions = await getDecisionHistory(pgPool, {
      symbol,
      from: range.from,
      to: range.to,
      limit,
    });
    res.status(200).json({ decisions });
  });

  return router;
}
