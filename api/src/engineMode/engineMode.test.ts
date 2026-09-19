import { MongoClient, type Db } from "mongodb";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";

const MONGO_URL =
  process.env.TEST_MONGO_URL ?? "mongodb://localhost:27017/jeeva_test";
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

interface EngineModeDoc {
  _id: string;
  mode: string;
}

const client = new MongoClient(MONGO_URL);
await client.connect();
const db: Db = client.db();
const engineConfig = () => db.collection<EngineModeDoc>("engineConfig");
const perpConfigs = () => db.collection("perpConfigs");
const pgPool = new Pool({ connectionString: DATABASE_URL });

afterAll(async () => {
  await client.close();
  await pgPool.end();
});

beforeEach(async () => {
  await engineConfig().deleteMany({});
  await perpConfigs().deleteMany({});
  await pgPool.query("DELETE FROM wallets");
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ db, pgPool });
}

describe("GET /engine-mode", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/engine-mode");
    expect(res.status).toBe(401);
  });

  it("defaults to mock mode when nothing has been configured", async () => {
    const res = await request(buildApp())
      .get("/engine-mode")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "mock" });
  });

  it("reflects a previously-set live mode", async () => {
    await engineConfig().insertOne({ _id: "singleton", mode: "live" });

    const res = await request(buildApp())
      .get("/engine-mode")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "live" });
  });
});

describe("PUT /engine-mode", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp())
      .put("/engine-mode")
      .send({ mode: "live" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid mode value", async () => {
    const res = await request(buildApp())
      .put("/engine-mode")
      .set("Cookie", authCookie())
      .send({ mode: "turbo" });

    expect(res.status).toBe(400);
  });

  it("switches the mode and persists it", async () => {
    const res = await request(buildApp())
      .put("/engine-mode")
      .set("Cookie", authCookie())
      .send({ mode: "live" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "live" });

    const stored = await engineConfig().findOne({ _id: "singleton" });
    expect(stored?.mode).toBe("live");
  });

  it("switching back to mock overwrites a previous live setting", async () => {
    await engineConfig().insertOne({ _id: "singleton", mode: "live" });

    const res = await request(buildApp())
      .put("/engine-mode")
      .set("Cookie", authCookie())
      .send({ mode: "mock" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "mock" });

    const stored = await engineConfig().findOne({ _id: "singleton" });
    expect(stored?.mode).toBe("mock");
  });

  it("disables trading on any perp using a live wallet when switching to mock", async () => {
    const liveWallet = await pgPool.query(
      "INSERT INTO wallets (label, kind, public_address) VALUES ('Live', 'live', '0xabc') RETURNING id",
    );
    const walletId = liveWallet.rows[0].id;
    await perpConfigs().insertOne({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
      decisionFrequencySeconds: 300,
      samplingFrequencySeconds: 60,
      leverage: 1,
      positionSizeUsd: 100,
      decisionMaker: "fake",
      walletId,
    });
    await engineConfig().insertOne({ _id: "singleton", mode: "live" });

    const res = await request(buildApp())
      .put("/engine-mode")
      .set("Cookie", authCookie())
      .send({ mode: "mock" });

    expect(res.status).toBe(200);
    const perp = await perpConfigs().findOne({ symbol: "BTC" });
    expect(perp?.tradingEnabled).toBe(false);
  });
});
