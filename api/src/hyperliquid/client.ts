export interface PerpMeta {
  symbol: string;
}

export interface PerpStats {
  symbol: string;
  price: number;
  changePct: number;
  volumeUsd: number;
  openInterestUsd: number;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface Trade {
  time: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export interface ClearinghouseState {
  accountValueUsd: number;
  withdrawableUsd: number;
}

export interface HyperliquidClient {
  listPerps(): Promise<PerpMeta[]>;
  listPerpStats(): Promise<PerpStats[]>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getRecentTrades(symbol: string): Promise<Trade[]>;
  getClearinghouseState(address: string, dex?: string): Promise<ClearinghouseState>;
}

interface MetaResponse {
  universe: { name: string }[];
}

interface PerpDex {
  name: string;
}

interface PerpDexResponse {
  name?: string;
}

interface AssetCtx {
  markPx: string;
  prevDayPx: string;
  dayNtlVlm: string;
  openInterest: string;
}

interface L2Level {
  px: string;
  sz: string;
}

interface L2BookResponse {
  levels: [L2Level[], L2Level[]];
}

interface RecentTrade {
  time: number;
  px: string;
  sz: string;
  side: "A" | "B";
}

interface ClearinghouseStateResponse {
  marginSummary: { accountValue: string };
  withdrawable: string;
}

export function createHyperliquidClient(
  baseUrl = "https://api.hyperliquid.xyz",
): HyperliquidClient {
  async function info(request: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(`Hyperliquid ${request.type} request failed: ${res.status}`);
    }
    return res.json();
  }

  async function perpDexs(): Promise<PerpDex[]> {
    // perpDexs[0] is the default (unnamespaced) perp DEX. HIP-3 DEXs
    // follow it and are queried with a `dex` parameter.
    const body = (await info({ type: "perpDexs" })) as Array<PerpDexResponse | null>;
    return body
      .filter((dex): dex is PerpDex => typeof dex?.name === "string")
      .map((dex) => ({ name: dex.name }));
  }

  function namespacedSymbol(dex: string | undefined, name: string): string {
    if (!dex) return name;
    const localName = name.startsWith(`${dex}:`) ? name.slice(dex.length + 1) : name;
    return `${dex}:${localName}`;
  }

  async function metaFor(dex?: string): Promise<MetaResponse> {
    return (await info({ type: "meta", ...(dex ? { dex } : {}) })) as MetaResponse;
  }

  async function statsFor(dex?: string): Promise<PerpStats[]> {
    const body = (await info({
      type: "metaAndAssetCtxs",
      ...(dex ? { dex } : {}),
    })) as [MetaResponse, AssetCtx[]];
    const [meta, assetCtxs] = body;
    return meta.universe.map((entry, i) => {
      const ctx = assetCtxs[i];
      const price = Number(ctx?.markPx ?? 0);
      const prevDayPrice = Number(ctx?.prevDayPx ?? 0);
      const changePct = prevDayPrice > 0
        ? ((price - prevDayPrice) / prevDayPrice) * 100
        : 0;
      return {
        symbol: namespacedSymbol(dex, entry.name),
        price,
        changePct,
        volumeUsd: Number(ctx?.dayNtlVlm ?? 0),
        openInterestUsd: Number(ctx?.openInterest ?? 0) * price,
      };
    });
  }

  return {
    async listPerps(): Promise<PerpMeta[]> {
      const dexes = await perpDexs();
      const [defaultMeta, ...builderMetas] = await Promise.all([
        metaFor(),
        ...dexes.map((dex) => metaFor(dex.name)),
      ]);
      return [
        ...defaultMeta.universe.map((entry) => ({ symbol: entry.name })),
        ...builderMetas.flatMap((meta, i) =>
          meta.universe.map((entry) => ({
            symbol: namespacedSymbol(dexes[i].name, entry.name),
          })),
        ),
      ];
    },

    async listPerpStats(): Promise<PerpStats[]> {
      const dexes = await perpDexs();
      const stats = await Promise.all([
        statsFor(),
        ...dexes.map((dex) => statsFor(dex.name)),
      ]);
      return stats.flat();
    },

    async getOrderBook(symbol: string): Promise<OrderBook> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "l2Book", coin: symbol }),
      });

      if (!res.ok) {
        throw new Error(`Hyperliquid l2Book request failed: ${res.status}`);
      }

      const body = (await res.json()) as L2BookResponse;
      const toLevels = (levels: L2Level[]): OrderBookLevel[] =>
        levels.map((l) => ({ price: Number(l.px), size: Number(l.sz) }));

      return {
        bids: toLevels(body.levels[0] ?? []),
        asks: toLevels(body.levels[1] ?? []),
      };
    },

    async getRecentTrades(symbol: string): Promise<Trade[]> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "recentTrades", coin: symbol }),
      });

      if (!res.ok) {
        throw new Error(
          `Hyperliquid recentTrades request failed: ${res.status}`,
        );
      }

      const body = (await res.json()) as RecentTrade[];
      return body.map((t) => ({
        time: t.time,
        price: Number(t.px),
        size: Number(t.sz),
        side: t.side === "B" ? "buy" : "sell",
      }));
    },

    async getClearinghouseState(address: string, dex?: string): Promise<ClearinghouseState> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: address,
          ...(dex ? { dex } : {}),
        }),
      });

      if (!res.ok) {
        throw new Error(
          `Hyperliquid clearinghouseState request failed: ${res.status}`,
        );
      }

      const body = (await res.json()) as ClearinghouseStateResponse;
      return {
        accountValueUsd: Number(body.marginSummary?.accountValue ?? 0),
        withdrawableUsd: Number(body.withdrawable ?? 0),
      };
    },
  };
}
