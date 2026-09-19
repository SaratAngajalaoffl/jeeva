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

export interface Perp {
  symbol: string;
  tradingEnabled: boolean;
  samplingEnabled: boolean;
  decisionFrequencySeconds: number;
  samplingFrequencySeconds: number;
  leverage: number;
  positionSizeUsd: number;
}

export async function fetchPerps(): Promise<Perp[]> {
  const res = await fetch(`${API_URL}/perps`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load markets");
  }
  const body = (await res.json()) as { perps: Perp[] };
  return body.perps;
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

export interface MockWallet {
  initialBalanceUsd: number;
  currentBalanceUsd: number;
  allTimePnlUsd: number;
  createdAt: string;
}

export async function fetchMockWallet(): Promise<MockWallet | null> {
  const res = await fetch(`${API_URL}/mock-wallet`, {
    credentials: "include",
  });
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error("Failed to load mock wallet");
  }
  return res.json();
}

export async function createMockWallet(
  initialBalanceUsd: number,
): Promise<{ ok: true; wallet: MockWallet } | { ok: false; error: string }> {
  const res = await fetch(`${API_URL}/mock-wallet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ initialBalanceUsd }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    return { ok: false, error: body?.error ?? "Failed to create mock wallet" };
  }
  return { ok: true, wallet: await res.json() };
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
