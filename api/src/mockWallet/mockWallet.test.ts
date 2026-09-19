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
  await pgPool.query("DELETE FROM mock_wallet");
});

function authCookie(): string {
  const token = signSessionToken(process.env.JWT_SECRET!);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function buildApp() {
  return createApp({ pgPool });
}

describe("GET /mock-wallet", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp()).get("/mock-wallet");
    expect(res.status).toBe(401);
  });

  it("returns 404 when no wallet has been created yet", async () => {
    const res = await request(buildApp())
      .get("/mock-wallet")
      .set("Cookie", authCookie());
    expect(res.status).toBe(404);
  });

  it("returns the wallet's balance and all-time P&L once created", async () => {
    await request(buildApp())
      .post("/mock-wallet")
      .set("Cookie", authCookie())
      .send({ initialBalanceUsd: 10000 });

    const res = await request(buildApp())
      .get("/mock-wallet")
      .set("Cookie", authCookie());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      initialBalanceUsd: 10000,
      currentBalanceUsd: 10000,
      allTimePnlUsd: 0,
    });
    expect(typeof res.body.createdAt).toBe("string");
  });
});

describe("POST /mock-wallet", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(buildApp())
      .post("/mock-wallet")
      .send({ initialBalanceUsd: 10000 });
    expect(res.status).toBe(401);
  });

  it("creates a wallet with the given initial balance", async () => {
    const res = await request(buildApp())
      .post("/mock-wallet")
      .set("Cookie", authCookie())
      .send({ initialBalanceUsd: 5000 });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      initialBalanceUsd: 5000,
      currentBalanceUsd: 5000,
      allTimePnlUsd: 0,
    });
  });

  it.each([0, -1, NaN, Infinity, 100_000_001, "100", null])(
    "rejects an invalid initialBalanceUsd value: %p",
    async (value) => {
      const res = await request(buildApp())
        .post("/mock-wallet")
        .set("Cookie", authCookie())
        .send({ initialBalanceUsd: value });
      expect(res.status).toBe(400);
    },
  );

  it("rejects creating a second wallet once one exists", async () => {
    const first = await request(buildApp())
      .post("/mock-wallet")
      .set("Cookie", authCookie())
      .send({ initialBalanceUsd: 10000 });
    expect(first.status).toBe(201);

    const second = await request(buildApp())
      .post("/mock-wallet")
      .set("Cookie", authCookie())
      .send({ initialBalanceUsd: 20000 });
    expect(second.status).toBe(409);

    // The original wallet's balance is untouched by the rejected attempt.
    const res = await request(buildApp())
      .get("/mock-wallet")
      .set("Cookie", authCookie());
    expect(res.body.initialBalanceUsd).toBe(10000);
  });
});
