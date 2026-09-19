import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "../auth/config.js";
import { signSessionToken } from "../auth/session.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://jeeva:jeeva@localhost:5432/jeeva_test";

const pgPool = new Pool({ connectionString: DATABASE_URL });

beforeAll(async () => {
  await pgPool.query(
    `CREATE TABLE IF NOT EXISTS perp_health (
       symbol TEXT PRIMARY KEY,
       consecutive_failures INT NOT NULL DEFAULT 0,
       last_failure_reason TEXT,
       last_failure_at TIMESTAMPTZ,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
});

afterAll(async () => {
  await pgPool.end();
});

beforeEach(async () => {
  await pgPool.query("DELETE FROM perp_health");
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ pgPool });
}

describe("GET /perp-health", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/perp-health");
    expect(res.status).toBe(401);
  });

  it("returns an empty list when no PERP has run a cycle yet", async () => {
    const res = await request(buildApp())
      .get("/perp-health")
      .set("Cookie", authCookie());
    expect(res.status).toBe(200);
    expect(res.body.health).toEqual([]);
  });

  it("returns each PERP's consecutive-failure count and most recent failure", async () => {
    await pgPool.query(
      "INSERT INTO perp_health (symbol, consecutive_failures, last_failure_reason, last_failure_at) VALUES ($1, $2, $3, now())",
      ["BTC", 3, "jev unavailable"],
    );
    await pgPool.query(
      "INSERT INTO perp_health (symbol, consecutive_failures) VALUES ($1, $2)",
      ["ETH", 0],
    );

    const res = await request(buildApp())
      .get("/perp-health")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body.health).toHaveLength(2);
    expect(res.body.health).toContainEqual(
      expect.objectContaining({
        symbol: "BTC",
        consecutiveFailures: 3,
        lastFailureReason: "jev unavailable",
      }),
    );
    expect(res.body.health).toContainEqual(
      expect.objectContaining({
        symbol: "ETH",
        consecutiveFailures: 0,
        lastFailureReason: null,
      }),
    );
  });
});
