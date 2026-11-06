import cookieParser from "cookie-parser";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Express,
} from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { authRouter } from "./auth/authRoutes.js";
import { getAuthConfig } from "./auth/config.js";
import { createBacktestsRouter } from "./backtests/routes.js";
import { createCachedHyperliquidClient } from "./hyperliquid/cache.js";
import {
  createHyperliquidClient,
  HyperliquidRateLimitError,
  type HyperliquidClient,
} from "./hyperliquid/client.js";
import { createDecisionMakersRouter } from "./decisionMakers/routes.js";
import { createDecisionsRouter } from "./decisions/routes.js";
import { isDemoMode } from "./engineMode/demoMode.js";
import { createEngineModeRouter } from "./engineMode/routes.js";
import { createFundingRouter } from "./funding/routes.js";
import { createPerpHealthRouter } from "./health/routes.js";
import { createPerpsRouter } from "./perps/routes.js";
import { createPositionsRouter } from "./positions/routes.js";
import { createTradesRouter } from "./trades/routes.js";
import { createTradingSessionsRouter } from "./trading-sessions/routes.js";
import { createWalletsRouter } from "./wallets/routes.js";

export interface AppDeps {
  db?: Db;
  pgPool?: Pool;
  hyperliquidClient?: HyperliquidClient;
}

/**
 * Origins allowed to make credentialed requests. CORS_ORIGIN accepts a
 * single origin or a comma-separated list, since one deployment can
 * serve several dashboard instances on different origins.
 */
function allowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();

  app.use(
    cors({
      origin: allowedOrigins(),
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    if (!isDemoMode()) {
      res.status(200).json({ status: "ok", demoMode: false });
      return;
    }
    // Demo deployments are public showcases, so the login page shows
    // the shared credentials. Never exposed outside demo mode.
    const { username, password } = getAuthConfig();
    res.status(200).json({
      status: "ok",
      demoMode: true,
      demoCredentials: { username, password },
    });
  });

  app.use("/auth", authRouter);
  app.use("/decision-makers", createDecisionMakersRouter());

  if (deps.db && deps.pgPool) {
    const hyperliquidClient =
      deps.hyperliquidClient ??
      createCachedHyperliquidClient(createHyperliquidClient());
    app.use(
      "/perps",
      createPerpsRouter(deps.db, hyperliquidClient, deps.pgPool),
    );
    app.use("/engine-mode", createEngineModeRouter(deps.db, deps.pgPool));
    app.use(
      "/wallets",
      createWalletsRouter(deps.db, deps.pgPool, hyperliquidClient),
    );
    app.use(
      createTradingSessionsRouter(deps.db, deps.pgPool, hyperliquidClient),
    );
  }

  if (deps.pgPool) {
    app.use("/positions", createPositionsRouter(deps.pgPool));
    app.use("/decisions", createDecisionsRouter(deps.pgPool));
    app.use("/funding", createFundingRouter(deps.pgPool));
    app.use("/perp-health", createPerpHealthRouter(deps.pgPool));
    app.use("/trades", createTradesRouter(deps.pgPool));
    app.use(createBacktestsRouter(deps.pgPool));
  }

  // Express 4 does not forward a rejected async handler to the error
  // middleware, and an unhandled rejection takes the process down. No
  // single request — a bad symbol, a transient upstream failure — may be
  // allowed to kill the server, so route every rejection to a response.
  const handleError: ErrorRequestHandler = (error, _req, res, next) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("unhandled request error:", message);
    if (res.headersSent) {
      // Too late to shape a response; let Express's own handler finish.
      next(error);
      return;
    }
    if (error instanceof HyperliquidRateLimitError) {
      // Hyperliquid's limit is a rolling per-minute window, so a short
      // retry hint is enough for the dashboard to recover on its own.
      res.set("Retry-After", "30");
      res.status(503).json({ error: "upstream rate limited" });
      return;
    }
    res.status(500).json({ error: "internal server error" });
  };
  app.use(handleError);

  return app;
}
