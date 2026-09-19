import { MongoClient, type Db } from "mongodb";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";

const MONGO_URL =
  process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/jeeva_test";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

const mongoClient = new MongoClient(MONGO_URL);
await mongoClient.connect();
const db: Db = mongoClient.db();
const pgPool = new Pool({ connectionString: DATABASE_URL });

const fakeHyperliquidClient: HyperliquidClient = {
  async listPerps() {
    return [{ symbol: "BTC" }];
  },
};

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ db, pgPool, hyperliquidClient: fakeHyperliquidClient });
}

beforeAll(async () => {
  // Mirrors the engine's migration (api/tests run independently of
  // whether the engine has started and migrated yet).
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS market_data (
       time TIMESTAMPTZ NOT NULL,
       symbol TEXT NOT NULL,
       price DOUBLE PRECISION NOT NULL,
       open_interest DOUBLE PRECISION NOT NULL,
       volume DOUBLE PRECISION NOT NULL,
       spread DOUBLE PRECISION NOT NULL,
       mid_price DOUBLE PRECISION NOT NULL
     )`,
  );
});

afterAll(async () => {
  await mongoClient.close();
  await pgPool.end();
});

beforeEach(async () => {
  await pgPool.query("DELETE FROM market_data");
});

async function seed(symbol: string, time: Date, overrides = {}) {
  const row = {
    price: 100,
    open_interest: 10,
    volume: 1000,
    spread: 0.5,
    mid_price: 100.25,
    ...overrides,
  };
  await pgPool.query(
    `INSERT INTO market_data (time, symbol, price, open_interest, volume, spread, mid_price)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      time,
      symbol,
      row.price,
      row.open_interest,
      row.volume,
      row.spread,
      row.mid_price,
    ],
  );
}

describe("GET /perps/:symbol/market-data", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/perps/BTC/market-data");
    expect(res.status).toBe(401);
  });

  it("returns seeded samples within the default 24h range, ordered by time", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await seed("BTC", twoHoursAgo, { price: 100 });
    await seed("BTC", oneHourAgo, { price: 200 });

    const res = await request(buildApp())
      .get("/perps/BTC/market-data")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(2);
    expect(res.body.samples[0].price).toBe(100);
    expect(res.body.samples[1].price).toBe(200);
    expect(res.body.samples[0]).toMatchObject({
      openInterest: 10,
      volume: 1000,
      spread: 0.5,
      midPrice: 100.25,
    });
  });

  it("excludes samples outside an explicit from/to range", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    await seed("BTC", eightDaysAgo, { price: 50 });
    await seed("BTC", oneHourAgo, { price: 250 });

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = now.toISOString();

    const res = await request(buildApp())
      .get(`/perps/BTC/market-data?from=${from}&to=${to}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.samples[0].price).toBe(250);
  });

  it("only returns samples for the requested symbol", async () => {
    const now = new Date();
    await seed("BTC", now, { price: 100 });
    await seed("ETH", now, { price: 3000 });

    const res = await request(buildApp())
      .get("/perps/BTC/market-data")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.samples).toHaveLength(1);
    expect(res.body.samples[0].price).toBe(100);
  });

  it("rejects an invalid from/to value", async () => {
    const res = await request(buildApp())
      .get("/perps/BTC/market-data?from=not-a-date")
      .set("Cookie", authCookie());

    expect(res.status).toBe(400);
  });

  it("rejects an inverted range (from after to)", async () => {
    const now = new Date();
    const from = now.toISOString();
    const to = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    const res = await request(buildApp())
      .get(`/perps/BTC/market-data?from=${from}&to=${to}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(400);
  });

  it("returns an empty list for a symbol with no samples", async () => {
    const res = await request(buildApp())
      .get("/perps/BTC/market-data")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.samples).toEqual([]);
  });
});
