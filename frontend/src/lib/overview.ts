/**
 * Derivations behind the Overview page.
 *
 * Everything here is a pure function of what the API already returns, so
 * the page stays a layout and these stay testable. Three facts about the
 * data model drive most of it:
 *
 * - A mock wallet is attached to at most one non-closed trading session,
 *   so a session's realised P&L is exactly its wallet's drift from the
 *   initial balance.
 * - Funding payments are settled straight into that balance, so funding
 *   is already *inside* realised P&L — it is reported separately as a
 *   flow, never added on top.
 * - `mock_positions` only ever holds long/short rows; a session with no
 *   row is flat.
 */

import type {
  DecisionLogEntry,
  FundingPayment,
  MarketDataPoint,
  Position,
  TradingSession,
  Wallet,
} from "./api";

export type MarkPrices = Map<string, number>;

/** Mirrors the engine's AUTO_FLATTEN_THRESHOLD — the dashboard warns before it fires. */
export const AUTO_FLATTEN_THRESHOLD = 5;

function unrealizedPnlUsd(position: Position, markPrice: number): number {
  return (
    position.notionalUsd *
    (markPrice / position.entryPrice - 1) *
    (position.direction === "long" ? 1 : -1)
  );
}

export interface PortfolioSummary {
  /** Capital originally put into the funded (mock) wallets. */
  initialUsd: number;
  /** Settled wallet balance — realised trades and funding, no open positions. */
  balanceUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  /** Balance plus the mark-to-market of everything still open. */
  equityUsd: number;
  totalPnlUsd: number;
  /** Return on the initial capital, or null when nothing has been funded. */
  roiPct: number | null;
  /** Margin locked up by open positions (notional ÷ the session's leverage). */
  deployedMarginUsd: number;
  freeCapitalUsd: number;
  deployedPct: number;
  longExposureUsd: number;
  shortExposureUsd: number;
  grossExposureUsd: number;
  netExposureUsd: number;
  /** Gross exposure as a multiple of equity. */
  leverageX: number;
  fundedWalletCount: number;
  liveWalletCount: number;
}

export function summarisePortfolio(
  wallets: Wallet[],
  positions: Position[],
  sessions: TradingSession[],
  marks: MarkPrices,
): PortfolioSummary {
  const funded = wallets.filter((w) => w.currentBalanceUsd !== null);
  const initialUsd = funded.reduce((sum, w) => sum + (w.initialBalanceUsd ?? 0), 0);
  const balanceUsd = funded.reduce((sum, w) => sum + (w.currentBalanceUsd ?? 0), 0);
  const realizedPnlUsd = balanceUsd - initialUsd;

  const leverageBySession = new Map(sessions.map((s) => [s.id, s.leverage]));

  let unrealized = 0;
  let deployedMarginUsd = 0;
  let longExposureUsd = 0;
  let shortExposureUsd = 0;

  for (const position of positions) {
    const mark = marks.get(position.symbol);
    if (mark !== undefined) unrealized += unrealizedPnlUsd(position, mark);

    const leverage = leverageBySession.get(position.sessionId) ?? 1;
    deployedMarginUsd += position.notionalUsd / (leverage || 1);

    if (position.direction === "long") longExposureUsd += position.notionalUsd;
    else shortExposureUsd += position.notionalUsd;
  }

  const equityUsd = balanceUsd + unrealized;
  const grossExposureUsd = longExposureUsd + shortExposureUsd;

  return {
    initialUsd,
    balanceUsd,
    realizedPnlUsd,
    unrealizedPnlUsd: unrealized,
    equityUsd,
    totalPnlUsd: equityUsd - initialUsd,
    roiPct: initialUsd > 0 ? ((equityUsd - initialUsd) / initialUsd) * 100 : null,
    deployedMarginUsd,
    freeCapitalUsd: Math.max(0, balanceUsd - deployedMarginUsd),
    deployedPct: balanceUsd > 0 ? (deployedMarginUsd / balanceUsd) * 100 : 0,
    longExposureUsd,
    shortExposureUsd,
    grossExposureUsd,
    netExposureUsd: longExposureUsd - shortExposureUsd,
    leverageX: equityUsd > 0 ? grossExposureUsd / equityUsd : 0,
    fundedWalletCount: funded.length,
    liveWalletCount: wallets.filter((w) => w.kind === "live").length,
  };
}

