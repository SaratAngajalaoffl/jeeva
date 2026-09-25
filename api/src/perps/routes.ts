import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import {
  getMarketDataHistory,
  getMarketDataRange,
} from "../marketData/repository.js";
import { parseTimeRange } from "../marketData/timeRange.js";
import { isValidSamplingFrequencySeconds } from "./frequency.js";
import {
  DEFAULT_PERP_CONFIG,
  getAllConfigs,
  updatePerpConfig,
} from "./repository.js";

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
        samplingEnabled:
          config?.samplingEnabled ?? DEFAULT_PERP_CONFIG.samplingEnabled,
        samplingFrequencySeconds:
          config?.samplingFrequencySeconds ??
          DEFAULT_PERP_CONFIG.samplingFrequencySeconds,
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
    const { samplingEnabled, samplingFrequencySeconds } = req.body ?? {};

    const isValidToggle = (value: unknown) =>
      value === undefined || typeof value === "boolean";
    const isValidFrequency = (value: unknown) =>
      value === undefined || isValidSamplingFrequencySeconds(value);

    if (
      !isValidToggle(samplingEnabled) ||
      !isValidFrequency(samplingFrequencySeconds)
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const updated = await updatePerpConfig(db, symbol, {
      samplingEnabled,
      samplingFrequencySeconds,
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

    const [samples, marketDataRange] = await Promise.all([
      getMarketDataHistory(pgPool, symbol, range.from, range.to),
      getMarketDataRange(pgPool, symbol),
    ]);
    res.status(200).json({
      samples,
      // Lets the frontend disable periods that reach back before any
      // recorded data for this symbol.
      oldestSampleTime: marketDataRange.earliest?.toISOString() ?? null,
    });
  });

  router.get("/:symbol/market-data/range", async (req, res) => {
    const range = await getMarketDataRange(pgPool, req.params.symbol);
    res.status(200).json({
      earliest: range.earliest?.toISOString() ?? null,
      latest: range.latest?.toISOString() ?? null,
    });
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
