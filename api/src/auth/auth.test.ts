import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { SESSION_COOKIE_NAME } from "./config.js";

function extractCookie(
  res: request.Response,
  name: string,
): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

describe("POST /auth/login", () => {
  it("sets a session cookie for correct credentials", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ username: "test-operator", password: "test-password" });

    expect(res.status).toBe(200);
    expect(extractCookie(res, SESSION_COOKIE_NAME)).toContain("HttpOnly");
  });

  it("rejects an incorrect password with a generic error", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ username: "test-operator", password: "wrong-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid credentials");
    expect(extractCookie(res, SESSION_COOKIE_NAME)).toBeUndefined();
  });

  it("rejects an incorrect username with the same generic error", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/auth/login")
      .send({ username: "someone-else", password: "test-password" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid credentials");
  });

  it("rejects a malformed request body", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/login").send({});

    expect(res.status).toBe(400);
  });
});

describe("GET /auth/session (protected route)", () => {
  it("rejects a request with no session cookie", async () => {
    const app = createApp();
    const res = await request(app).get("/auth/session");
    expect(res.status).toBe(401);
  });

  it("rejects a request with a garbage session cookie", async () => {
    const app = createApp();
    const res = await request(app)
      .get("/auth/session")
      .set("Cookie", `${SESSION_COOKIE_NAME}=not-a-real-token`);
    expect(res.status).toBe(401);
  });

  it("accepts a request with a valid session cookie from login", async () => {
    const app = createApp();
    const loginRes = await request(app)
      .post("/auth/login")
      .send({ username: "test-operator", password: "test-password" });
    const cookie = extractCookie(loginRes, SESSION_COOKIE_NAME)!;

    const res = await request(app).get("/auth/session").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ authenticated: true });
  });
});

describe("POST /auth/logout", () => {
  it("clears the session cookie", async () => {
    const app = createApp();
    const res = await request(app).post("/auth/logout");
    expect(res.status).toBe(200);
    const cookie = extractCookie(res, SESSION_COOKIE_NAME);
    expect(cookie).toContain("Expires=Thu, 01 Jan 1970");
  });
});
