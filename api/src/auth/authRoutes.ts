import { Router } from "express";
import {
  getAuthConfig,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
} from "./config.js";
import { credentialsMatch } from "./credentials.js";
import { signSessionToken } from "./session.js";
import { requireAuth } from "./requireAuth.js";

export const authRouter = Router();

authRouter.post("/login", (req, res) => {
  const { username, password } = req.body ?? {};

  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "invalid request" });
    return;
  }

  const config = getAuthConfig();
  const matches = credentialsMatch(
    { username, password },
    { username: config.username, password: config.password },
  );

  if (!matches) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }

  const token = signSessionToken(config.jwtSecret);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
  res.status(200).json({ authenticated: true });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie(SESSION_COOKIE_NAME);
  res.status(200).json({ authenticated: false });
});

authRouter.get("/session", requireAuth, (_req, res) => {
  res.status(200).json({ authenticated: true });
});
