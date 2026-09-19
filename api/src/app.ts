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
import { createDecisionsRouter } from "./decisions/routes.js";
import { createFundingRouter } from "./funding/routes.js";
import { createMockWalletRouter } from "./mockWallet/routes.js";
import { createPerpsRouter } from "./perps/routes.js";
import { createPositionsRouter } from "./positions/routes.js";

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

  if (deps.db && deps.pgPool) {
    app.use(
      "/perps",
      createPerpsRouter(
        deps.db,
        deps.hyperliquidClient ?? createHyperliquidClient(),
        deps.pgPool,
      ),
    );
  }

  if (deps.pgPool) {
    app.use("/mock-wallet", createMockWalletRouter(deps.pgPool));
    app.use("/positions", createPositionsRouter(deps.pgPool));
    app.use("/decisions", createDecisionsRouter(deps.pgPool));
    app.use("/funding", createFundingRouter(deps.pgPool));
  }

  return app;
}
