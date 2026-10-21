import { describe, expect, it, vi } from "vitest";

import { createCachedHyperliquidClient } from "./cache.js";
import type { HyperliquidClient, PerpStats } from "./client.js";

function stats(price: number): PerpStats[] {
  return [{ symbol: "BTC", price, changePct: 0, volumeUsd: 0, openInterestUsd: 0 }];
}

function fakeClient(overrides: Partial<HyperliquidClient> = {}): HyperliquidClient {
  return {
    listPerps: vi.fn(async () => [{ symbol: "BTC" }]),
    listPerpStats: vi.fn(async () => stats(1)),
    getOrderBook: vi.fn(async () => ({ bids: [], asks: [] })),
    getRecentTrades: vi.fn(async () => []),
    getClearinghouseState: vi.fn(async () => ({
      accountValueUsd: 0,
      withdrawableUsd: 0,
    })),
    ...overrides,
  };
}

describe("createCachedHyperliquidClient", () => {
  it("serves repeat calls from the cache until the TTL passes", async () => {
    let time = 0;
    const inner = fakeClient();
    const client = createCachedHyperliquidClient(inner, {
      statsTtlMs: 1000,
      now: () => time,
    });

    await client.listPerpStats();
    time = 999;
    await client.listPerpStats();
    expect(inner.listPerpStats).toHaveBeenCalledTimes(1);

    time = 1000;
    await client.listPerpStats();
    expect(inner.listPerpStats).toHaveBeenCalledTimes(2);
  });

  it("shares one upstream request between concurrent callers", async () => {
    const inner = fakeClient();
    const client = createCachedHyperliquidClient(inner);

    await Promise.all([client.listPerps(), client.listPerps(), client.listPerps()]);

    expect(inner.listPerps).toHaveBeenCalledTimes(1);
  });

  it("serves the last good value when a refresh fails", async () => {
    let time = 0;
    const listPerpStats = vi
      .fn<HyperliquidClient["listPerpStats"]>()
      .mockResolvedValueOnce(stats(1))
      .mockRejectedValueOnce(new Error("429"))
      .mockResolvedValueOnce(stats(2));
    const client = createCachedHyperliquidClient(fakeClient({ listPerpStats }), {
      statsTtlMs: 1000,
      now: () => time,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(client.listPerpStats()).resolves.toEqual(stats(1));
    time = 1000;
    await expect(client.listPerpStats()).resolves.toEqual(stats(1));
    // The failed refresh doesn't extend freshness, so the next call retries.
    await expect(client.listPerpStats()).resolves.toEqual(stats(2));
  });

  it("propagates the error when there is nothing cached yet", async () => {
    const client = createCachedHyperliquidClient(
      fakeClient({ listPerps: vi.fn(async () => Promise.reject(new Error("429"))) }),
    );

    await expect(client.listPerps()).rejects.toThrow("429");
  });

  it("does not cache coin- and user-addressed calls", async () => {
    const inner = fakeClient();
    const client = createCachedHyperliquidClient(inner);

    await client.getOrderBook("BTC");
    await client.getOrderBook("BTC");

    expect(inner.getOrderBook).toHaveBeenCalledTimes(2);
  });
});
