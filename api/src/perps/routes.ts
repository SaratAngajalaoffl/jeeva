import { Router } from "express";
import type { Db } from "mongodb";
import { requireAuth } from "../auth/requireAuth.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { isValidFrequencySeconds } from "./frequency.js";
import {
  DEFAULT_PERP_CONFIG,
  getAllConfigs,
  updatePerpConfig,
} from "./repository.js";
import { isValidLeverage, isValidPositionSizeUsd } from "./sizing.js";

export function createPerpsRouter(
  db: Db,
  hyperliquidClient: HyperliquidClient,
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
      };
    });

    res.status(200).json({ perps: merged });
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
    } = req.body ?? {};

    const isValidToggle = (value: unknown) =>
      value === undefined || typeof value === "boolean";
    const isValidFrequency = (value: unknown) =>
      value === undefined || isValidFrequencySeconds(value);

    if (
      !isValidToggle(tradingEnabled) ||
      !isValidToggle(samplingEnabled) ||
      !isValidFrequency(decisionFrequencySeconds) ||
      !isValidFrequency(samplingFrequencySeconds) ||
      (leverage !== undefined && !isValidLeverage(leverage)) ||
      (positionSizeUsd !== undefined &&
        !isValidPositionSizeUsd(positionSizeUsd))
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
    });
    res.status(200).json(updated);
  });

  return router;
}
