import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionLogEntry,
  FundingPayment,
  MarketDataHistory,
  PerpStats,
  Position,
  TradingSession,
} from "@/lib/api";

const fetchMarketDataMock = vi.fn<
  [string, { from?: Date }?],
  Promise<MarketDataHistory>
>();
const fetchPerpStatsMock = vi.fn<[], Promise<PerpStats[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchDecisionsMock = vi.fn<
  [{ sessionId?: string }],
  Promise<DecisionLogEntry[]>
>();
const fetchFundingPaymentsMock = vi.fn<
  [{ sessionId?: string }],
  Promise<FundingPayment[]>
>();
const fetchTradingSessionsMock = vi.fn<[string], Promise<TradingSession[]>>();

vi.mock("@/lib/api", () => ({
  fetchMarketData: (...args: [string, { from?: Date }?]) =>
    fetchMarketDataMock(...args),
  fetchPerpStats: () => fetchPerpStatsMock(),
  fetchPositions: () => fetchPositionsMock(),
  fetchDecisions: (...args: [{ sessionId?: string }]) =>
    fetchDecisionsMock(...args),
  fetchFundingPayments: (...args: [{ sessionId?: string }]) =>
    fetchFundingPaymentsMock(...args),
  fetchTradingSessions: (...args: [string]) =>
    fetchTradingSessionsMock(...args),
  hardCloseTradingSession: vi.fn(),
  softCloseTradingSession: vi.fn(),
  fetchEngineMode: () => Promise.resolve({ mode: "mock" }),
  setEngineMode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ symbol: "HYPE", sessionId: "d0d6f8cf-full-id" }),
  usePathname: () => "/dashboard/markets/HYPE/sessions/d0d6f8cf-full-id",
  useRouter: () => ({ push: vi.fn() }),
}));

import SessionDetailPage from "./page";

const session: TradingSession = {
  id: "d0d6f8cf-full-id",
  symbol: "HYPE",
  decisionMaker: "openrouter",
  decisionFrequencySeconds: 60,
  leverage: 5,
  positionSizeUsd: 100,
  historyWindowSamples: 1000,
  historyFormat: "raw",
  storeDecisionPayloads: false,
  stopLossPct: null,
  walletId: "b58cfc87-full-id",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};

function emptyMarketData(): MarketDataHistory {
  return { samples: [], oldestSampleTime: null };
}

describe("SessionDetailPage", () => {
  beforeEach(() => {
    fetchMarketDataMock.mockReset().mockResolvedValue(emptyMarketData());
    fetchPerpStatsMock.mockReset().mockResolvedValue([]);
    fetchPositionsMock.mockReset().mockResolvedValue([]);
    fetchDecisionsMock.mockReset().mockResolvedValue([]);
    fetchFundingPaymentsMock.mockReset().mockResolvedValue([]);
    fetchTradingSessionsMock.mockReset().mockResolvedValue([session]);
  });

  it("renders session-scoped data returned by the API", async () => {
    fetchMarketDataMock.mockResolvedValue({
      samples: [
        {
          time: "2026-01-01T00:00:00.000Z",
          price: 1.25,
          openInterest: 10,
          volume: 1000,
          spread: 0.01,
          midPrice: 1.26,
        },
        {
          time: "2026-01-01T00:01:00.000Z",
          price: 1.5,
          openInterest: 12,
          volume: 1200,
          spread: 0.01,
          midPrice: 1.51,
        },
      ],
      oldestSampleTime: "2026-01-01T00:00:00.000Z",
    });
    fetchPositionsMock.mockResolvedValue([
      {
        sessionId: session.id,
        symbol: "HYPE",
        direction: "long",
        entryPrice: 1.25,
        notionalUsd: 500,
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:01:00.000Z",
        sessionId: session.id,
        symbol: "HYPE",
        contextSummary: "context",
        targetDirection: "long",
        confidence: 0.8,
        probabilities: { long: 0.8, short: 0.1, flat: 0.1 },
        positionAction: "opened",
        success: true,
        error: null,
        rawRequest: null,
        rawResponse: null,
      },
    ]);
    fetchFundingPaymentsMock.mockResolvedValue([
      {
        time: "2026-01-01T01:00:00.000Z",
        sessionId: session.id,
        symbol: "HYPE",
        direction: "long",
        fundingRate: 0.0001,
        notionalUsd: 500,
        amountUsd: -0.05,
      },
    ]);

    render(<SessionDetailPage />);

    await waitFor(() =>
      expect(screen.getByText("Market data")).toBeInTheDocument(),
    );
    expect(fetchDecisionsMock).toHaveBeenCalledWith({ sessionId: session.id });
    expect(fetchFundingPaymentsMock).toHaveBeenCalledWith({
      sessionId: session.id,
    });
    expect((await screen.findAllByText("long")).length).toBeGreaterThan(0);
    expect(await screen.findByText("opened")).toBeInTheDocument();
    expect(await screen.findByText("-0.0500")).toBeInTheDocument();
  });

  it("shows clear empty states when an active session has no data yet", async () => {
    render(<SessionDetailPage />);

    expect(
      await screen.findByText("No data in the selected period."),
    ).toBeInTheDocument();
    expect(screen.getByText("No open position.")).toBeInTheDocument();
    expect(screen.getByText("No decisions yet.")).toBeInTheDocument();
    expect(screen.getByText("No funding payments yet.")).toBeInTheDocument();
  });

  it.each([
    ["market data", fetchMarketDataMock, "Failed to load market data."],
    ["position", fetchPositionsMock, "Failed to load position."],
    [
      "decision history",
      fetchDecisionsMock,
      "Failed to load decision history.",
    ],
    [
      "funding history",
      fetchFundingPaymentsMock,
      "Failed to load funding history.",
    ],
  ])("surfaces a failed %s request", async (_section, requestMock, message) => {
    requestMock.mockRejectedValue(new Error("boom"));

    render(<SessionDetailPage />);

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it.each([
    [
      "decision-maker",
      "decision maker request failed: 401 Unauthorized",
    ],
    ["execution-cycle", "execution cycle failed: order rejected"],
  ])("surfaces a persisted %s failure", async (_failure, error) => {
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:01:00.000Z",
        sessionId: session.id,
        symbol: "HYPE",
        contextSummary: "context",
        targetDirection: null,
        confidence: null,
        probabilities: null,
        positionAction: null,
        success: false,
        error,
        rawRequest: null,
        rawResponse: null,
      },
    ]);

    render(<SessionDetailPage />);

    expect(await screen.findByText(error)).toBeInTheDocument();
  });
});
