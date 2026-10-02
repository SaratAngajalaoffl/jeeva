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
  await pgPool.query("DELETE FROM decisions");
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
  time: Date,
  overrides: Partial<{
    targetDirection: string | null;
    confidence: number | null;
    positionAction: string | null;
    success: boolean;
    error: string | null;
    sessionId: string | null;
  }> = {},
) {
  const row = {
    targetDirection: "long",
    confidence: 0.7,
    positionAction: "opened",
    success: true,
    error: null,
    sessionId: null,
    ...overrides,
  };
  await pgPool.query(
    `INSERT INTO decisions (
       time, symbol, context_summary, target_direction, confidence,
       prob_long, prob_short, prob_flat, position_action, success, error, session_id
     ) VALUES ($1, $2, 'context', $3, $4, 0.7, 0.1, 0.2, $5, $6, $7, $8)`,
    [
      time,
      symbol,
      row.targetDirection,
      row.confidence,
      row.positionAction,
      row.success,
      row.error,
      row.sessionId,
    ],
  );
}

describe("GET /decisions", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/decisions");
    expect(res.status).toBe(401);
  });

  it("returns decisions within the default 24h range, newest first", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await seed("BTC", twoHoursAgo);
    await seed("BTC", oneHourAgo);

    const res = await request(buildApp())
      .get("/decisions")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(2);
    // newest first
    expect(new Date(res.body.decisions[0].time).getTime()).toBeGreaterThan(
      new Date(res.body.decisions[1].time).getTime(),
    );
  });

  it("filters by symbol", async () => {
    const now = new Date();
    await seed("BTC", now);
    await seed("ETH", now);

    const res = await request(buildApp())
      .get("/decisions?symbol=BTC")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].symbol).toBe("BTC");
  });

  it("isolates concurrent sessions for the same symbol", async () => {
    const { rows: sessions } = await pgPool.query<{ id: string }>(
      "INSERT INTO trading_sessions (symbol) VALUES ('BTC'), ('BTC') RETURNING id",
    );
    const now = new Date();
    await seed("BTC", now, { sessionId: sessions[0].id });
    await seed("BTC", new Date(now.getTime() - 1000), {
      sessionId: sessions[1].id,
    });

    const res = await request(buildApp())
      .get(`/decisions?symbol=BTC&sessionId=${sessions[0].id}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0]).toMatchObject({
      symbol: "BTC",
      sessionId: sessions[0].id,
    });

    await pgPool.query("DELETE FROM trading_sessions WHERE id = ANY($1::uuid[])", [
      sessions.map((session) => session.id),
    ]);
  });

  it("excludes decisions outside an explicit from/to range", async () => {
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    await seed("BTC", eightDaysAgo);
    await seed("BTC", now);

    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = now.toISOString();

    const res = await request(buildApp())
      .get(`/decisions?from=${from}&to=${to}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
  });

  it("includes full detail: probabilities, position action, success/error", async () => {
    const now = new Date();
    await seed("BTC", now, {
      targetDirection: null,
      confidence: null,
      positionAction: null,
      success: false,
      error: "no market data available yet",
    });

    const res = await request(buildApp())
      .get("/decisions")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions[0]).toMatchObject({
      symbol: "BTC",
      targetDirection: null,
      confidence: null,
      positionAction: null,
      success: false,
      error: "no market data available yet",
    });
  });

  it("respects an explicit limit", async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await seed("BTC", new Date(now.getTime() - i * 1000));
    }

    const res = await request(buildApp())
      .get("/decisions?limit=2")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(2);
  });

  it.each(["0", "-1", "1001", "abc"])(
    "rejects an invalid limit: %s",
    async (limit) => {
      const res = await request(buildApp())
        .get(`/decisions?limit=${limit}`)
        .set("Cookie", authCookie());
      expect(res.status).toBe(400);
    },
  );

  it("rejects an invalid time range", async () => {
    const res = await request(buildApp())
      .get("/decisions?from=not-a-date")
      .set("Cookie", authCookie());
    expect(res.status).toBe(400);
  });
});
