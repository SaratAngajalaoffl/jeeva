import { MongoClient, type Db } from "mongodb";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";
import { DEFAULT_PERP_CONFIG } from "./repository.js";

const MONGO_URL =
  process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/jeeva_test";

const client = new MongoClient(MONGO_URL);
await client.connect();
const db: Db = client.db();

afterAll(async () => {
  await client.close();
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
  return createApp({ db, hyperliquidClient: fakeHyperliquidClient });
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

  it("merges in persisted config for a PERP, including frequencies", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
      decisionFrequencySeconds: 30,
      samplingFrequencySeconds: 10,
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

    it("updating one frequency leaves the other and the toggles untouched", async () => {
      await db.collection("perpConfigs").insertOne({
        symbol: "BTC",
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
});
