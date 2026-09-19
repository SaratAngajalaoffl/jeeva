import jwt from "jsonwebtoken";
import { SESSION_TTL_SECONDS } from "./config.js";

const SESSION_SUBJECT = "operator";

export function signSessionToken(secret: string): string {
  return jwt.sign({ sub: SESSION_SUBJECT }, secret, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

export function verifySessionToken(token: string, secret: string): boolean {
  try {
    const payload = jwt.verify(token, secret);
    return typeof payload === "object" && payload.sub === SESSION_SUBJECT;
  } catch {
    return false;
  }
}
