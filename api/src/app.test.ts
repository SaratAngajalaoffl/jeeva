import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", demoMode: false });
  });

  it("reports demoMode when DEMO_MODE=true", async () => {
    process.env.DEMO_MODE = "true";
    const app = createApp();
    const res = await request(app).get("/health");
    delete process.env.DEMO_MODE;
    expect(res.body).toEqual({ status: "ok", demoMode: true });
  });
});
