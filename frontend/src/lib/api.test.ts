import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FALLBACK_API_URL = "http://localhost:4000";

/**
 * The API base URL is resolved at runtime from /runtime-config (served by
 * the container), not inlined at build time — so one built image can be
 * pointed at different API backends per instance. The module memoizes the
 * resolved URL, so each case re-imports it fresh.
 */
async function importApi() {
  vi.resetModules();
  return import("./api.js");
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

describe("backtest API errors", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the earliest valid start in the user's local timezone", async () => {
    const earliestStart = "2026-09-20T21:19:00.432Z";
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/runtime-config") {
        return jsonResponse({ apiUrl: "" });
      }
      return jsonResponse(
        {
          error: "startTime predates the oldest available market data",
          earliestStart,
        },
        false,
      );
    });

    const { createBacktest } = await importApi();
    const result = await createBacktest("HYPE", {
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 1,
      positionSizeUsd: 100,
      startTime: earliestStart,
      endTime: "2026-09-21T18:00:00.000Z",
      initialBalanceUsd: 10000,
    });

    const expectedLocal = new Date(earliestStart).toLocaleString();
    expect(result).toEqual({
      ok: false,
      error: `Start is before the oldest available market data. Earliest valid start: ${expectedLocal} (${earliestStart} UTC).`,
    });
  });

  it("renders the latest valid end in the user's local timezone", async () => {
    const latestEnd = "2026-09-21T18:04:12.987Z";
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input) === "/runtime-config") {
        return jsonResponse({ apiUrl: "" });
      }
      return jsonResponse(
        {
          error: "endTime is after the newest available market data",
          latestEnd,
        },
        false,
      );
    });

    const { createBacktest } = await importApi();
    const result = await createBacktest("HYPE", {
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 1,
      positionSizeUsd: 100,
      startTime: "2026-09-20T21:19:00.432Z",
      endTime: latestEnd,
      initialBalanceUsd: 10000,
    });

    const expectedLocal = new Date(latestEnd).toLocaleString();
    expect(result).toEqual({
      ok: false,
      error: `End is after the newest available market data. Latest valid end: ${expectedLocal} (${latestEnd} UTC).`,
    });
  });
});

describe("runtime API URL resolution", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes requests to the URL served by /runtime-config", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/runtime-config") {
        return jsonResponse({ apiUrl: "https://api.example.com" });
      }
      return jsonResponse({ perps: [] });
    });

    const { fetchPerps } = await importApi();
    await fetchPerps();

    expect(fetch).toHaveBeenCalledWith("/runtime-config", {
      cache: "no-store",
    });
    expect(fetch).toHaveBeenCalledWith("https://api.example.com/perps", {
      credentials: "include",
    });
  });

  it("falls back to localhost when the runtime config is empty", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/runtime-config") {
        return jsonResponse({ apiUrl: "" });
      }
      return jsonResponse({ perps: [] });
    });

    const { fetchPerps } = await importApi();
    await fetchPerps();

    expect(fetch).toHaveBeenCalledWith(`${FALLBACK_API_URL}/perps`, {
      credentials: "include",
    });
  });

  it("falls back to localhost when the runtime config request fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/runtime-config") {
        throw new Error("offline");
      }
      return jsonResponse({ perps: [] });
    });

    const { fetchPerps } = await importApi();
    await fetchPerps();

    expect(fetch).toHaveBeenCalledWith(`${FALLBACK_API_URL}/perps`, {
      credentials: "include",
    });
  });

  it("resolves the runtime config only once across calls", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/runtime-config") {
        return jsonResponse({ apiUrl: "https://api.example.com" });
      }
      return jsonResponse({ perps: [] });
    });

    const { fetchPerps } = await importApi();
    await fetchPerps();
    await fetchPerps();

    const configCalls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input) === "/runtime-config");
    expect(configCalls).toHaveLength(1);
  });
});
