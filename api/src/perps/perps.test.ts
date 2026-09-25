import { MongoClient, type Db } from "mongodb";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { DEFAULT_PERP_CONFIG } from "./repository.js";

const MONGO_URL =
  process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/jeeva_test";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

const client = new MongoClient(MONGO_URL);
await client.connect();
const db: Db = client.db();
const pgPool = new Pool({ connectionString: DATABASE_URL });

afterAll(async () => {
  await client.close();
  await pgPool.end();
});

beforeEach(async () => {
  await db.collection("perpConfigs").deleteMany({});
  await db.collection("engineConfig").deleteMany({});
});

const fakeHyperliquidClient: HyperliquidClient = {
  async listPerps() {
    return [{ symbol: "BTC" }, { symbol: "ETH" }];
  },
  async listPerpStats() {
    return [
      {
        symbol: "BTC",
        price: 65000,
        changePct: 1.5,
        volumeUsd: 1_000_000,
        openInterestUsd: 5_000_000,
      },
      {
        symbol: "ETH",
        price: 3200,
        changePct: -0.8,
        volumeUsd: 500_000,
        openInterestUsd: 2_000_000,
      },
    ];
  },
  async getOrderBook() {
    return { bids: [], asks: [] };
  },
  async getRecentTrades() {
    return [];
  },
  async getClearinghouseState() {
    return { accountValueUsd: 1_000_000, withdrawableUsd: 1_000_000 };
  },
};

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ db, pgPool, hyperliquidClient: fakeHyperliquidClient });
}

describe("GET /perps", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/perps");
    expect(res.status).toBe(401);
  });

  it("returns all Hyperliquid PERPs with default sampling settings when none exists", async () => {
    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.perps).toEqual([
      { symbol: "BTC", ...DEFAULT_PERP_CONFIG },
      { symbol: "ETH", ...DEFAULT_PERP_CONFIG },
    ]);
  });

  it("merges in persisted sampling settings for a PERP, defaulting any fields it omits", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "BTC",
      samplingEnabled: true,
      samplingFrequencySeconds: 10,
    });

    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.body.perps).toContainEqual({
      symbol: "BTC",
      samplingEnabled: true,
      samplingFrequencySeconds: 10,
    });
    expect(res.body.perps).toContainEqual({
      symbol: "ETH",
      ...DEFAULT_PERP_CONFIG,
    });
  });
});

describe("PATCH /perps/:symbol", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .send({ samplingEnabled: true });
    expect(res.status).toBe(401);
  });

  it("rejects a non-boolean toggle value", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .set("Cookie", authCookie())
      .send({ samplingEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("persists a sampling toggle", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .set("Cookie", authCookie())
      .send({ samplingEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      symbol: "BTC",
      ...DEFAULT_PERP_CONFIG,
      samplingEnabled: true,
    });
  });

  describe("samplingFrequencySeconds", () => {
    it("persists a valid sampling frequency", async () => {
      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ samplingFrequencySeconds: 5 });

      expect(res.status).toBe(200);
      expect(res.body.samplingFrequencySeconds).toBe(5);

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored).toMatchObject({ samplingFrequencySeconds: 5 });
    });

    it.each([0, -1, NaN, Infinity, 86401, "60", null])(
      "rejects an invalid samplingFrequencySeconds value: %p",
      async (value) => {
        const res = await request(buildApp())
          .patch("/perps/BTC")
          .set("Cookie", authCookie())
          .send({ samplingFrequencySeconds: value });
        expect(res.status).toBe(400);
      },
    );

    it("accepts boundary values 1 and 86400 seconds", async () => {
      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ samplingFrequencySeconds: 1 });
      expect(res.status).toBe(200);
      expect(res.body.samplingFrequencySeconds).toBe(1);

      const res2 = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ samplingFrequencySeconds: 86400 });
      expect(res2.status).toBe(200);
      expect(res2.body.samplingFrequencySeconds).toBe(86400);
    });

    it("a rejected update does not persist any part of the invalid request", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
      });

      await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ samplingFrequencySeconds: -1 });

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored?.samplingFrequencySeconds).toBe(
        DEFAULT_PERP_CONFIG.samplingFrequencySeconds,
      );
    });
  });
});

describe("market-data endpoints for an unknown market", () => {
  // Regression: a coin Hyperliquid has no market for answers `/info` with
  // `null`. That used to throw inside the handler, and because Express 4
  // does not forward a rejected async handler, it killed the API process
  // instead of returning an error — so a malformed symbol took the whole
  // dashboard down with it.
  const failingClient: HyperliquidClient = {
    ...fakeHyperliquidClient,
    async getOrderBook(symbol: string) {
      throw new Error(`unknown market: ${symbol}`);
    },
    async getRecentTrades(symbol: string) {
      throw new Error(`unknown market: ${symbol}`);
    },
  };

  for (const path of ["orderbook", "trades"]) {
    it(`answers ${path} with 500 for an unknown market instead of crashing`, async () => {
      const app = createApp({ db, pgPool, hyperliquidClient: failingClient });

      const res = await request(app)
        .get(`/perps/xyz%253ATSLA/${path}`)
        .set("Cookie", authCookie());

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "internal server error" });

      // The server is still alive and serving other routes.
      const health = await request(app).get("/health");
      expect(health.status).toBe(200);
    });
  }
});
