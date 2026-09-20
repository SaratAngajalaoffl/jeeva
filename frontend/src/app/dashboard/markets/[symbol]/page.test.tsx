import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionLogEntry,
  FundingPayment,
  MarketDataPoint,
  OrderBook,
  Perp,
  PerpStats,
  Position,
  Trade,
  TradingSession,
} from "@/lib/api";

const fetchMarketDataMock = vi.fn<[string], Promise<MarketDataPoint[]>>();
const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPerpStatsMock = vi.fn<[], Promise<PerpStats[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchDecisionsMock = vi.fn<
  [{ symbol?: string; sessionId?: string }?],
  Promise<DecisionLogEntry[]>
>();
const fetchFundingPaymentsMock = vi.fn<[], Promise<FundingPayment[]>>();
const fetchTradingSessionsMock = vi.fn<[string], Promise<TradingSession[]>>();
const fetchOrderBookMock = vi.fn<[string], Promise<OrderBook>>();
const fetchRecentTradesMock = vi.fn<[string], Promise<Trade[]>>();
const updatePerpConfigMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();

vi.mock("@/lib/api", () => ({
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPerpStats: (...args: []) => fetchPerpStatsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchDecisions: (...args: [{ symbol?: string; sessionId?: string }?]) =>
    fetchDecisionsMock(...args),
  fetchFundingPayments: (...args: []) => fetchFundingPaymentsMock(...args),
  fetchTradingSessions: (...args: [string]) => fetchTradingSessionsMock(...args),
  fetchOrderBook: (...args: [string]) => fetchOrderBookMock(...args),
  fetchRecentTrades: (...args: [string]) => fetchRecentTradesMock(...args),
  fetchSelectableWallets: () => Promise.resolve([]),
  updatePerpConfig: (...args: [string, Partial<Perp>]) =>
    updatePerpConfigMock(...args),
  fetchEngineMode: () => new Promise(() => {}),
  fetchDecisionMakerStatuses: () => new Promise(() => {}),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ symbol: "BTC" }),
  usePathname: () => "/dashboard/markets/BTC",
  useRouter: () => ({ push: vi.fn() }),
}));

import MarketDataPage from "./page";

describe("MarketDataPage", () => {
  beforeEach(() => {
    fetchMarketDataMock.mockReset();
    fetchPerpsMock.mockReset().mockResolvedValue([]);
    fetchPerpStatsMock.mockReset().mockResolvedValue([]);
    fetchPositionsMock.mockReset().mockResolvedValue([]);
    fetchDecisionsMock.mockReset().mockResolvedValue([]);
    fetchFundingPaymentsMock.mockReset().mockResolvedValue([]);
    fetchTradingSessionsMock.mockReset().mockResolvedValue([]);
    fetchOrderBookMock.mockReset().mockResolvedValue({ bids: [], asks: [] });
    fetchRecentTradesMock.mockReset().mockResolvedValue([]);
    updatePerpConfigMock.mockReset();
  });

  it("renders the market data chart once data loads", async () => {
    fetchMarketDataMock.mockResolvedValue([
      {
        time: "2026-01-01T00:00:00.000Z",
        price: 100,
        openInterest: 10,
        volume: 1000,
        spread: 0.5,
        midPrice: 100.25,
      },
      {
        time: "2026-01-01T00:01:00.000Z",
        price: 110,
        openInterest: 12,
        volume: 1200,
        spread: 0.6,
        midPrice: 110.3,
      },
    ]);

    render(<MarketDataPage />);

    await waitFor(() => screen.getByText("Market data"));
    expect(fetchMarketDataMock).toHaveBeenCalledWith("BTC");
  });

  it("shows an error message when loading fails", async () => {
    fetchMarketDataMock.mockRejectedValue(new Error("boom"));

    render(<MarketDataPage />);

    await waitFor(() =>
      expect(
        screen.getByText("Failed to load market data"),
      ).toBeInTheDocument(),
    );
  });

  it("shows the sampling status badge and active session count from config", async () => {
    fetchMarketDataMock.mockResolvedValue([]);
    fetchPerpsMock.mockResolvedValue([
      { symbol: "BTC", samplingEnabled: true, samplingFrequencySeconds: 30 },
    ]);
    fetchTradingSessionsMock.mockResolvedValue([
      {
        id: "session-1",
        symbol: "BTC",
        decisionMaker: "random",
        decisionFrequencySeconds: 60,
        leverage: 2,
        positionSizeUsd: 500,
        walletId: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        closedAt: null,
      },
    ]);

    render(<MarketDataPage />);

    await waitFor(() => expect(screen.getByText("Sampling: On")).toBeInTheDocument());
    expect(screen.getByText("1 active session")).toBeInTheDocument();
  });

  it("shows no open position on the Position tab when the market is flat", async () => {
    fetchMarketDataMock.mockResolvedValue([]);
    fetchPositionsMock.mockResolvedValue([]);

    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("Position"));

    await waitFor(() =>
      expect(screen.getByText("No open positions.")).toBeInTheDocument(),
    );
  });
});
