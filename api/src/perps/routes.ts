import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { getMarketDataHistory } from "../marketData/repository.js";
import { parseTimeRange } from "../marketData/timeRange.js";
import { isValidFrequencySeconds } from "./frequency.js";
import {
  DEFAULT_PERP_CONFIG,
  getAllConfigs,
  updatePerpConfig,
  type DecisionMaker,
} from "./repository.js";

const DECISION_MAKERS: readonly DecisionMaker[] = [
  "fake",
  "typesafe",
  "openrouter",
];
import { isValidLeverage, isValidPositionSizeUsd } from "./sizing.js";

export function createPerpsRouter(
  db: Db,
  hyperliquidClient: HyperliquidClient,
  pgPool: Pool,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (_req, res) => {
    const [perps, configs] = await Promise.all([
      hyperliquidClient.listPerps(),
      getAllConfigs(db),
    ]);

    const configBySymbol = new Map(configs.map((c) => [c.symbol, c]));
    const merged = perps.map(({ symbol }) => {
      const config = configBySymbol.get(symbol);
      return {
        symbol,
        tradingEnabled:
          config?.tradingEnabled ?? DEFAULT_PERP_CONFIG.tradingEnabled,
        samplingEnabled:
          config?.samplingEnabled ?? DEFAULT_PERP_CONFIG.samplingEnabled,
        decisionFrequencySeconds:
          config?.decisionFrequencySeconds ??
          DEFAULT_PERP_CONFIG.decisionFrequencySeconds,
        samplingFrequencySeconds:
          config?.samplingFrequencySeconds ??
          DEFAULT_PERP_CONFIG.samplingFrequencySeconds,
        leverage: config?.leverage ?? DEFAULT_PERP_CONFIG.leverage,
        positionSizeUsd:
          config?.positionSizeUsd ?? DEFAULT_PERP_CONFIG.positionSizeUsd,
        decisionMaker:
          config?.decisionMaker ?? DEFAULT_PERP_CONFIG.decisionMaker,
      };
    });

    res.status(200).json({ perps: merged });
  });

  router.get("/stats", async (_req, res) => {
    const stats = await hyperliquidClient.listPerpStats();
    res.status(200).json({ stats });
  });

  router.patch("/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const {
      tradingEnabled,
      samplingEnabled,
      decisionFrequencySeconds,
      samplingFrequencySeconds,
      leverage,
      positionSizeUsd,
      decisionMaker,
    } = req.body ?? {};

    const isValidToggle = (value: unknown) =>
      value === undefined || typeof value === "boolean";
    const isValidFrequency = (value: unknown) =>
      value === undefined || isValidFrequencySeconds(value);
    const isValidDecisionMaker = (value: unknown) =>
      value === undefined ||
      DECISION_MAKERS.includes(value as DecisionMaker);

    if (
      !isValidToggle(tradingEnabled) ||
      !isValidToggle(samplingEnabled) ||
      !isValidFrequency(decisionFrequencySeconds) ||
      !isValidFrequency(samplingFrequencySeconds) ||
      (leverage !== undefined && !isValidLeverage(leverage)) ||
      (positionSizeUsd !== undefined &&
        !isValidPositionSizeUsd(positionSizeUsd)) ||
      !isValidDecisionMaker(decisionMaker)
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const updated = await updatePerpConfig(db, symbol, {
      tradingEnabled,
      samplingEnabled,
      decisionFrequencySeconds,
      samplingFrequencySeconds,
      leverage,
      positionSizeUsd,
      decisionMaker,
    });
    res.status(200).json(updated);
  });

  router.get("/:symbol/market-data", async (req, res) => {
    const { symbol } = req.params;
    const range = parseTimeRange(req.query);

    if (!range) {
      res.status(400).json({ error: "invalid time range" });
      return;
    }

    const samples = await getMarketDataHistory(
      pgPool,
      symbol,
      range.from,
      range.to,
    );
    res.status(200).json({ samples });
  });

  router.get("/:symbol/orderbook", async (req, res) => {
    const { symbol } = req.params;
    const book = await hyperliquidClient.getOrderBook(symbol);
    res.status(200).json(book);
  });

  router.get("/:symbol/trades", async (req, res) => {
    const { symbol } = req.params;
    const trades = await hyperliquidClient.getRecentTrades(symbol);
    res.status(200).json({ trades });
  });

  return router;
}
