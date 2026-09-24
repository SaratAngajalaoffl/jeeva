import { describe, expect, it } from "vitest";
import {
  bucketCounts,
  buildActivityFeed,
  buildPerformanceSeries,
  buildPositionRows,
  buildSessionRows,
  chooseGranularity,
  cumulativeFunding,
  summariseDecisions,
  summarisePortfolio,
  topSymbols,
} from "./overview";
import type {
  DecisionLogEntry,
  FundingPayment,
  MarketDataPoint,
  Position,
  TradingSessionRow,
  Wallet,
} from "./api";

function wallet(overrides: Partial<Wallet> = {}): Wallet {
  return {
    id: "w1",
    label: "Mock",
    kind: "mock",
    publicAddress: null,
    initialBalanceUsd: 100,
    currentBalanceUsd: 100,
    createdAt: "2026-09-20T09:00:00.000Z",
    activeSessionId: null,
    ...overrides,
  };
}

function session(overrides: Partial<TradingSessionRow> = {}): TradingSessionRow {
  return {
    id: "s1",
    symbol: "BTC",
    decisionMaker: "random",
    decisionFrequencySeconds: 300,
    leverage: 1,
    positionSizeUsd: 100,
    historyWindowSamples: 1000,
    historyFormat: "summary",
    storeDecisionPayloads: false,
    stopLossPct: null,
    walletId: "w1",
    status: "active",
    createdAt: "2026-09-20T09:00:00.000Z",
    closedAt: null,
    realizedPnlUsd: 0,
    ...overrides,
  };
}

