/**
 * The API base URL is resolved at runtime, not inlined at build time.
 * The container serves its configured API_URL from /runtime-config, so
 * the same built image can be reused across instances pointing at
 * different backends. The first request resolves and memoizes it.
 */
const FALLBACK_API_URL = "http://localhost:4000";

let apiUrlPromise: Promise<string> | null = null;

function loadApiUrl(): Promise<string> {
  if (!apiUrlPromise) {
    apiUrlPromise = fetch("/runtime-config", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { apiUrl?: unknown } | null) => {
        const url = typeof body?.apiUrl === "string" ? body.apiUrl.trim() : "";
        return url || FALLBACK_API_URL;
      })
      .catch(() => FALLBACK_API_URL);
  }
  return apiUrlPromise;
}

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${await loadApiUrl()}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    return { ok: false, error: "Invalid username or password" };
  }
  return { ok: true };
}

export async function logout(): Promise<void> {
  await fetch(`${await loadApiUrl()}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function checkSession(): Promise<boolean> {
  const res = await fetch(`${await loadApiUrl()}/auth/session`, {
    credentials: "include",
  });
  return res.ok;
}

/** True when the deployment runs with DEMO_MODE=true. */
export async function fetchDemoMode(): Promise<boolean> {
  const res = await fetch(`${await loadApiUrl()}/health`);
  if (!res.ok) return false;
  const body: { demoMode?: unknown } = await res.json();
  return body.demoMode === true;
}

// The engine's DecisionMaker implementation for this PERP: `random`
// (synthetic, no network), `typesafe` (calls TypeSafe's Jev API
// directly), or `openrouter` (calls Jev via OpenRouter).
export type DecisionMaker = "random" | "typesafe" | "openrouter";

export interface Perp {
  symbol: string;
  samplingEnabled: boolean;
  samplingFrequencySeconds: number;
}

export async function fetchPerps(): Promise<Perp[]> {
  const res = await fetch(`${await loadApiUrl()}/perps`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load markets");
  }
  const body = (await res.json()) as { perps: Perp[] };
  return body.perps;
}

export interface PerpStats {
  symbol: string;
  price: number;
  changePct: number;
  volumeUsd: number;
  openInterestUsd: number;
}

export async function fetchPerpStats(): Promise<PerpStats[]> {
  const res = await fetch(`${await loadApiUrl()}/perps/stats`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load market stats");
  }
  const body = (await res.json()) as { stats: PerpStats[] };
  return body.stats;
}

export async function updatePerpConfig(
  symbol: string,
  patch: Partial<Omit<Perp, "symbol">>,
): Promise<Perp> {
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    throw new Error("Failed to update market");
  }
  return res.json();
}

export interface MarketDataPoint {
  time: string;
  price: number;
  openInterest: number;
  volume: number;
  spread: number;
  midPrice: number;
}

/**
 * A history window. Omitted entirely, the API defaults to the last 24h;
 * `limit` is capped server-side at 1000 rows.
 */
export interface HistoryQuery {
  from?: Date;
  to?: Date;
  limit?: number;
}

function historyParams(query: HistoryQuery): string {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from.toISOString());
  if (query.to) params.set("to", query.to.toISOString());
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  return params.toString();
}

export interface MarketDataHistory {
  samples: MarketDataPoint[];
  /** Earliest recorded sample for the symbol, null when none exist. */
  oldestSampleTime: string | null;
}

export async function fetchMarketData(
  symbol: string,
  query: HistoryQuery = {},
): Promise<MarketDataHistory> {
  const params = historyParams(query);
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}/market-data${
      params ? `?${params}` : ""
    }`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load market data");
  }
  return res.json();
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export async function fetchOrderBook(symbol: string): Promise<OrderBook> {
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}/orderbook`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load order book");
  }
  return res.json();
}

export interface Trade {
  time: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export async function fetchRecentTrades(symbol: string): Promise<Trade[]> {
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}/trades`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load recent trades");
  }
  const body = (await res.json()) as { trades: Trade[] };
  return body.trades;
}

export type WalletKind = "mock" | "live";

export interface Wallet {
  id: string;
  label: string;
  kind: WalletKind;
  publicAddress: string | null;
  initialBalanceUsd: number | null;
  currentBalanceUsd: number | null;
  createdAt: string;
  /** The non-closed trading session this wallet is attached to, if any. */
  activeSessionId: string | null;
}

