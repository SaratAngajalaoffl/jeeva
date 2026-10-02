import type { Db } from "mongodb";
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
const db = {} as Db;

function buildApp() {
  return createApp({ db, pgPool });
}

afterAll(async () => {
  await pgPool.end();
});

beforeEach(async () => {
  await pgPool.query("DELETE FROM live_execution_holds");
  await pgPool.query("DELETE FROM wallets");
  await pgPool.query(
    "INSERT INTO wallets (id, label, kind) VALUES ('00000000-0000-0000-0000-000000000abc', 'Live', 'live')",
  );
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

const walletId = "00000000-0000-0000-0000-000000000abc";

async function seedHold(symbol: string, reason = "drift policy halt") {
  await pgPool.query(
    `INSERT INTO live_execution_holds (wallet_id, symbol, reason)
     VALUES ($1, $2, $3)`,
    [walletId, symbol, reason],
  );
}

describe("live execution holds", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get(`/wallets/${walletId}/holds`);
    expect(res.status).toBe(401);
  });

  it("returns an empty list when no PERP is halted", async () => {
    const res = await request(buildApp())
      .get(`/wallets/${walletId}/holds`)
      .set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.holds).toEqual([]);
  });

  it("lists a halt taken by the engine's drift policy", async () => {
    await seedHold("BTC", "drift policy halt: SizeMismatch");

    const res = await request(buildApp())
      .get(`/wallets/${walletId}/holds`)
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.holds).toHaveLength(1);
    expect(res.body.holds[0].symbol).toBe("BTC");
    expect(res.body.holds[0].reason).toBe("drift policy halt: SizeMismatch");
  });

  it("clears only the acknowledged PERP's hold", async () => {
    await seedHold("BTC");
    await seedHold("ETH");

    const res = await request(buildApp())
      .delete(`/wallets/${walletId}/holds/BTC`)
      .set("Cookie", authCookie());
    expect(res.status).toBe(204);

    const after = await request(buildApp())
      .get(`/wallets/${walletId}/holds`)
      .set("Cookie", authCookie());
    expect(after.body.holds.map((h: { symbol: string }) => h.symbol)).toEqual([
      "ETH",
    ]);
  });

  it("reports 404 when acknowledging a PERP that is not halted", async () => {
    const res = await request(buildApp())
      .delete(`/wallets/${walletId}/holds/BTC`)
      .set("Cookie", authCookie());
    expect(res.status).toBe(404);
  });
});
