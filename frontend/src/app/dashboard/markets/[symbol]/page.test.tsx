import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionLogEntry,
  FundingPayment,
  MarketDataHistory,
  MarketDataRange,
  OrderBook,
  Perp,
  PerpStats,
  Position,
  Trade,
  TradingSession,
} from "@/lib/api";
import type { ClosedTrade } from "@/lib/api";

const fetchMarketDataMock = vi.fn<[string], Promise<MarketDataHistory>>();
const fetchMarketDataRangeMock = vi.fn<[string], Promise<MarketDataRange>>();
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
const fetchTradeHistoryMock = vi.fn<
  [{ symbol?: string; sessionId?: string }?],
  Promise<ClosedTrade[]>
>();

vi.mock("@/lib/api", () => ({
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
  fetchMarketDataRange: (...args: [string]) =>
    fetchMarketDataRangeMock(...args),
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPerpStats: (...args: []) => fetchPerpStatsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchDecisions: (...args: [{ symbol?: string; sessionId?: string }?]) =>
    fetchDecisionsMock(...args),
  fetchFundingPayments: (...args: []) => fetchFundingPaymentsMock(...args),
  fetchTradingSessions: (...args: [string]) =>
    fetchTradingSessionsMock(...args),
  fetchOrderBook: (...args: [string]) => fetchOrderBookMock(...args),
  fetchRecentTrades: (...args: [string]) => fetchRecentTradesMock(...args),
  fetchTradeHistory: (...args: [{ symbol?: string; sessionId?: string }?]) =>
    fetchTradeHistoryMock(...args),
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

function expectedDateTimeLocal(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number, length = 2) =>
    String(value).padStart(length, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

describe("MarketDataPage", () => {
  beforeEach(() => {
    fetchMarketDataMock.mockReset().mockResolvedValue({
      samples: [],
      oldestSampleTime: null,
    });
    fetchMarketDataRangeMock.mockReset().mockResolvedValue({
      earliest: null,
      latest: null,
    });
    fetchPerpsMock.mockReset().mockResolvedValue([]);
    fetchPerpStatsMock.mockReset().mockResolvedValue([]);
    fetchPositionsMock.mockReset().mockResolvedValue([]);
    fetchDecisionsMock.mockReset().mockResolvedValue([]);
    fetchFundingPaymentsMock.mockReset().mockResolvedValue([]);
    fetchTradingSessionsMock.mockReset().mockResolvedValue([]);
    fetchOrderBookMock.mockReset().mockResolvedValue({ bids: [], asks: [] });
    fetchRecentTradesMock.mockReset().mockResolvedValue([]);
    fetchTradeHistoryMock.mockReset().mockResolvedValue([]);
    updatePerpConfigMock.mockReset();
  });

  it("renders the market data chart once data loads", async () => {
    fetchMarketDataMock.mockResolvedValue({
      samples: [
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
      ],
      oldestSampleTime: "2026-01-01T00:00:00.000Z",
    });

    render(<MarketDataPage />);

    await waitFor(() => screen.getByText("Market data"));
    expect(fetchMarketDataMock).toHaveBeenCalledWith(
      "BTC",
      expect.objectContaining({ from: expect.any(Date) }),
    );
  });

  it("discovers and prefills the exact local market-data range in backtest mode", async () => {
    const earliest = "2026-09-20T21:19:00.432Z";
    const latest = "2026-09-20T21:19:00.900Z";
    fetchMarketDataRangeMock.mockResolvedValue({ earliest, latest });
    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("New session"));
    expect(fetchMarketDataRangeMock).not.toHaveBeenCalled();
    fireEvent.change(await screen.findByLabelText("Session type"), {
      target: { value: "backtest" },
    });

    const expectedStart = expectedDateTimeLocal(earliest);
    const expectedEnd = expectedDateTimeLocal(latest);
    const start = screen.getByLabelText("Start");
    const end = screen.getByLabelText("End");
    await waitFor(() => {
      expect(start).toHaveValue(expectedStart);
      expect(end).toHaveValue(expectedEnd);
    });

    expect(fetchMarketDataRangeMock).toHaveBeenCalledWith("BTC");
    expect(start).toHaveAttribute("min", expectedStart);
    expect(start).toHaveAttribute("max", expectedEnd);
    expect(start).toHaveAttribute("step", "0.001");
    expect(end).toHaveAttribute("min", expectedStart);
    expect(end).toHaveAttribute("max", expectedEnd);
    expect(end).toHaveAttribute("step", "0.001");
    expect(screen.getByText(/Data available \(local time\)/)).toHaveTextContent(
      `${new Date(earliest).toLocaleString()} – ${new Date(latest).toLocaleString()}`,
    );
  });

  it("preserves entered dates when a late range response arrives", async () => {
    let resolveRange: (range: MarketDataRange) => void = () => {};
    fetchMarketDataRangeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRange = resolve;
      }),
    );
    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("New session"));
    fireEvent.change(await screen.findByLabelText("Session type"), {
      target: { value: "backtest" },
    });
    const start = screen.getByLabelText("Start");
    const end = screen.getByLabelText("End");
    fireEvent.change(start, { target: { value: "2026-09-20T21:20:00.123" } });
    fireEvent.change(end, { target: { value: "2026-09-21T17:00:00.456" } });

    resolveRange({
      earliest: "2026-09-20T21:19:00.432Z",
      latest: "2026-09-21T18:04:12.987Z",
    });

    await waitFor(() => {
      expect(start).toHaveAttribute("min");
      expect(end).toHaveAttribute("max");
    });
    expect(start).toHaveValue("2026-09-20T21:20:00.123");
    expect(end).toHaveValue("2026-09-21T17:00:00.456");
  });

  it("shows no available data when the range lookup fails", async () => {
    fetchMarketDataRangeMock.mockRejectedValue(new Error("boom"));
    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("New session"));
    fireEvent.change(await screen.findByLabelText("Session type"), {
      target: { value: "backtest" },
    });

    expect(
      await screen.findByText(
        "No market data is available for this market yet.",
      ),
    ).toBeInTheDocument();
  });

  it("reports when the market has only one sample", async () => {
    const sampleTime = "2026-09-20T21:19:00.432Z";
    fetchMarketDataRangeMock.mockResolvedValue({
      earliest: sampleTime,
      latest: sampleTime,
    });
    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("New session"));
    fireEvent.change(await screen.findByLabelText("Session type"), {
      target: { value: "backtest" },
    });

    expect(
      await screen.findByText("Not enough market data yet to run a backtest."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Start")).toHaveValue("");
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
    fetchMarketDataMock.mockResolvedValue({
      samples: [],
      oldestSampleTime: null,
    });
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
        historyWindowSamples: 1000,
        historyFormat: "summary",
        storeDecisionPayloads: false,
        walletId: null,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        closedAt: null,
      },
    ]);

    render(<MarketDataPage />);

    await waitFor(() =>
      expect(screen.getByText("Sampling: On")).toBeInTheDocument(),
    );
    expect(screen.getByText("1 active session")).toBeInTheDocument();
  });

  it("shows no open position on the Position tab when the market is flat", async () => {
    fetchMarketDataMock.mockResolvedValue({
      samples: [],
      oldestSampleTime: null,
    });
    fetchPositionsMock.mockResolvedValue([]);

    render(<MarketDataPage />);

    fireEvent.click(await screen.findByText("Position"));

    await waitFor(() =>
      expect(screen.getByText("No open positions.")).toBeInTheDocument(),
    );
  });
});
