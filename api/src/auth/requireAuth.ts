import type { NextFunction, Request, Response } from "express";
import { getAuthConfig, SESSION_COOKIE_NAME } from "./config.js";
import { verifySessionToken } from "./session.js";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token || !verifySessionToken(token, getAuthConfig().jwtSecret)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
