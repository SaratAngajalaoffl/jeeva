import { Router } from "express";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import { isValidFrequencySeconds } from "../perps/frequency.js";
import { isValidLeverage, isValidPositionSizeUsd } from "../perps/sizing.js";
import {
  DEFAULT_HISTORY_FORMAT,
  DEFAULT_HISTORY_WINDOW_SAMPLES,
  isValidHistoryFormat,
  isValidHistoryWindowSamples,
} from "../trading-sessions/historyWindow.js";
import type { DecisionMaker } from "../trading-sessions/repository.js";
import {
  createBacktestRun,
  earliestMarketDataTime,
  getBacktestRun,
  getBacktestPosition,
  listBacktestDecisions,
  listBacktestRuns,
  listBacktestTrades,
} from "./repository.js";

const DECISION_MAKERS: readonly DecisionMaker[] = [
  "random",
  "typesafe",
  "openrouter",
];

function isValidDecisionMaker(value: unknown): value is DecisionMaker {
  return DECISION_MAKERS.includes(value as DecisionMaker);
}

function isValidIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isValidInitialBalance(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createBacktestsRouter(pgPool: Pool): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/perps/:symbol/backtests", async (req, res) => {
    const runs = await listBacktestRuns(pgPool, req.params.symbol);
    res.status(200).json({ backtests: runs });
  });

  router.get("/backtests", async (_req, res) => {
    const runs = await listBacktestRuns(pgPool);
    res.status(200).json({ backtests: runs });
  });

  router.post("/perps/:symbol/backtests", async (req, res) => {
    const { symbol } = req.params;
    const {
      decisionMaker,
      decisionFrequencySeconds,
      leverage,
      positionSizeUsd,
      historyWindowSamples,
      historyFormat,
      startTime,
      endTime,
      initialBalanceUsd,
    } = req.body ?? {};

    if (
      !isValidDecisionMaker(decisionMaker) ||
      !isValidFrequencySeconds(decisionFrequencySeconds) ||
      !isValidLeverage(leverage) ||
      !isValidPositionSizeUsd(positionSizeUsd) ||
      (historyWindowSamples !== undefined &&
        !isValidHistoryWindowSamples(historyWindowSamples)) ||
      (historyFormat !== undefined && !isValidHistoryFormat(historyFormat)) ||
      !isValidIsoDate(startTime) ||
      !isValidIsoDate(endTime) ||
      !isValidInitialBalance(initialBalanceUsd)
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const start = new Date(startTime);
    const end = new Date(endTime);
    const now = new Date();

    if (end <= start) {
      res.status(400).json({ error: "endTime must be after startTime" });
      return;
    }
    if (end > now) {
      res.status(400).json({ error: "endTime cannot be in the future" });
      return;
    }

    const earliest = await earliestMarketDataTime(pgPool, symbol);
    if (!earliest || start < new Date(earliest)) {
      res.status(400).json({
        error: earliest
          ? `startTime predates the oldest available market data for ${symbol} (${earliest})`
          : `no market data available for ${symbol} yet`,
      });
      return;
    }

    const run = await createBacktestRun(pgPool, {
      symbol,
      decisionMaker,
      decisionFrequencySeconds,
      leverage,
      positionSizeUsd,
      historyWindowSamples: historyWindowSamples ?? DEFAULT_HISTORY_WINDOW_SAMPLES,
      historyFormat: historyFormat ?? DEFAULT_HISTORY_FORMAT,
      startTime,
      endTime,
      initialBalanceUsd,
    });
    res.status(201).json(run);
  });

  router.get("/backtests/:id", async (req, res) => {
    const run = await getBacktestRun(pgPool, req.params.id);
    if (!run) {
      res.status(404).json({ error: "backtest not found" });
      return;
    }
    res.status(200).json(run);
  });

  router.get("/backtests/:id/decisions", async (req, res) => {
    const run = await getBacktestRun(pgPool, req.params.id);
    if (!run) {
      res.status(404).json({ error: "backtest not found" });
      return;
    }
    const decisions = await listBacktestDecisions(pgPool, req.params.id);
    res.status(200).json({ decisions });
  });

  router.get("/backtests/:id/position", async (req, res) => {
    const run = await getBacktestRun(pgPool, req.params.id);
    if (!run) {
      res.status(404).json({ error: "backtest not found" });
      return;
    }
    const position = await getBacktestPosition(pgPool, req.params.id);
    res.status(200).json({ position });
  });

  router.get("/backtests/:id/trades", async (req, res) => {
    const run = await getBacktestRun(pgPool, req.params.id);
    if (!run) {
      res.status(404).json({ error: "backtest not found" });
      return;
    }
    const trades = await listBacktestTrades(pgPool, req.params.id);
    res.status(200).json({ trades });
  });

  return router;
}