export async function fetchWallets(): Promise<Wallet[]> {
  const res = await fetch(`${await loadApiUrl()}/wallets`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load wallets");
  }
  const body = (await res.json()) as { wallets: Wallet[] };
  return body.wallets;
}

export async function fetchSelectableWallets(
  symbol: string,
  sizeUsd: number,
): Promise<Wallet[]> {
  const res = await fetch(
    `${await loadApiUrl()}/wallets/selectable?symbol=${encodeURIComponent(
      symbol,
    )}&sizeUsd=${encodeURIComponent(sizeUsd)}`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load selectable wallets");
  }
  const body = (await res.json()) as { wallets: Wallet[] };
  return body.wallets;
}

export type CreateWalletInput =
  | { kind: "mock"; label: string; initialBalanceUsd: number }
  | { kind: "live"; label: string; publicAddress: string; privateKey: string };

export async function createWallet(
  input: CreateWalletInput,
): Promise<{ ok: true; wallet: Wallet } | { ok: false; error: string }> {
  const res = await fetch(`${await loadApiUrl()}/wallets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? "Failed to create wallet" };
  }
  return { ok: true, wallet: await res.json() };
}

export async function deleteWallet(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(
    `${await loadApiUrl()}/wallets/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      credentials: "include",
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? "Failed to delete wallet" };
  }
  return { ok: true };
}

export type TradingSessionStatus =
  "active" | "soft_closing" | "hard_closing" | "closed";

export type HistoryFormat = "summary" | "raw";

export interface TradingSession {
  id: string;
  symbol: string;
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  /** How many recent market-data samples the engine reads for this session's decision context. */
  historyWindowSamples: number;
  /** Whether that window reaches the decision maker raw, or averaged into a min/max/avg summary. */
  historyFormat: HistoryFormat;
  walletId: string | null;
  status: TradingSessionStatus;
  createdAt: string;
  closedAt: string | null;
}

export async function fetchTradingSessions(
  symbol: string,
): Promise<TradingSession[]> {
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}/trading-sessions`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load trading sessions");
  }
  const body = (await res.json()) as { sessions: TradingSession[] };
  return body.sessions;
}

export async function fetchAllTradingSessions(): Promise<TradingSession[]> {
  const res = await fetch(`${await loadApiUrl()}/trading-sessions`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load trading sessions");
  }
  const body = (await res.json()) as { sessions: TradingSession[] };
  return body.sessions;
}

export interface CreateTradingSessionInput {
  decisionMaker: DecisionMaker;
  decisionFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  /** Omit to accept the API default (the maximum window). */
  historyWindowSamples?: number;
  /** Omit to accept the API default ("summary"). */
  historyFormat?: HistoryFormat;
  walletId?: string | null;
}

export async function createTradingSession(
  symbol: string,
  input: CreateTradingSessionInput,
): Promise<
  { ok: true; session: TradingSession } | { ok: false; error: string }
> {
  const res = await fetch(
    `${await loadApiUrl()}/perps/${encodeURIComponent(symbol)}/trading-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return {
      ok: false,
      error: body?.error ?? "Failed to create trading session",
    };
  }
  return { ok: true, session: await res.json() };
}

async function postTradingSessionAction(
  id: string,
  action: "attach-wallet" | "detach-wallet" | "soft-close" | "hard-close",
  body?: unknown,
): Promise<
  { ok: true; session: TradingSession } | { ok: false; error: string }