function position(overrides: Partial<Position> = {}): Position {
  return {
    sessionId: "s1",
    symbol: "BTC",
    direction: "long",
    entryPrice: 100,
    notionalUsd: 100,
    openedAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

function decision(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    time: "2026-09-20T10:00:00.000Z",
    sessionId: "s1",
    symbol: "BTC",
    contextSummary: "",
    targetDirection: "long",
    confidence: 0.7,
    probabilities: { long: 0.7, short: 0.1, flat: 0.2 },
    positionAction: "opened",
    success: true,
    error: null,
    rawRequest: null,
    rawResponse: null,
    ...overrides,
  };
}

describe("summarisePortfolio", () => {
  it("marks open positions to market on top of the settled balance", () => {
    const summary = summarisePortfolio(
      [wallet({ currentBalanceUsd: 110 })],
      [position()],
      [session()],
      new Map([["BTC", 110]]),
    );

    // The wallet has realised +10, and the open long is 10% up on $100.
    expect(summary.realizedPnlUsd).toBe(10);
    expect(summary.unrealizedPnlUsd).toBeCloseTo(10);
    expect(summary.equityUsd).toBeCloseTo(120);
    expect(summary.totalPnlUsd).toBeCloseTo(20);
    expect(summary.roiPct).toBeCloseTo(20);
  });

  it("loses money on a short when the market rallies", () => {
    const summary = summarisePortfolio(
      [wallet()],
      [position({ direction: "short" })],
      [session()],
      new Map([["BTC", 120]]),
    );

    expect(summary.unrealizedPnlUsd).toBeCloseTo(-20);
    expect(summary.shortExposureUsd).toBe(100);
    expect(summary.longExposureUsd).toBe(0);
    expect(summary.netExposureUsd).toBe(-100);
  });

  it("treats notional over the session's leverage as the margin at work", () => {
    const summary = summarisePortfolio(
      [wallet({ currentBalanceUsd: 100 })],
      [position({ notionalUsd: 300 })],
      [session({ leverage: 3 })],
      new Map([["BTC", 100]]),
    );

    expect(summary.deployedMarginUsd).toBe(100);
    expect(summary.freeCapitalUsd).toBe(0);
    expect(summary.deployedPct).toBe(100);
    expect(summary.leverageX).toBeCloseTo(3);
  });

  it("ignores wallets with no balance and reports no ROI without funding", () => {
    const summary = summarisePortfolio(
      [
        wallet({
          id: "live",
          kind: "live",
          initialBalanceUsd: null,
          currentBalanceUsd: null,
        }),
      ],
      [],
      [],
      new Map(),
    );

    expect(summary.fundedWalletCount).toBe(0);
    expect(summary.liveWalletCount).toBe(1);
    expect(summary.roiPct).toBeNull();
  });

  it("skips positions whose market has no live mark price", () => {
    const summary = summarisePortfolio(
      [wallet()],
      [position({ symbol: "DOGE" })],
      [session()],
      new Map(),
    );

    expect(summary.unrealizedPnlUsd).toBe(0);
    expect(summary.equityUsd).toBe(100);
  });
});

describe("summariseDecisions", () => {
  it("counts directions, actions and failures", () => {
    const stats = summariseDecisions(
      [
        decision(),
        decision({ targetDirection: "short", positionAction: "closed_and_opened" }),
        decision({ targetDirection: "flat", positionAction: "no_op" }),
        decision({ success: false, positionAction: null, targetDirection: null }),
      ],
      [session()],
    );

    expect(stats.total).toBe(4);
    expect(stats.failures).toBe(1);
    expect(stats.successRatePct).toBe(75);
    expect(stats.directionCounts).toEqual({ long: 1, short: 1, flat: 1 });
    expect(stats.actionCounts.no_op).toBe(1);
    expect(stats.orderCount).toBe(2);
  });

  it("counts a flip as two fills of the session's notional", () => {
    const stats = summariseDecisions(
      [
        decision({ positionAction: "opened" }),
        decision({ positionAction: "closed_and_opened" }),
        decision({ positionAction: "no_op" }),
      ],
      [session({ positionSizeUsd: 100, leverage: 2 })],
    );

    // 200 notional: one fill to open, two more to flip.
    expect(stats.filledNotionalUsd).toBe(600);
  });

  it("has no rate or average to report for an empty window", () => {
    const stats = summariseDecisions([], []);
    expect(stats.successRatePct).toBeNull();
    expect(stats.avgConfidence).toBeNull();
    expect(stats.decisionsPerHour).toBeNull();
    expect(stats.lastDecisionAt).toBeNull();
  });
});

describe("chooseGranularity and bucketCounts", () => {
  it("buckets a short burst by the quarter hour", () => {
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const granularity = chooseGranularity([base, base + 60 * 60 * 1000]);

    expect(granularity?.bucketMs).toBe(15 * 60 * 1000);
    expect(granularity?.starts).toHaveLength(24);
  });

  it("buckets a multi-day span by day", () => {
    const base = Date.parse("2026-09-01T10:00:00.000Z");
    const granularity = chooseGranularity([base, base + 10 * 24 * 60 * 60 * 1000]);

    expect(granularity?.bucketMs).toBe(24 * 60 * 60 * 1000);
  });

  it("returns a column per series key and drops items outside the window", () => {
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const granularity = chooseGranularity([base, base + 60 * 60 * 1000])!;

    const rows = bucketCounts(
      [
        { t: base + 60 * 60 * 1000, key: "long" },
        { t: base + 60 * 60 * 1000, key: "long" },
        { t: base + 60 * 60 * 1000, key: "short" },
        { t: base - 40 * 60 * 60 * 1000, key: "long" },
      ],
      (item) => item.t,
      (item) => item.key,
      granularity,
    );

    const total = rows.reduce((sum, row) => sum + Number(row.long ?? 0), 0);
    expect(total).toBe(2);
    expect(rows[rows.length - 1].short).toBe(1);
  });
});

describe("topSymbols", () => {
  it("keeps the busiest symbols but returns them in name order", () => {
    const { symbols, hasOther } = topSymbols(
      new Map([
        ["SOL", 1],
        ["BTC", 9],
        ["ETH", 5],
      ]),
      2,
    );

    expect(symbols).toEqual(["BTC", "ETH"]);
    expect(hasOther).toBe(true);
  });
});

describe("buildPerformanceSeries", () => {
  function sample(time: string, price: number): MarketDataPoint {
    return { time, price, openInterest: 0, volume: 0, spread: 0, midPrice: price };
  }

  it("rebases every market to 100 so they share one axis", () => {
    const series = buildPerformanceSeries(
      new Map([
        [
          "BTC",
          [
            sample("2026-09-20T10:00:00.000Z", 50_000),
            sample("2026-09-20T11:00:00.000Z", 55_000),
          ],
        ],
        [
          "HYPE",
          [
            sample("2026-09-20T10:00:00.000Z", 40),
            sample("2026-09-20T11:00:00.000Z", 38),
          ],
        ],
      ]),
      4,
    );

    expect(series.symbols).toEqual(["BTC", "HYPE"]);
    const last = series.rows[series.rows.length - 1];
    expect(last.BTC).toBeCloseTo(110);
    expect(last.HYPE).toBeCloseTo(95);
  });

  it("ignores markets with too little history to draw", () => {
    const series = buildPerformanceSeries(
      new Map([["BTC", [sample("2026-09-20T10:00:00.000Z", 1)]]]),
    );
    expect(series.symbols).toEqual([]);
    expect(series.rows).toEqual([]);
  });
});

describe("cumulativeFunding", () => {
  it("runs payments up in time order regardless of input order", () => {
    const payments: FundingPayment[] = [
      {
        time: "2026-09-20T11:00:00.000Z",
        sessionId: "s1",
        symbol: "BTC",
        direction: "long",
        fundingRate: 0.0001,
        notionalUsd: 100,
        amountUsd: -0.5,
      },
      {
        time: "2026-09-20T10:00:00.000Z",
        sessionId: "s1",
        symbol: "BTC",
        direction: "long",
        fundingRate: 0.0001,
        notionalUsd: 100,
        amountUsd: 2,
      },
    ];

    expect(cumulativeFunding(payments)).toEqual([
      { x: "2026-09-20T10:00:00.000Z", y: 2 },
      { x: "2026-09-20T11:00:00.000Z", y: 1.5 },
    ]);
  });
});

describe("buildPositionRows", () => {
  it("attaches the session, the mark and the percentage move", () => {
    const [row] = buildPositionRows(
      [position()],
      [session({ leverage: 2 })],
      new Map([["BTC", 105]]),
    );

    expect(row.session?.id).toBe("s1");
    expect(row.unrealizedPnlUsd).toBeCloseTo(5);
    expect(row.pnlPct).toBeCloseTo(5);
    expect(row.marginUsd).toBe(50);
  });

  it("orders by how much is at stake", () => {
    const rows = buildPositionRows(
      [
        position({ sessionId: "small", symbol: "BTC" }),
        position({ sessionId: "big", symbol: "ETH", notionalUsd: 1000 }),
      ],
      [session({ id: "small" }), session({ id: "big", symbol: "ETH" })],
      new Map([
        ["BTC", 101],
        ["ETH", 110],
      ]),
    );

    expect(rows.map((r) => r.position.sessionId)).toEqual(["big", "small"]);
  });
});

describe("buildSessionRows", () => {
  it("uses session-scoped realised P&L, not reused wallet history", () => {
    const [row] = buildSessionRows(
      [session({ realizedPnlUsd: 0 })],
      [wallet({ currentBalanceUsd: 129.8 })],
      [],
      [],
      new Map(),
    );

    expect(row.realizedPnlUsd).toBe(0);
    expect(row.position).toBeNull();
    expect(row.nextDecisionAt).toBeNull();
  });

  it("uses a fresh session's realised P&L value", () => {
    const [row] = buildSessionRows(
      [session({ realizedPnlUsd: -1.5 })],
      [wallet({ currentBalanceUsd: 98.5 })],
      [],
      [],
      new Map(),
    );

    expect(row.realizedPnlUsd).toBeCloseTo(-1.5);
  });

  it("projects the next tick from the last decision and the cadence", () => {
    const [row] = buildSessionRows(
      [session({ decisionFrequencySeconds: 300 })],
      [wallet()],
      [],
      [decision({ time: "2026-09-20T10:00:00.000Z" })],
      new Map(),
    );

    expect(row.decisionCount).toBe(1);
    expect(row.nextDecisionAt).toBe("2026-09-20T10:05:00.000Z");
  });

  it("sorts active sessions above closed ones", () => {
    const rows = buildSessionRows(
      [
        session({ id: "done", symbol: "AAA", status: "closed", walletId: null }),
        session({ id: "live", symbol: "ZZZ" }),
      ],
      [wallet()],
      [],
      [],
      new Map(),
    );

    expect(rows.map((r) => r.session.id)).toEqual(["live", "done"]);
  });
});

describe("buildActivityFeed", () => {
  it("interleaves decisions and funding newest first", () => {
    const feed = buildActivityFeed(
      [
        decision({ time: "2026-09-20T10:00:00.000Z" }),
        decision({ time: "2026-09-20T12:00:00.000Z" }),
      ],
      [
        {
          time: "2026-09-20T11:00:00.000Z",
          sessionId: "s1",
          symbol: "BTC",
          direction: "long",
          fundingRate: 0.0001,
          notionalUsd: 100,
          amountUsd: 0.01,
        },
      ],
      2,
    );

    expect(feed.map((e) => e.kind)).toEqual(["decision", "funding"]);
    expect(feed[0].time).toBe("2026-09-20T12:00:00.000Z");
  });
});