export type TargetDirection = "long" | "short" | "flat";
export type PositionAction = "no_op" | "opened" | "closed" | "closed_and_opened";

/** Actions that moved the book; `no_op` is the engine deciding to sit still. */
export const ORDER_ACTIONS: readonly PositionAction[] = [
  "opened",
  "closed",
  "closed_and_opened",
];

/** A `closed_and_opened` cycle crosses the book twice, so it fills twice. */
const FILLS_PER_ACTION: Record<PositionAction, number> = {
  no_op: 0,
  opened: 1,
  closed: 1,
  closed_and_opened: 2,
};

export interface DecisionStats {
  total: number;
  successes: number;
  failures: number;
  successRatePct: number | null;
  avgConfidence: number | null;
  directionCounts: Record<TargetDirection, number>;
  actionCounts: Record<PositionAction, number>;
  /** Cycles that actually traded. */
  orderCount: number;
  /** Notional crossed, using each cycle's own session sizing. */
  filledNotionalUsd: number;
  lastDecisionAt: string | null;
  decisionsPerHour: number | null;
}

export function summariseDecisions(
  decisions: DecisionLogEntry[],
  sessions: TradingSession[],
): DecisionStats {
  const notionalBySession = new Map(
    sessions.map((s) => [s.id, s.positionSizeUsd * s.leverage]),
  );

  const directionCounts: Record<TargetDirection, number> = {
    long: 0,
    short: 0,
    flat: 0,
  };
  const actionCounts: Record<PositionAction, number> = {
    no_op: 0,
    opened: 0,
    closed: 0,
    closed_and_opened: 0,
  };

  let successes = 0;
  let confidenceSum = 0;
  let confidenceCount = 0;
  let orderCount = 0;
  let filledNotionalUsd = 0;
  let newest = -Infinity;
  let oldest = Infinity;

  for (const d of decisions) {
    if (d.success) successes += 1;
    if (d.targetDirection) directionCounts[d.targetDirection] += 1;
    if (d.confidence !== null) {
      confidenceSum += d.confidence;
      confidenceCount += 1;
    }
    if (d.positionAction) {
      actionCounts[d.positionAction] += 1;
      const fills = FILLS_PER_ACTION[d.positionAction];
      if (fills > 0) {
        orderCount += 1;
        const notional = d.sessionId
          ? (notionalBySession.get(d.sessionId) ?? 0)
          : 0;
        filledNotionalUsd += notional * fills;
      }
    }
    const t = new Date(d.time).getTime();
    if (t > newest) newest = t;
    if (t < oldest) oldest = t;
  }

  const spanHours = decisions.length > 1 ? (newest - oldest) / 3_600_000 : 0;

  return {
    total: decisions.length,
    successes,
    failures: decisions.length - successes,
    successRatePct: decisions.length > 0 ? (successes / decisions.length) * 100 : null,
    avgConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : null,
    directionCounts,
    actionCounts,
    orderCount,
    filledNotionalUsd,
    lastDecisionAt: decisions.length > 0 ? new Date(newest).toISOString() : null,
    decisionsPerHour: spanHours > 0 ? decisions.length / spanHours : null,
  };
}

