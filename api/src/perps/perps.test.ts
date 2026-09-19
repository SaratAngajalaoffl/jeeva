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
});

const fakeHyperliquidClient: HyperliquidClient = {
  async listPerps() {
    return [{ symbol: "BTC" }, { symbol: "ETH" }];
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

  it("returns all Hyperliquid PERPs with default config when none exists", async () => {
    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.perps).toEqual([
      { symbol: "BTC", ...DEFAULT_PERP_CONFIG },
      { symbol: "ETH", ...DEFAULT_PERP_CONFIG },
    ]);
  });

  it("merges in persisted config for a PERP, defaulting any fields it omits", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
      decisionFrequencySeconds: 30,
      samplingFrequencySeconds: 10,
      leverage: 5,
      positionSizeUsd: 250,
    });

    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.body.perps).toContainEqual({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
      decisionFrequencySeconds: 30,
      samplingFrequencySeconds: 10,
      leverage: 5,
      positionSizeUsd: 250,
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
      .send({ tradingEnabled: true });
    expect(res.status).toBe(401);
  });

  it("rejects a non-boolean toggle value", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .set("Cookie", authCookie())
      .send({ tradingEnabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("enabling trading also persists sampling enabled", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .set("Cookie", authCookie())
      .send({ tradingEnabled: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      symbol: "BTC",
      ...DEFAULT_PERP_CONFIG,
      tradingEnabled: true,
      samplingEnabled: true,
    });
  });

  it("disabling sampling also persists trading disabled", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "ETH",
      ...DEFAULT_PERP_CONFIG,
      tradingEnabled: true,
      samplingEnabled: true,
    });

    const res = await request(buildApp())
      .patch("/perps/ETH")
      .set("Cookie", authCookie())
      .send({ samplingEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body.tradingEnabled).toBe(false);
    expect(res.body.samplingEnabled).toBe(false);
  });

  it("never persists the invalid combination trading=true, sampling=false even when requested directly", async () => {
    const res = await request(buildApp())
      .patch("/perps/BTC")
      .set("Cookie", authCookie())
      .send({ tradingEnabled: true, samplingEnabled: false });

    expect(res.status).toBe(200);
    const invalidCombo =
      res.body.tradingEnabled === true && res.body.samplingEnabled === false;
    expect(invalidCombo).toBe(false);
  });

  describe("frequency fields", () => {
    it("persists valid decision and sampling frequencies independently", async () => {
      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ decisionFrequencySeconds: 120, samplingFrequencySeconds: 5 });

      expect(res.status).toBe(200);
      expect(res.body.decisionFrequencySeconds).toBe(120);
      expect(res.body.samplingFrequencySeconds).toBe(5);

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored).toMatchObject({
        decisionFrequencySeconds: 120,
        samplingFrequencySeconds: 5,
      });
    });

    it("updating one frequency leaves the other fields untouched", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
        tradingEnabled: true,
        samplingEnabled: true,
        decisionFrequencySeconds: 60,
        samplingFrequencySeconds: 30,
      });

      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ decisionFrequencySeconds: 900 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
        tradingEnabled: true,
        samplingEnabled: true,
        decisionFrequencySeconds: 900,
        samplingFrequencySeconds: 30,
      });
    });

    it.each([0, -5, NaN, Infinity, 86401, "60", null])(
      "rejects an invalid decisionFrequencySeconds value: %p",
      async (value) => {
        const res = await request(buildApp())
          .patch("/perps/BTC")
          .set("Cookie", authCookie())
          .send({ decisionFrequencySeconds: value });
        expect(res.status).toBe(400);
      },
    );

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
        .send({ decisionFrequencySeconds: 1, samplingFrequencySeconds: 86400 });

      expect(res.status).toBe(200);
      expect(res.body.decisionFrequencySeconds).toBe(1);
      expect(res.body.samplingFrequencySeconds).toBe(86400);
    });

    it("a rejected update does not persist any part of the invalid request", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
      });

      await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ decisionFrequencySeconds: -1, samplingFrequencySeconds: 42 });

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored?.samplingFrequencySeconds).toBe(
        DEFAULT_PERP_CONFIG.samplingFrequencySeconds,
      );
    });
  });

  describe("leverage and position size fields", () => {
    it("persists valid leverage and position size independently", async () => {
      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ leverage: 10, positionSizeUsd: 500 });

      expect(res.status).toBe(200);
      expect(res.body.leverage).toBe(10);
      expect(res.body.positionSizeUsd).toBe(500);

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored).toMatchObject({ leverage: 10, positionSizeUsd: 500 });
    });

    it("updating leverage alone leaves position size untouched, and vice versa", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
        leverage: 5,
        positionSizeUsd: 250,
      });

      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ leverage: 20 });

      expect(res.status).toBe(200);
      expect(res.body.leverage).toBe(20);
      expect(res.body.positionSizeUsd).toBe(250);
    });

    it.each([0, -1, NaN, Infinity, 51, "5", null])(
      "rejects an invalid leverage value: %p",
      async (value) => {
        const res = await request(buildApp())
          .patch("/perps/BTC")
          .set("Cookie", authCookie())
          .send({ leverage: value });
        expect(res.status).toBe(400);
      },
    );

    it.each([0, -1, NaN, Infinity, 1_000_001, "100", null])(
      "rejects an invalid positionSizeUsd value: %p",
      async (value) => {
        const res = await request(buildApp())
          .patch("/perps/BTC")
          .set("Cookie", authCookie())
          .send({ positionSizeUsd: value });
        expect(res.status).toBe(400);
      },
    );

    it("accepts boundary values 1x/$1 and 50x/$1,000,000", async () => {
      const res = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ leverage: 1, positionSizeUsd: 1 });
      expect(res.status).toBe(200);
      expect(res.body.leverage).toBe(1);
      expect(res.body.positionSizeUsd).toBe(1);

      const res2 = await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ leverage: 50, positionSizeUsd: 1_000_000 });
      expect(res2.status).toBe(200);
      expect(res2.body.leverage).toBe(50);
      expect(res2.body.positionSizeUsd).toBe(1_000_000);
    });

    it("a rejected update does not persist any part of the invalid request", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
        ...DEFAULT_PERP_CONFIG,
      });

      await request(buildApp())
        .patch("/perps/BTC")
        .set("Cookie", authCookie())
        .send({ leverage: -1, positionSizeUsd: 999 });

      const stored = await db
        .collection("perpConfigs")
        .findOne({ symbol: "BTC" });
      expect(stored?.positionSizeUsd).toBe(DEFAULT_PERP_CONFIG.positionSizeUsd);
    });
  });
});
