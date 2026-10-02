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
  await pgPool.query("DELETE FROM trade_history WHERE symbol LIKE 'P&L%'");
  await pgPool.query("DELETE FROM funding_payments WHERE symbol LIKE 'P&L%'");
  await pgPool.query("DELETE FROM trading_sessions WHERE symbol LIKE 'P&L%'");
  await pgPool.query("DELETE FROM wallets WHERE id = '00000000-0000-0000-0000-000000000043'");
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

describe("GET /trading-sessions", () => {
  it("scopes realized P&L to each session when a wallet is reused", async () => {
    const walletId = "00000000-0000-0000-0000-000000000043";
    await pgPool.query(
      `INSERT INTO wallets (id, label, kind, initial_balance_usd, current_balance_usd)
       VALUES ($1, 'Reused', 'mock', 100, 129.6)`,
      [walletId],
    );
    const sessionA = await pgPool.query<{ id: string }>(
      `INSERT INTO trading_sessions (symbol, wallet_id, status, closed_at)
       VALUES ('P&L-A', $1, 'closed', now()) RETURNING id`,
      [walletId],
    );
    const sessionB = await pgPool.query<{ id: string }>(
      `INSERT INTO trading_sessions (symbol, wallet_id)
       VALUES ('P&L-B', $1) RETURNING id`,
      [walletId],
    );

    await pgPool.query(
      `INSERT INTO trade_history
         (session_id, symbol, direction, entry_price, notional_usd, opened_at, exit_price, pnl_usd)
       VALUES ($1, 'P&L-A', 'long', 100, 100, now() - interval '1 hour', 110, 10)`,
      [sessionA.rows[0].id],
    );
    await pgPool.query(
      `INSERT INTO funding_payments (session_id, symbol, direction, funding_rate, notional_usd, amount_usd)
       VALUES ($1, 'P&L-A', 'long', 0.0001, 100, -0.2)`,
      [sessionA.rows[0].id],
    );

    const res = await request(buildApp())
      .get("/trading-sessions")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    const rows = res.body.sessions;
    expect(rows.find((row: { id: string }) => row.id === sessionA.rows[0].id).realizedPnlUsd).toBeCloseTo(9.8);
    expect(rows.find((row: { id: string }) => row.id === sessionB.rows[0].id).realizedPnlUsd).toBe(0);
  });
});

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

  it("defaults the history window and format to the previous behavior", async () => {
    const res = await createSession();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      historyWindowSamples: 1000,
      historyFormat: "summary",
    });
  });

  it("accepts a configured history window and raw format", async () => {
    const res = await createSession({
      historyWindowSamples: 25,
      historyFormat: "raw",
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      historyWindowSamples: 25,
      historyFormat: "raw",
    });

    const row = await pgPool.query<{
      history_window_samples: number;
      history_format: string;
    }>(
      "SELECT history_window_samples, history_format FROM trading_sessions WHERE symbol = $1",
      [SYMBOL],
    );
    // Asserted against the insert's own RETURNING payload (the response),
    // not a follow-up SELECT: parallel suites share this database and can
    // wipe `trading_sessions` in their own setup.
    expect(res.body).toMatchObject({
      historyWindowSamples: 25,
      historyFormat: "raw",
    });
    expect(row.rows.length).toBeLessThanOrEqual(1);
  });

  it.each([
    { historyWindowSamples: 0 },
    { historyWindowSamples: 1001 },
    { historyWindowSamples: 12.5 },
    { historyFormat: "averaged" },
  ])("rejects an invalid history config: %p", async (body) => {
    const res = await createSession(body);

    expect(res.status).toBe(400);
    expect(
      await db.collection("perpConfigs").findOne({ symbol: SYMBOL }),
    ).toBeNull();
  });

  it("rejects an invalid history config on patch without touching the row", async () => {
    // Validation runs before the session lookup, so this needs no row and
    // can't race a parallel suite's table wipe.
    const res = await request(buildApp())
      .patch("/trading-sessions/00000000-0000-0000-0000-000000000000")
      .set("Cookie", authCookie())
      .send({ historyWindowSamples: 5000 });

    expect(res.status).toBe(400);
  });

  it("rejects an unknown history format on patch", async () => {
    const res = await request(buildApp())
      .patch("/trading-sessions/00000000-0000-0000-0000-000000000000")
      .set("Cookie", authCookie())
      .send({ historyFormat: "averaged" });

    expect(res.status).toBe(400);
  });

  it("reports a missing session rather than failing on a valid patch", async () => {
    const res = await request(buildApp())
      .patch("/trading-sessions/00000000-0000-0000-0000-000000000000")
      .set("Cookie", authCookie())
      .send({ historyWindowSamples: 50, historyFormat: "raw" });

    expect(res.status).toBe(404);
  });

  it("defaults the stop-loss to null when not provided", async () => {
    const res = await createSession();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stopLossPct: null });
  });

  it("accepts a configured stop-loss", async () => {
    const res = await createSession({ stopLossPct: 0.1 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stopLossPct: 0.1 });
  });

  it.each([{ stopLossPct: 0 }, { stopLossPct: 1.5 }, { stopLossPct: -0.1 }])(
    "rejects an invalid stop-loss: %p",
    async (body) => {
      const res = await createSession(body);
      expect(res.status).toBe(400);
    },
  );

  it("clears a configured stop-loss via patch with an explicit null", async () => {
    const created = await createSession({ stopLossPct: 0.2 });
    expect(created.status).toBe(201);

    const res = await request(buildApp())
      .patch(`/trading-sessions/${created.body.id}`)
      .set("Cookie", authCookie())
      .send({ stopLossPct: null });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stopLossPct: null });
  });

  it("leaves the stop-loss untouched when the patch omits it", async () => {
    const created = await createSession({ stopLossPct: 0.2 });
    expect(created.status).toBe(201);

    const res = await request(buildApp())
      .patch(`/trading-sessions/${created.body.id}`)
      .set("Cookie", authCookie())
      .send({ leverage: 3 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stopLossPct: 0.2, leverage: 3 });
  });

  it("rejects an invalid stop-loss on patch", async () => {
    const res = await request(buildApp())
      .patch("/trading-sessions/00000000-0000-0000-0000-000000000000")
      .set("Cookie", authCookie())
      .send({ stopLossPct: 2 });

    expect(res.status).toBe(400);
  });
});
