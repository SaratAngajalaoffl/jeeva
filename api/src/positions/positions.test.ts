import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

const pgPool = new Pool({ connectionString: DATABASE_URL });

beforeAll(async () => {
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS mock_positions (
       symbol TEXT PRIMARY KEY,
       direction TEXT NOT NULL,
       entry_price DOUBLE PRECISION NOT NULL,
       notional_usd DOUBLE PRECISION NOT NULL,
       opened_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
});

afterAll(async () => {
  await pgPool.end();
});

beforeEach(async () => {
  await pgPool.query("DELETE FROM mock_positions");
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ pgPool });
}

describe("GET /positions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/positions");
    expect(res.status).toBe(401);
  });

  it("returns an empty list when everything is flat", async () => {
    const res = await request(buildApp())
      .get("/positions")
      .set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.positions).toEqual([]);
  });

  it("returns open positions with their direction, entry price, and notional", async () => {
    await pgPool.query(
      "INSERT INTO mock_positions (symbol, direction, entry_price, notional_usd) VALUES ($1, $2, $3, $4)",
      ["BTC", "long", 65000, 1000],
    );
    await pgPool.query(
      "INSERT INTO mock_positions (symbol, direction, entry_price, notional_usd) VALUES ($1, $2, $3, $4)",
      ["ETH", "short", 3000, 500],
    );

    const res = await request(buildApp())
      .get("/positions")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.positions).toHaveLength(2);
    expect(res.body.positions).toContainEqual(
      expect.objectContaining({
        symbol: "BTC",
        direction: "long",
        entryPrice: 65000,
        notionalUsd: 1000,
      }),
    );
    expect(res.body.positions).toContainEqual(
      expect.objectContaining({
        symbol: "ETH",
        direction: "short",
        entryPrice: 3000,
        notionalUsd: 500,
      }),
    );
  });
});