export interface Granularity {
  bucketMs: number;
  /** Bucket start timestamps, oldest first. */
  starts: number[];
  formatLabel: (date: Date) => string;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Picks bucket size from the span the data actually covers rather than a
 * fixed calendar window — an hour of activity bucketed by day collapses
 * into a single bar.
 */
export function chooseGranularity(times: number[]): Granularity | null {
  if (times.length === 0) return null;

  const newest = Math.max(...times);
  const spanMs = newest - Math.min(...times);

  const { bucketMs, count, formatLabel } =
    spanMs <= 6 * HOUR
      ? {
          bucketMs: 15 * MINUTE,
          count: 24,
          formatLabel: (d: Date) =>
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        }
      : spanMs <= 2 * DAY
        ? {
            bucketMs: HOUR,
            count: 24,
            formatLabel: (d: Date) =>
              d.toLocaleTimeString([], { hour: "2-digit" }),
          }
        : {
            bucketMs: DAY,
            count: 14,
            formatLabel: (d: Date) => d.toISOString().slice(5, 10),
          };

  const latestStart = Math.floor(newest / bucketMs) * bucketMs;
  const starts = Array.from(
    { length: count },
    (_, i) => latestStart - (count - 1 - i) * bucketMs,
  );

  return { bucketMs, starts, formatLabel };
}

export interface BucketRow {
  label: string;
  [seriesKey: string]: number | string;
}

/** Counts items into time buckets, one column per series key. */
export function bucketCounts<T>(
  items: T[],
  getTime: (item: T) => number,
  getKey: (item: T) => string | null,
  granularity: Granularity,
): BucketRow[] {
  const rows = new Map<number, Record<string, number>>(
    granularity.starts.map((start) => [start, {}]),
  );

  for (const item of items) {
    const key = getKey(item);
    if (key === null) continue;
    const start =
      Math.floor(getTime(item) / granularity.bucketMs) * granularity.bucketMs;
    const row = rows.get(start);
    if (!row) continue;
    row[key] = (row[key] ?? 0) + 1;
  }

  return granularity.starts.map((start) => ({
    label: granularity.formatLabel(new Date(start)),
    ...rows.get(start),
  }));
}

/**
 * Top-N symbols by count with the tail folded into one "Other" bucket.
 * The returned order is the *colour assignment* order and is by symbol
 * name, not by rank, so a market keeps its hue as volumes move around.
 */
export function topSymbols(
  counts: Map<string, number>,
  limit: number,
): { symbols: string[]; hasOther: boolean } {
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([symbol]) => symbol);

  return {
    symbols: ranked.sort((a, b) => a.localeCompare(b)),
    hasOther: counts.size > ranked.length,
  };
}

export interface PerformanceSeries {
  symbols: string[];
  /** One row per time bucket; each symbol's value is its price indexed to 100. */
  rows: { t: number; [symbol: string]: number | undefined }[];
}

/**
 * Rebases every market's price history to 100 at the start of the window
 * so markets of wildly different price can share one axis — the honest
 * alternative to a second y-scale.
 */
export function buildPerformanceSeries(
  bySymbol: Map<string, MarketDataPoint[]>,
  buckets = 120,
): PerformanceSeries {
  const symbols = [...bySymbol.keys()]
    .filter((s) => (bySymbol.get(s)?.length ?? 0) > 1)
    .sort((a, b) => a.localeCompare(b));
  if (symbols.length === 0) return { symbols: [], rows: [] };

  const times = symbols.flatMap((s) =>
    (bySymbol.get(s) ?? []).map((p) => new Date(p.time).getTime()),
  );
  const start = Math.min(...times);
  const end = Math.max(...times);
  if (!(end > start)) return { symbols: [], rows: [] };

  const step = (end - start) / buckets;
  const rows: PerformanceSeries["rows"] = Array.from(
    { length: buckets + 1 },
    (_, i) => ({ t: Math.round(start + i * step) }),
  );

  for (const symbol of symbols) {
    const samples = (bySymbol.get(symbol) ?? [])
      .map((p) => ({ t: new Date(p.time).getTime(), price: p.price }))
      .sort((a, b) => a.t - b.t);
    const base = samples[0]?.price;
    if (!base) continue;

    // Walk samples and buckets together, carrying the last known price
    // forward so a market sampled less often doesn't draw a gappy line.
    let cursor = 0;
    let last: number | undefined;
    for (const row of rows) {
      while (cursor < samples.length && samples[cursor].t <= row.t) {
        last = samples[cursor].price;
        cursor += 1;
      }
      if (last !== undefined) row[symbol] = (last / base) * 100;
    }
  }

  return { symbols, rows };
}

export interface CumulativePoint {
  x: string;
  y: number;
}

export function cumulativeFunding(payments: FundingPayment[]): CumulativePoint[] {
  const sorted = [...payments].sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );
  let running = 0;
  return sorted.map((p) => {
    running += p.amountUsd;
    return { x: p.time, y: Number(running.toFixed(4)) };
  });
}

export interface PositionRow {
  position: Position;
  session: TradingSession | null;
  markPrice: number | null;
  unrealizedPnlUsd: number | null;
  pnlPct: number | null;
  marginUsd: number | null;
}

