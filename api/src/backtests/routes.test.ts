import type { Pool } from "pg";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";

function authCookie(): string {
  return `${SESSION_COOKIE_NAME}=${signSessionToken(process.env.JWT_SECRET!)}`;
}

function backtestBody(overrides = {}) {
  return {
    decisionMaker: "random",
    decisionFrequencySeconds: 300,
    leverage: 1,
    positionSizeUsd: 100,
    startTime: "2026-09-21T00:00:00.000Z",
    endTime: "2026-09-21T18:00:00.000Z",
    initialBalanceUsd: 10000,
    ...overrides,
  };
}

describe("POST /perps/:symbol/backtests market-data range", () => {
  it("returns the earliest valid start separately for the local error", async () => {
    const earliest = new Date("2026-09-20T21:19:00.432Z");
    const latest = new Date("2026-09-21T18:04:12.789Z");
    const query = vi.fn().mockResolvedValue({ rows: [{ earliest, latest }] });
    const app = createApp({ pgPool: { query } as unknown as Pool });

    const res = await request(app)
      .post("/perps/HYPE/backtests")
      .set("Cookie", authCookie())
      .send(backtestBody({ startTime: "2026-09-20T20:00:00.000Z" }));

    expect(res.status).toBe(400);
    expect(res.body.earliestStart).toBe(earliest.toISOString());
  });

  it("rejects an end after the newest sample", async () => {
    const earliest = new Date("2026-09-20T21:19:00.432Z");
    const latest = new Date("2026-09-21T18:04:12.789Z");
    const query = vi.fn().mockResolvedValue({ rows: [{ earliest, latest }] });
    const app = createApp({ pgPool: { query } as unknown as Pool });

    const res = await request(app)
      .post("/perps/HYPE/backtests")
      .set("Cookie", authCookie())
      .send(backtestBody({ endTime: "2026-09-21T19:00:00.000Z" }));

    expect(res.status).toBe(400);
    expect(res.body.latestEnd).toBe(latest.toISOString());
  });
});
