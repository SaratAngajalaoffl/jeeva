import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import type { Db } from "mongodb";
import { authRouter } from "./auth/authRoutes.js";
import {
  createHyperliquidClient,
  type HyperliquidClient,
} from "./hyperliquid/client.js";
import { createPerpsRouter } from "./perps/routes.js";

export interface AppDeps {
  db?: Db;
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

  if (deps.db) {
    app.use(
      "/perps",
      createPerpsRouter(
        deps.db,
        deps.hyperliquidClient ?? createHyperliquidClient(),
      ),
    );
  }

  return app;
}