export function buildPositionRows(
  positions: Position[],
  sessions: TradingSession[],
  marks: MarkPrices,
): PositionRow[] {
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  return positions
    .map((position) => {
      const session = sessionById.get(position.sessionId) ?? null;
      const markPrice = marks.get(position.symbol) ?? null;
      const pnl = markPrice === null ? null : unrealizedPnlUsd(position, markPrice);
      return {
        position,
        session,
        markPrice,
        unrealizedPnlUsd: pnl,
        pnlPct:
          pnl === null || position.notionalUsd === 0
            ? null
            : (pnl / position.notionalUsd) * 100,
        marginUsd: session ? position.notionalUsd / (session.leverage || 1) : null,
      };
    })
    .sort(
      (a, b) => Math.abs(b.unrealizedPnlUsd ?? 0) - Math.abs(a.unrealizedPnlUsd ?? 0),
    );
}

export interface SessionRow {
  session: TradingSession;
  wallet: Wallet | null;
  /** Wallet drift from its initial balance — closed trades plus funding. */
  realizedPnlUsd: number | null;
  position: Position | null;
  unrealizedPnlUsd: number | null;
  decisionCount: number;
  lastDecisionAt: string | null;
  /** Projected from the last decision plus the session's own cadence. */
  nextDecisionAt: string | null;
}

export function buildSessionRows(
  sessions: TradingSession[],
  wallets: Wallet[],
  positions: Position[],
  decisions: DecisionLogEntry[],
  marks: MarkPrices,
): SessionRow[] {
  const walletById = new Map(wallets.map((w) => [w.id, w]));
  const positionBySession = new Map(positions.map((p) => [p.sessionId, p]));

  const lastDecisionBySession = new Map<string, number>();
  const countBySession = new Map<string, number>();
  for (const d of decisions) {
    if (!d.sessionId) continue;
    const t = new Date(d.time).getTime();
    const previous = lastDecisionBySession.get(d.sessionId);
    if (previous === undefined || t > previous) {
      lastDecisionBySession.set(d.sessionId, t);
    }
    countBySession.set(d.sessionId, (countBySession.get(d.sessionId) ?? 0) + 1);
  }

  const statusRank: Record<TradingSession["status"], number> = {
    active: 0,
    soft_closing: 1,
    hard_closing: 2,
    closed: 3,
  };

  return sessions
    .map((session) => {
      const wallet = session.walletId
        ? (walletById.get(session.walletId) ?? null)
        : null;
      const position = positionBySession.get(session.id) ?? null;
      const mark = position ? (marks.get(position.symbol) ?? null) : null;
      const lastDecision = lastDecisionBySession.get(session.id) ?? null;

      return {
        session,
        wallet,
        realizedPnlUsd:
          wallet && wallet.currentBalanceUsd !== null && wallet.initialBalanceUsd !== null
            ? wallet.currentBalanceUsd - wallet.initialBalanceUsd
            : null,
        position,
        unrealizedPnlUsd:
          position && mark !== null ? unrealizedPnlUsd(position, mark) : null,
        decisionCount: countBySession.get(session.id) ?? 0,
        lastDecisionAt: lastDecision === null ? null : new Date(lastDecision).toISOString(),
        nextDecisionAt:
          lastDecision === null || session.status === "closed"
            ? null
            : new Date(
                lastDecision + session.decisionFrequencySeconds * 1000,
              ).toISOString(),
      };
    })
    .sort(
      (a, b) =>
        statusRank[a.session.status] - statusRank[b.session.status] ||
        a.session.symbol.localeCompare(b.session.symbol),
    );
}

export type ActivityEvent =
  | { kind: "decision"; time: string; decision: DecisionLogEntry }
  | { kind: "funding"; time: string; payment: FundingPayment };

/** The decision log and the funding ledger, interleaved newest-first. */
export function buildActivityFeed(
  decisions: DecisionLogEntry[],
  payments: FundingPayment[],
  limit: number,
): ActivityEvent[] {
  const events: ActivityEvent[] = [
    ...decisions.map((decision) => ({
      kind: "decision" as const,
      time: decision.time,
      decision,
    })),
    ...payments.map((payment) => ({
      kind: "funding" as const,
      time: payment.time,
      payment,
    })),
  ];

  return events
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, limit);
}
