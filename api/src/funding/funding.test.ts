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
  await pgPool.query("DELETE FROM funding_payments");
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
  direction: "long" | "short",
  sessionId: string | null = null,
) {
  await pgPool.query(
    `INSERT INTO funding_payments (time, symbol, direction, funding_rate, notional_usd, amount_usd, session_id)
     VALUES ($1, $2, $3, 0.0001, 1000, $4, $5)`,
    [
      time,
      symbol,
      direction,
      direction === "long" ? -0.1 : 0.1,
      sessionId,
    ],
  );
}

describe("GET /funding", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/funding");
    expect(res.status).toBe(401);
  });

  it("returns funding payments within the default 24h range, newest first", async () => {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    await seed("BTC", twoHoursAgo, "long");
    await seed("BTC", oneHourAgo, "long");

    const res = await request(buildApp())
      .get("/funding")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(2);
    expect(new Date(res.body.payments[0].time).getTime()).toBeGreaterThan(
      new Date(res.body.payments[1].time).getTime(),
    );
  });

  it("filters by symbol and includes direction/rate/amount detail", async () => {
    const now = new Date();
    await seed("BTC", now, "long");
    await seed("ETH", now, "short");

    const res = await request(buildApp())
      .get("/funding?symbol=BTC")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({
      symbol: "BTC",
      direction: "long",
      fundingRate: 0.0001,
      notionalUsd: 1000,
      amountUsd: -0.1,
    });
  });

  it("isolates concurrent sessions for the same symbol", async () => {
    const { rows: sessions } = await pgPool.query<{ id: string }>(
      "INSERT INTO trading_sessions (symbol) VALUES ('BTC'), ('BTC') RETURNING id",
    );
    const now = new Date();
    await seed("BTC", now, "long", sessions[0].id);
    await seed("BTC", new Date(now.getTime() - 1000), "short", sessions[1].id);

    const res = await request(buildApp())
      .get(`/funding?symbol=BTC&sessionId=${sessions[0].id}`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.payments).toHaveLength(1);
    expect(res.body.payments[0]).toMatchObject({
      symbol: "BTC",
      sessionId: sessions[0].id,
      direction: "long",
    });

    await pgPool.query("DELETE FROM trading_sessions WHERE id = ANY($1::uuid[])", [
      sessions.map((session) => session.id),
    ]);
  });

  it("rejects an invalid time range", async () => {
    const res = await request(buildApp())
      .get("/funding?from=not-a-date")
      .set("Cookie", authCookie());
    expect(res.status).toBe(400);
  });
});
