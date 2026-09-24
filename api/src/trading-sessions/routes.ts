import { Router } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { requireAuth } from "../auth/requireAuth.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { isValidFrequencySeconds } from "../perps/frequency.js";
import { updatePerpConfig } from "../perps/repository.js";
import { isValidLeverage, isValidPositionSizeUsd } from "../perps/sizing.js";
import { isWalletEligible } from "../wallets/eligibility.js";
import {
  isValidHistoryFormat,
  isValidHistoryWindowSamples,
} from "./historyWindow.js";
import { isValidStopLossPct } from "./stopLoss.js";
import {
  createTradingSession,
  getTradingSession,
  hardCloseTradingSession,
  listTradingSessions,
  setSessionWallet,
  softCloseTradingSession,
  updateTradingSessionConfig,
  WalletInUseError,
  type DecisionMaker,
} from "./repository.js";

const DECISION_MAKERS: readonly DecisionMaker[] = [
  "random",
  "typesafe",
  "openrouter",
];

function isValidDecisionMaker(value: unknown): value is DecisionMaker {
  return DECISION_MAKERS.includes(value as DecisionMaker);
}

export function createTradingSessionsRouter(
  db: Db,
  pgPool: Pool,
  hyperliquidClient: HyperliquidClient,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/perps/:symbol/trading-sessions", async (req, res) => {
    const rows = await listTradingSessions(pgPool, req.params.symbol);
    const sessions = rows.map(({ session, realizedPnlUsd }) => ({
      ...session,
      realizedPnlUsd,
    }));
    res.status(200).json({ sessions });
  });

  router.get("/trading-sessions", async (_req, res) => {
    const rows = await listTradingSessions(pgPool);
    const sessions = rows.map(({ session, realizedPnlUsd }) => ({
      ...session,
      realizedPnlUsd,
    }));
    res.status(200).json({ sessions });
  });

  router.post("/perps/:symbol/trading-sessions", async (req, res) => {
    const { symbol } = req.params;
    const {
      decisionMaker,
      decisionFrequencySeconds,
      leverage,
      positionSizeUsd,
      historyWindowSamples,
      historyFormat,
      storeDecisionPayloads,
      stopLossPct,
      walletId,
    } = req.body ?? {};

    if (
      !isValidDecisionMaker(decisionMaker) ||
      !isValidFrequencySeconds(decisionFrequencySeconds) ||
      !isValidLeverage(leverage) ||
      !isValidPositionSizeUsd(positionSizeUsd) ||
      (historyWindowSamples !== undefined &&
        !isValidHistoryWindowSamples(historyWindowSamples)) ||
      (historyFormat !== undefined && !isValidHistoryFormat(historyFormat)) ||
      (storeDecisionPayloads !== undefined &&
        typeof storeDecisionPayloads !== "boolean") ||
      (stopLossPct !== undefined &&
        stopLossPct !== null &&
        !isValidStopLossPct(stopLossPct)) ||
      (walletId !== undefined &&
        walletId !== null &&
        typeof walletId !== "string")
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const resolvedWalletId: string | null = walletId ?? null;
    if (
      resolvedWalletId &&
      !(await isWalletEligible(
        db,
        pgPool,
        hyperliquidClient,
        resolvedWalletId,
        positionSizeUsd,
      ))
    ) {
      res.status(400).json({
        error:
          "the selected wallet must match the current engine mode and have sufficient balance",
      });
      return;
    }

    try {
      const session = await createTradingSession(pgPool, {
        symbol,
        decisionMaker,
        decisionFrequencySeconds,
        leverage,
        positionSizeUsd,
        historyWindowSamples,
        historyFormat,
        storeDecisionPayloads,
        stopLossPct: stopLossPct ?? null,
        walletId: resolvedWalletId,
      });
      // A market can't be traded blind: enabling trading for it (by
      // opening a session) must also turn sampling on, so price history
      // is being collected for every market with an active session.
      await updatePerpConfig(db, symbol, { samplingEnabled: true });
      res.status(201).json(session);
    } catch (error) {
      if (error instanceof WalletInUseError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.get("/trading-sessions/:id", async (req, res) => {
    const session = await getTradingSession(pgPool, req.params.id);
    if (!session) {
      res.status(404).json({ error: "trading session not found" });
      return;
    }
    res.status(200).json(session);
  });

  router.patch("/trading-sessions/:id", async (req, res) => {
    const { id } = req.params;
    const {
      decisionMaker,
      decisionFrequencySeconds,
      leverage,
      positionSizeUsd,
      historyWindowSamples,
      historyFormat,
      storeDecisionPayloads,
      stopLossPct,
    } = req.body ?? {};

    if (
      (decisionMaker !== undefined && !isValidDecisionMaker(decisionMaker)) ||
      (decisionFrequencySeconds !== undefined &&
        !isValidFrequencySeconds(decisionFrequencySeconds)) ||
      (leverage !== undefined && !isValidLeverage(leverage)) ||
      (positionSizeUsd !== undefined &&
        !isValidPositionSizeUsd(positionSizeUsd)) ||
      (historyWindowSamples !== undefined &&
        !isValidHistoryWindowSamples(historyWindowSamples)) ||
      (historyFormat !== undefined && !isValidHistoryFormat(historyFormat)) ||
      (storeDecisionPayloads !== undefined &&
        typeof storeDecisionPayloads !== "boolean") ||
      (stopLossPct !== undefined &&
        stopLossPct !== null &&
        !isValidStopLossPct(stopLossPct))
    ) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const patch: Parameters<typeof updateTradingSessionConfig>[2] = {
      decisionMaker,
      decisionFrequencySeconds,
      leverage,
      positionSizeUsd,
      historyWindowSamples,
      historyFormat,
      storeDecisionPayloads,
    };
    // Only include `stopLossPct` in the patch when the caller sent it —
    // an omitted field must leave the existing stop-loss untouched,
    // while an explicit `null` clears it (see `mergeTradingSessionConfig`).
    if ("stopLossPct" in (req.body ?? {})) {
      patch.stopLossPct = stopLossPct ?? null;
    }

    const session = await updateTradingSessionConfig(pgPool, id, patch);
    if (!session) {
      res.status(404).json({ error: "trading session not found" });
      return;
    }
    res.status(200).json(session);
  });

  router.post("/trading-sessions/:id/attach-wallet", async (req, res) => {
    const { id } = req.params;
    const { walletId } = req.body ?? {};

    if (typeof walletId !== "string" || !walletId.trim()) {
      res.status(400).json({ error: "invalid request" });
      return;
    }

    const existing = await getTradingSession(pgPool, id);
    if (!existing) {
      res.status(404).json({ error: "trading session not found" });
      return;
    }

    if (
      !(await isWalletEligible(
        db,
        pgPool,
        hyperliquidClient,
        walletId,
        existing.positionSizeUsd,
      ))
    ) {
      res.status(400).json({
        error:
          "the selected wallet must match the current engine mode and have sufficient balance",
      });
      return;
    }

    try {
      const session = await setSessionWallet(pgPool, id, walletId);
      res.status(200).json(session);
    } catch (error) {
      if (error instanceof WalletInUseError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post("/trading-sessions/:id/detach-wallet", async (req, res) => {
    const session = await setSessionWallet(pgPool, req.params.id, null);
    if (!session) {
      res.status(404).json({ error: "trading session not found" });
      return;
    }
    res.status(200).json(session);
  });

  router.post("/trading-sessions/:id/soft-close", async (req, res) => {
    const session = await softCloseTradingSession(pgPool, req.params.id);
    if (!session) {
      res.status(409).json({
        error: "trading session not found or not in a closable state",
      });
      return;
    }
    res.status(200).json(session);
  });

  router.post("/trading-sessions/:id/hard-close", async (req, res) => {
    const session = await hardCloseTradingSession(pgPool, req.params.id);
    if (!session) {
      res.status(409).json({
        error: "trading session not found or not in a closable state",
      });
      return;
    }
    res.status(200).json(session);
  });

  return router;
}
