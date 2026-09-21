import { MongoClient, type Db } from "mongodb";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
// Its own database: these tests assert on the `perpConfigs` document the
// session route writes, and the perps tests wipe that collection wholesale
// in their own setup — running in parallel against the same database
// would race.
const db: Db = mongoClient.db("jeeva_test_trading_sessions");
const pgPool = new Pool({ connectionString: DATABASE_URL });

const SYMBOL = "SAMPLETEST";

afterAll(async () => {
  await mongoClient.close();
  await pgPool.end();
});

beforeEach(async () => {
  await db.collection("perpConfigs").deleteMany({ symbol: SYMBOL });
  await pgPool.query("DELETE FROM trading_sessions WHERE symbol = $1", [
    SYMBOL,
  ]);
});

const fakeHyperliquidClient: HyperliquidClient = {
  async listPerps() {
    return [{ symbol: SYMBOL }];
  },
  async listPerpStats() {
    return [];
  },
  async getOrderBook() {
    return { bids: [], asks: [] };
  },
  async getRecentTrades() {
    return [];
  },
  async getClearinghouseState() {
    return { accountValueUsd: 0, withdrawableUsd: 0 };
  },
};

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ db, pgPool, hyperliquidClient: fakeHyperliquidClient });
}

function createSession(body: Record<string, unknown> = {}) {
  return request(buildApp())
    .post(`/perps/${SYMBOL}/trading-sessions`)
    .set("Cookie", authCookie())
    .send({
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 1,
      positionSizeUsd: 100,
      ...body,
    });
}

describe("POST /perps/:symbol/trading-sessions", () => {
  it("enables sampling for the market so a session is never traded blind", async () => {
    const res = await createSession();

    expect(res.status).toBe(201);

    const config = await db
      .collection("perpConfigs")
      .findOne({ symbol: SYMBOL });
    expect(config).toMatchObject({
      samplingEnabled: true,
      samplingFrequencySeconds: 60,
    });
  });

  it("keeps an already configured sampling frequency", async () => {
    await db.collection("perpConfigs").insertOne({
      symbol: SYMBOL,
      samplingEnabled: false,
      samplingFrequencySeconds: 5,
    });

    const res = await createSession();

    expect(res.status).toBe(201);

    const config = await db
      .collection("perpConfigs")
      .findOne({ symbol: SYMBOL });
    expect(config).toMatchObject({
      samplingEnabled: true,
      samplingFrequencySeconds: 5,
    });
  });

  it("does not touch sampling when the session itself is rejected", async () => {
    const res = await createSession({ decisionFrequencySeconds: 0 });

    expect(res.status).toBe(400);

    const config = await db
      .collection("perpConfigs")
      .findOne({ symbol: SYMBOL });
    expect(config).toBeNull();
  });
});
