import { MongoClient, type Db } from "mongodb";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";
import type { HyperliquidClient } from "../hyperliquid/client.js";

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

  it("returns all Hyperliquid PERPs defaulting to disabled with no config", async () => {
    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.perps).toEqual([
      { symbol: "BTC", tradingEnabled: false, samplingEnabled: false },
      { symbol: "ETH", tradingEnabled: false, samplingEnabled: false },
    ]);
  });

  it("merges in persisted config for a PERP", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
    });

    const res = await request(buildApp())
      .get("/perps")
      .set("Cookie", authCookie());

    expect(res.body.perps).toContainEqual({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
    });
    expect(res.body.perps).toContainEqual({
      symbol: "ETH",
      tradingEnabled: false,
      samplingEnabled: false,
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

  it("rejects a non-boolean value", async () => {
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
      tradingEnabled: true,
      samplingEnabled: true,
    });

    const stored = await db
      .collection("perpConfigs")
      .findOne({ symbol: "BTC" });
    expect(stored).toMatchObject({
      tradingEnabled: true,
      samplingEnabled: true,
    });
  });

  it("disabling sampling also persists trading disabled", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: "ETH",
      tradingEnabled: true,
      samplingEnabled: true,
    });

    const res = await request(buildApp())
      .patch("/perps/ETH")
      .set("Cookie", authCookie())
      .send({ samplingEnabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      symbol: "ETH",
      tradingEnabled: false,
      samplingEnabled: false,
    });
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

    const stored = await db
      .collection("perpConfigs")
      .findOne({ symbol: "BTC" });
    const storedInvalidCombo =
      stored?.tradingEnabled === true && stored?.samplingEnabled === false;
    expect(storedInvalidCombo).toBe(false);
  });
});
