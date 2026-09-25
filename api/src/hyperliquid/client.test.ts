import { afterEach, describe, expect, it, vi } from "vitest";

import { createHyperliquidClient } from "./client.js";

interface InfoRequest {
  type: string;
  dex?: string;
  coin?: string;
  user?: string;
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HyperliquidClient HIP-3 discovery", () => {
  it("lists and fetches a namespaced HIP-3 market end-to-end", async () => {
    const requests: InfoRequest[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as InfoRequest;
      requests.push(request);

      if (request.type === "perpDexs") {
        return ok([null, { name: "xyz" }]);
      }
      if (request.type === "meta" && request.dex === "xyz") {
        return ok({ universe: [{ name: "AAOI" }] });
      }
      if (request.type === "meta") {
        return ok({ universe: [{ name: "BTC" }] });
      }
      if (request.type === "metaAndAssetCtxs" && request.dex === "xyz") {
        return ok([
          { universe: [{ name: "AAOI" }] },
          [
            {
              markPx: "101.5",
              prevDayPx: "100",
              dayNtlVlm: "250000",
              openInterest: "1000",
            },
          ],
        ]);
      }
      if (request.type === "metaAndAssetCtxs") {
        return ok([
          { universe: [{ name: "BTC" }] },
          [
            {
              markPx: "50000",
              prevDayPx: "49000",
              dayNtlVlm: "1000000",
              openInterest: "100",
            },
          ],
        ]);
      }
      if (request.type === "l2Book") {
        return ok({
          levels: [[{ px: "101.4", sz: "2" }], [{ px: "101.6", sz: "3" }]],
        });
      }
      if (request.type === "recentTrades") {
        return ok([{ time: 1, px: "101.5", sz: "1", side: "B" }]);
      }
      if (request.type === "clearinghouseState" && request.dex === "xyz") {
        return ok({
          marginSummary: { accountValue: "500" },
          withdrawable: "400",
        });
      }
      if (request.type === "clearinghouseState") {
        return ok({
          marginSummary: { accountValue: "100" },
          withdrawable: "90",
        });
      }
      throw new Error(`unexpected request: ${request.type}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHyperliquidClient("https://hyperliquid.test");
    await expect(client.listPerps()).resolves.toEqual([
      { symbol: "BTC" },
      { symbol: "xyz:AAOI" },
    ]);
    await expect(client.listPerpStats()).resolves.toEqual([
      {
        symbol: "BTC",
        price: 50000,
        changePct: 2.0408163265306123,
        volumeUsd: 1000000,
        openInterestUsd: 5000000,
      },
      {
        symbol: "xyz:AAOI",
        price: 101.5,
        changePct: 1.5,
        volumeUsd: 250000,
        openInterestUsd: 101500,
      },
    ]);
    await expect(client.getOrderBook("xyz:AAOI")).resolves.toEqual({
      bids: [{ price: 101.4, size: 2 }],
      asks: [{ price: 101.6, size: 3 }],
    });
    await expect(client.getRecentTrades("xyz:AAOI")).resolves.toEqual([
      { time: 1, price: 101.5, size: 1, side: "buy" },
    ]);

    await expect(
      client.getClearinghouseState("0x0000000000000000000000000000000000000000", "xyz"),
    ).resolves.toEqual({ accountValueUsd: 500, withdrawableUsd: 400 });
    await expect(
      client.getClearinghouseState("0x0000000000000000000000000000000000000000"),
    ).resolves.toEqual({ accountValueUsd: 100, withdrawableUsd: 90 });

    expect(requests).toEqual(
      expect.arrayContaining([
        { type: "meta", dex: "xyz" },
        { type: "metaAndAssetCtxs", dex: "xyz" },
        { type: "l2Book", coin: "xyz:AAOI" },
        { type: "recentTrades", coin: "xyz:AAOI" },
        {
          type: "clearinghouseState",
          user: "0x0000000000000000000000000000000000000000",
          dex: "xyz",
        },
        {
          type: "clearinghouseState",
          user: "0x0000000000000000000000000000000000000000",
        },
      ]),
    );
  });
});

describe("HyperliquidClient unknown markets", () => {
  // The info endpoint answers an unknown coin with a literal `null` body
  // (HTTP 200), rather than an error. A malformed or stale symbol must
  // therefore surface as a typed failure instead of reading fields off a
  // null body and taking the process down.
  it("rejects an unknown coin for the order book", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(null)));
    const client = createHyperliquidClient("https://hyperliquid.test");
    await expect(client.getOrderBook("xyz%3ATSLA")).rejects.toThrow(
      "unknown market: xyz%3ATSLA",
    );
  });

  it("rejects an unknown coin for recent trades", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok(null)));
    const client = createHyperliquidClient("https://hyperliquid.test");
    await expect(client.getRecentTrades("NOTAREALCOIN")).rejects.toThrow(
      "unknown market: NOTAREALCOIN",
    );
  });
});
