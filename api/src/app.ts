import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import { authRouter } from "./auth/authRoutes.js";

export function createApp(): Express {
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

  return app;
}
