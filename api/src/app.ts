import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import type { Db } from "mongodb";
import type { Pool } from "pg";
import { authRouter } from "./auth/authRoutes.js";
import {
  createHyperliquidClient,
  type HyperliquidClient,
} from "./hyperliquid/client.js";
import { createDecisionMakersRouter } from "./decisionMakers/routes.js";
import { createDecisionsRouter } from "./decisions/routes.js";
import { createEngineModeRouter } from "./engineMode/routes.js";
import { createFundingRouter } from "./funding/routes.js";
import { createPerpHealthRouter } from "./health/routes.js";
import { createPerpsRouter } from "./perps/routes.js";
import { createPositionsRouter } from "./positions/routes.js";
import { createWalletsRouter } from "./wallets/routes.js";

export interface AppDeps {
  db?: Db;
  pgPool?: Pool;
  hyperliquidClient?: HyperliquidClient;
}

export function createApp(deps: AppDeps = {}): Express {
  const app = express();

  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
      credentials: true,
    }),
  );
  app.use(express.json());
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/auth", authRouter);
  app.use("/decision-makers", createDecisionMakersRouter());

  if (deps.db && deps.pgPool) {
    const hyperliquidClient = deps.hyperliquidClient ?? createHyperliquidClient();
    app.use(
      "/perps",
      createPerpsRouter(deps.db, hyperliquidClient, deps.pgPool),
    );
    app.use("/engine-mode", createEngineModeRouter(deps.db, deps.pgPool));
    app.use(
      "/wallets",
      createWalletsRouter(deps.db, deps.pgPool, hyperliquidClient),
    );
  }

  if (deps.pgPool) {
    app.use("/positions", createPositionsRouter(deps.pgPool));
    app.use("/decisions", createDecisionsRouter(deps.pgPool));
    app.use("/funding", createFundingRouter(deps.pgPool));
    app.use("/perp-health", createPerpHealthRouter(deps.pgPool));
  }

  return app;
}
