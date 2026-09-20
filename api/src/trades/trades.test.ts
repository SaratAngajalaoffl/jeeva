import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

const pgPool = new Pool({ connectionString: DATABASE_URL });

afterAll(async () => {
  await pgPool.end();
});

beforeEach(async () => {
  await pgPool.query("DELETE FROM trade_history");
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ pgPool });
}

async function seed(
  symbol: string,
  closedAt: Date,
  direction: "long" | "short",
) {
  await pgPool.query(
    `INSERT INTO trade_history
       (session_id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd, closed_at)
     VALUES (gen_random_uuid(), $1, $2, 65000, 1000, $3, 65500, 7.69, $3)`,
    [symbol, direction, closedAt],
  );
}

describe("GET /trades/history", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/trades/history");
    expect(res.status).toBe(401);
  });

  it("returns closed trades within the default 24h range, newest first", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await seed("BTC", twoHoursAgo, "long");
    await seed("BTC", oneHourAgo, "short");

    const res = await request(buildApp())
      .get("/trades/history")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(2);
    expect(new Date(res.body.trades[0].closedAt).getTime()).toBeGreaterThan(
      new Date(res.body.trades[1].closedAt).getTime(),
    );
  });

  it("filters by symbol and includes entry/exit price and pnl detail", async () => {
    const now = new Date();
    await seed("BTC", now, "long");
    await seed("ETH", now, "short");

    const res = await request(buildApp())
      .get("/trades/history?symbol=BTC")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.trades).toHaveLength(1);
    expect(res.body.trades[0]).toMatchObject({
      symbol: "BTC",
      direction: "long",
      entryPrice: 65000,
      exitPrice: 65500,
      pnlUsd: 7.69,
    });
  });

  it("rejects an invalid time range", async () => {
    const res = await request(buildApp())
      .get("/trades/history?from=not-a-date")
      .set("Cookie", authCookie());
    expect(res.status).toBe(400);
  });
});
