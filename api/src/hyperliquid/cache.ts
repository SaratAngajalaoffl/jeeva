import type { HyperliquidClient } from "./client.js";

export interface CachedHyperliquidClientOptions {
  /** How long the perp listing stays fresh. Markets are listed rarely. */
  perpsTtlMs?: number;
  /** How long the perp stats (prices, volume, OI) stay fresh. */
  statsTtlMs?: number;
  now?: () => number;
}

interface Entry<T> {
  value?: T;
  fetchedAt: number;
  inFlight?: Promise<T>;
}

/**
 * Each listing fans out into one request per perp DEX, so an uncached
 * dashboard load spends a large share of Hyperliquid's per-IP rate limit.
 * The cache serves a fresh value without touching Hyperliquid, shares one
 * upstream request between concurrent callers, and falls back to the last
 * good value when a refresh fails (e.g. a 429) rather than failing the
 * request.
 */
function cached<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number,
): () => Promise<T> {
  const entry: Entry<T> = { fetchedAt: 0 };

  return () => {
    if (entry.value !== undefined && now() - entry.fetchedAt < ttlMs) {
      return Promise.resolve(entry.value);
    }
    if (entry.inFlight) return entry.inFlight;

    const stale = entry.value;
    entry.inFlight = load()
      .then((value) => {
        entry.value = value;
        entry.fetchedAt = now();
        return value;
      })
      .catch((error: unknown) => {
        if (stale === undefined) throw error;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`serving stale Hyperliquid data: ${message}`);
        return stale;
      })
      .finally(() => {
        entry.inFlight = undefined;
      });
    return entry.inFlight;
  };
}

export function createCachedHyperliquidClient(
  inner: HyperliquidClient,
  {
    perpsTtlMs = 5 * 60_000,
    statsTtlMs = 30_000,
    now = Date.now,
  }: CachedHyperliquidClientOptions = {},
): HyperliquidClient {
  return {
    listPerps: cached(() => inner.listPerps(), perpsTtlMs, now),
    listPerpStats: cached(() => inner.listPerpStats(), statsTtlMs, now),
    getOrderBook: (symbol) => inner.getOrderBook(symbol),
    getRecentTrades: (symbol) => inner.getRecentTrades(symbol),
    getClearinghouseState: (address, dex) =>
      inner.getClearinghouseState(address, dex),
  };
}
