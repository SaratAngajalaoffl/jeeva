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
  getClearinghouseState(address: string): Promise<ClearinghouseState>;
}

interface MetaResponse {
  universe: { name: string }[];
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
  return {
    async listPerps(): Promise<PerpMeta[]> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "meta" }),
      });

      if (!res.ok) {
        throw new Error(`Hyperliquid meta request failed: ${res.status}`);
      }

      const body = (await res.json()) as MetaResponse;
      return body.universe.map((entry) => ({ symbol: entry.name }));
    },

    async listPerpStats(): Promise<PerpStats[]> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      });

      if (!res.ok) {
        throw new Error(
          `Hyperliquid metaAndAssetCtxs request failed: ${res.status}`,
        );
      }

      const [meta, assetCtxs] = (await res.json()) as [
        MetaResponse,
        AssetCtx[],
      ];

      return meta.universe.map((entry, i) => {
        const ctx = assetCtxs[i];
        const price = Number(ctx?.markPx ?? 0);
        const prevDayPrice = Number(ctx?.prevDayPx ?? 0);
        const changePct = prevDayPrice > 0
          ? ((price - prevDayPrice) / prevDayPrice) * 100
          : 0;
        return {
          symbol: entry.name,
          price,
          changePct,
          volumeUsd: Number(ctx?.dayNtlVlm ?? 0),
          openInterestUsd: Number(ctx?.openInterest ?? 0) * price,
        };
      });
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

    async getClearinghouseState(address: string): Promise<ClearinghouseState> {
      const res = await fetch(`${baseUrl}/info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "clearinghouseState", user: address }),
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
