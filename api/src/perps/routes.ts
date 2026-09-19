import { Router } from "express";
import type { Db } from "mongodb";
import { requireAuth } from "../auth/requireAuth.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { getAllConfigs, updateToggles } from "./repository.js";

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
        tradingEnabled: config?.tradingEnabled ?? false,
        samplingEnabled: config?.samplingEnabled ?? false,
      };
    });

    res.status(200).json({ perps: merged });
  });

  router.patch("/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const { tradingEnabled, samplingEnabled } = req.body ?? {};

    const isValid = (value: unknown) =>
      value === undefined || typeof value === "boolean";

    if (!isValid(tradingEnabled) || !isValid(samplingEnabled)) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const updated = await updateToggles(db, symbol, {
      tradingEnabled,
      samplingEnabled,
    });
    res.status(200).json(updated);
  });

  return router;
}
