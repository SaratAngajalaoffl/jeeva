const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${API_URL}/auth/login`, {
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
  await fetch(`${API_URL}/auth/logout`, {
    method: "POST",
    credentials: "include",
  });
}

export async function checkSession(): Promise<boolean> {
  const res = await fetch(`${API_URL}/auth/session`, {
    credentials: "include",
  });
  return res.ok;
}

// The engine's DecisionMaker implementation for this PERP: `fake`
// (synthetic, no network), `typesafe` (calls TypeSafe's Jev API
// directly), or `openrouter` (calls Jev via OpenRouter — not yet
// implemented on the engine side).
export type DecisionMaker = "fake" | "typesafe" | "openrouter";

export interface Perp {
  symbol: string;
  tradingEnabled: boolean;
  samplingEnabled: boolean;
  decisionFrequencySeconds: number;
  samplingFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
  decisionMaker: DecisionMaker;
  walletId: string | null;
}

export async function fetchPerps(): Promise<Perp[]> {
  const res = await fetch(`${API_URL}/perps`, { credentials: "include" });
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
  const res = await fetch(`${API_URL}/perps/stats`, { credentials: "include" });
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
  const res = await fetch(`${API_URL}/perps/${encodeURIComponent(symbol)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(patch),
  });
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

export async function fetchMarketData(
  symbol: string,
): Promise<MarketDataPoint[]> {
  const res = await fetch(
    `${API_URL}/perps/${encodeURIComponent(symbol)}/market-data`,
    { credentials: "include" },
  );
  if (!res.ok) {
    throw new Error("Failed to load market data");
  }
  const body = (await res.json()) as { samples: MarketDataPoint[] };
  return body.samples;
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
    `${API_URL}/perps/${encodeURIComponent(symbol)}/orderbook`,
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
    `${API_URL}/perps/${encodeURIComponent(symbol)}/trades`,
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
}

export async function fetchWallets(): Promise<Wallet[]> {
  const res = await fetch(`${API_URL}/wallets`, { credentials: "include" });
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
    `${API_URL}/wallets/selectable?symbol=${encodeURIComponent(
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
  const res = await fetch(`${API_URL}/wallets`, {
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
  const res = await fetch(`${API_URL}/wallets/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? "Failed to delete wallet" };
  }
  return { ok: true };
}

export interface Position {
  symbol: string;
  direction: "long" | "short";
  entryPrice: number;
  notionalUsd: number;
  openedAt: string;
}

export async function fetchPositions(): Promise<Position[]> {
  const res = await fetch(`${API_URL}/positions`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load positions");
  }
  const body = (await res.json()) as { positions: Position[] };
  return body.positions;
}

export interface DecisionLogEntry {
  time: string;
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
  symbol?: string,
): Promise<DecisionLogEntry[]> {
  const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  const res = await fetch(`${API_URL}/decisions${query}`, {
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
  symbol: string;
  direction: "long" | "short";
  fundingRate: number;
  notionalUsd: number;
  amountUsd: number;
}

export async function fetchFundingPayments(): Promise<FundingPayment[]> {
  const res = await fetch(`${API_URL}/funding`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load funding payments");
  }
  const body = (await res.json()) as { payments: FundingPayment[] };
  return body.payments;
}

export interface PerpHealth {
  symbol: string;
  consecutiveFailures: number;
  lastFailureReason: string | null;
  lastFailureAt: string | null;
}

export async function fetchPerpHealth(): Promise<PerpHealth[]> {
  const res = await fetch(`${API_URL}/perp-health`, {
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
}

export async function fetchEngineMode(): Promise<EngineModeStatus> {
  const res = await fetch(`${API_URL}/engine-mode`, {
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
  const res = await fetch(`${API_URL}/engine-mode`, {
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
