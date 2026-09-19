import { render, screen, waitFor } from "@testing-library/react";
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
} from "@/lib/api";

const fetchMarketDataMock = vi.fn<[string], Promise<MarketDataPoint[]>>();
const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPerpStatsMock = vi.fn<[], Promise<PerpStats[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchDecisionsMock = vi.fn<[string?], Promise<DecisionLogEntry[]>>();
const fetchFundingPaymentsMock = vi.fn<[], Promise<FundingPayment[]>>();
const fetchOrderBookMock = vi.fn<[string], Promise<OrderBook>>();
const fetchRecentTradesMock = vi.fn<[string], Promise<Trade[]>>();
const updatePerpConfigMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();

vi.mock("@/lib/api", () => ({
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPerpStats: (...args: []) => fetchPerpStatsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchDecisions: (...args: [string?]) => fetchDecisionsMock(...args),
  fetchFundingPayments: (...args: []) => fetchFundingPaymentsMock(...args),
  fetchOrderBook: (...args: [string]) => fetchOrderBookMock(...args),
  fetchRecentTrades: (...args: [string]) => fetchRecentTradesMock(...args),
  updatePerpConfig: (...args: [string, Partial<Perp>]) =>
    updatePerpConfigMock(...args),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ symbol: "BTC" }),
  usePathname: () => "/dashboard/markets/BTC",
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

  it("shows the sampling/trading status badges from the PERP config", async () => {
    fetchMarketDataMock.mockResolvedValue([]);
    fetchPerpsMock.mockResolvedValue([
      {
        symbol: "BTC",
        tradingEnabled: true,
        samplingEnabled: true,
        decisionFrequencySeconds: 60,
        samplingFrequencySeconds: 30,
        leverage: 2,
        positionSizeUsd: 500,
      },
    ]);

    render(<MarketDataPage />);

    await waitFor(() => expect(screen.getByText("Sampling: On")).toBeInTheDocument());
    expect(screen.getByText("Trading: On")).toBeInTheDocument();
  });

  it("shows no open position when the PERP is flat", async () => {
    fetchMarketDataMock.mockResolvedValue([]);
    fetchPositionsMock.mockResolvedValue([]);

    render(<MarketDataPage />);

    await waitFor(() =>
      expect(screen.getByText("No open position.")).toBeInTheDocument(),
    );
  });
});
