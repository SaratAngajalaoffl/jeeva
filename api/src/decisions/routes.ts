import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { parseTimeRange } from "../marketData/timeRange.js";
import {
  countDecisions,
  getDecisionHistory,
  type DecisionHistoryFilter,
  type DecisionSortField,
  type SortOrder,
} from "./repository.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

const DIRECTIONS = ["long", "short", "flat"] as const;
const ACTIONS = ["no_op", "opened", "closed", "closed_and_opened"] as const;
const SORT_FIELDS: readonly DecisionSortField[] = ["time", "confidence"];
const SORT_ORDERS: readonly SortOrder[] = ["asc", "desc"];

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined | null {
  if (value === undefined) return undefined;
  return allowed.includes(value as T) ? (value as T) : null;
}

/** Parses an optional query number; null when present but not within [min, max]. */
function parseNumber(
  value: unknown,
  min: number,
  max: number,
  integer = false,
): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  if (integer && !Number.isInteger(parsed)) return null;
  return parsed;
}

export function createDecisionsRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req, res) => {
    const range = parseTimeRange(req.query);
    if (!range) {
      res.status(400).json({ error: "invalid time range" });
      return;
    }

    const { symbol, sessionId } = req.query;
    if (symbol !== undefined && typeof symbol !== "string") {
      res.status(400).json({ error: "invalid symbol" });
      return;
    }
    if (sessionId !== undefined && typeof sessionId !== "string") {
      res.status(400).json({ error: "invalid sessionId" });
      return;
    }

    const targetDirection = oneOf(req.query.direction, DIRECTIONS);
    if (targetDirection === null) {
      res.status(400).json({ error: "invalid direction" });
      return;
    }
    const positionAction = oneOf(req.query.action, ACTIONS);
    if (positionAction === null) {
      res.status(400).json({ error: "invalid action" });
      return;
    }
    const status = oneOf(req.query.status, ["ok", "error"] as const);
    if (status === null) {
      res.status(400).json({ error: "invalid status" });
      return;
    }
    const minConfidence = parseNumber(req.query.minConfidence, 0, 1);
    const maxConfidence = parseNumber(req.query.maxConfidence, 0, 1);
    if (
      minConfidence === null ||
      maxConfidence === null ||
      (minConfidence !== undefined &&
        maxConfidence !== undefined &&
        minConfidence > maxConfidence)
    ) {
      res.status(400).json({ error: "invalid confidence range" });
      return;
    }
    const sort = oneOf(req.query.sort, SORT_FIELDS);
    if (sort === null) {
      res.status(400).json({ error: "invalid sort" });
      return;
    }
    const order = oneOf(req.query.order, SORT_ORDERS);
    if (order === null) {
      res.status(400).json({ error: "invalid order" });
      return;
    }

    const limit = parseNumber(req.query.limit, 1, MAX_LIMIT, true);
    if (limit === null) {
      res.status(400).json({ error: "invalid limit" });
      return;
    }
    const offset = parseNumber(
      req.query.offset,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    );
    if (offset === null) {
      res.status(400).json({ error: "invalid offset" });
      return;
    }

    const filter: DecisionHistoryFilter = {
      symbol,
      sessionId,
      targetDirection,
      positionAction,
      success: status === undefined ? undefined : status === "ok",
      minConfidence,
      maxConfidence,
      from: range.from,
      to: range.to,
    };
    const [decisions, total] = await Promise.all([
      getDecisionHistory(pgPool, {
        ...filter,
        limit: limit ?? DEFAULT_LIMIT,
        offset,
        sort,
        order,
      }),
      countDecisions(pgPool, filter),
    ]);
    res.status(200).json({ decisions, total });
  });

  return router;
}