> {
  const res = await fetch(
    `${await loadApiUrl()}/trading-sessions/${encodeURIComponent(id)}/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
  );
  if (!res.ok) {
    const resBody = await res.json().catch(() => null);
    return {
      ok: false,
      error: resBody?.error ?? `Failed to ${action} session`,
    };
  }
  return { ok: true, session: await res.json() };
}

export function attachSessionWallet(id: string, walletId: string) {
  return postTradingSessionAction(id, "attach-wallet", { walletId });
}

export function detachSessionWallet(id: string) {
  return postTradingSessionAction(id, "detach-wallet");
}

export function softCloseTradingSession(id: string) {
  return postTradingSessionAction(id, "soft-close");
}

export function hardCloseTradingSession(id: string) {
  return postTradingSessionAction(id, "hard-close");
}

export interface Position {
  sessionId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
}

export async function fetchPositions(): Promise<Position[]> {
  const res = await fetch(`${await loadApiUrl()}/positions`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load positions");
  }
  const body = (await res.json()) as { positions: Position[] };
  return body.positions;
}

export interface DecisionLogEntry {
  time: string;
  sessionId: string | null;
  symbol: string;
  contextSummary: string;
  targetDirection: "long" | "short" | "flat" | null;
  confidence: number | null;
  probabilities: { long: number; short: number; flat: number } | null;
  positionAction: "no_op" | "opened" | "closed" | "closed_and_opened" | null;
  success: boolean;
  error: string | null;
}

export async function fetchDecisions(
  filter: { symbol?: string; sessionId?: string } & HistoryQuery = {},
): Promise<DecisionLogEntry[]> {
  const params = new URLSearchParams(historyParams(filter));
  if (filter.symbol) params.set("symbol", filter.symbol);
  if (filter.sessionId) params.set("sessionId", filter.sessionId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${await loadApiUrl()}/decisions${query}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load decision history");
  }
  const body = (await res.json()) as { decisions: DecisionLogEntry[] };
  return body.decisions;
}

export interface FundingPayment {
  time: string;
  sessionId: string | null;
  symbol: string;
  direction: "long" | "short";
  fundingRate: number;
  notionalUsd: number;
  amountUsd: number;
}

export async function fetchFundingPayments(
  query: HistoryQuery = {},
): Promise<FundingPayment[]> {
  const params = historyParams(query);
  const res = await fetch(
    `${await loadApiUrl()}/funding${params ? `?${params}` : ""}`,
    {
      credentials: "include",
    },
  );
  if (!res.ok) {
    throw new Error("Failed to load funding payments");
  }
  const body = (await res.json()) as { payments: FundingPayment[] };
  return body.payments;
}

export interface ClosedTrade {
  sessionId: string;
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
  exitPrice: number;
  pnlUsd: number;
  closedAt: string;
}

export async function fetchTradeHistory(
  filter: { symbol?: string; sessionId?: string } & HistoryQuery = {},
): Promise<ClosedTrade[]> {
  const params = new URLSearchParams(historyParams(filter));
  if (filter.symbol) params.set("symbol", filter.symbol);
  if (filter.sessionId) params.set("sessionId", filter.sessionId);
  const query = params.toString() ? `?${params.toString()}` : "";
  const res = await fetch(`${await loadApiUrl()}/trades/history${query}`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load trade history");
  }
  const body = (await res.json()) as { trades: ClosedTrade[] };
  return body.trades;
}

export interface PerpHealth {
  symbol: string;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
}

export async function fetchPerpHealth(): Promise<PerpHealth[]> {
  const res = await fetch(`${await loadApiUrl()}/perp-health`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load PERP health");
  }
  const body = (await res.json()) as { health: PerpHealth[] };
  return body.health;
}

export type EngineMode = "mock" | "live";

export interface EngineModeStatus {
  mode: EngineMode;
  /** True when the deployment runs with DEMO_MODE=true. */
  demoMode?: boolean;
}

export async function fetchEngineMode(): Promise<EngineModeStatus> {
  const res = await fetch(`${await loadApiUrl()}/engine-mode`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load engine mode");
  }
  return res.json();
}

export async function setEngineMode(
  mode: EngineMode,
): Promise<{ ok: true; mode: EngineMode } | { ok: false; error: string }> {
  const res = await fetch(`${await loadApiUrl()}/engine-mode`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? "Failed to switch engine mode" };
  }
  const body = (await res.json()) as { mode: EngineMode };
  return { ok: true, mode: body.mode };
}

export interface DecisionMakerStatus {
  id: "random" | "typesafe" | "openrouter";
  label: string;
  configured: boolean;
  reachable: boolean;
}

export async function fetchDecisionMakerStatuses(): Promise<
  DecisionMakerStatus[]
> {
  const res = await fetch(`${await loadApiUrl()}/decision-makers/status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error("Failed to load decision maker status");
  }
  const body = (await res.json()) as { statuses: DecisionMakerStatus[] };
  return body.statuses;
}
