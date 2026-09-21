import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Perp,
  PerpHealth,
  PerpStats,
  Position,
  TradingSession,
} from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPerpStatsMock = vi.fn<[], Promise<PerpStats[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchPerpHealthMock = vi.fn<[], Promise<PerpHealth[]>>();
const fetchAllTradingSessionsMock = vi.fn<[], Promise<TradingSession[]>>();
const fetchMarketDataMock = vi.fn<[string], Promise<never[]>>();
const updatePerpConfigMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPerpStats: (...args: []) => fetchPerpStatsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchPerpHealth: (...args: []) => fetchPerpHealthMock(...args),
  fetchAllTradingSessions: (...args: []) => fetchAllTradingSessionsMock(...args),
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
  updatePerpConfig: (...args: [string, Partial<Perp>]) =>
    updatePerpConfigMock(...args),
  fetchEngineMode: () => new Promise(() => {}),
  fetchDecisionMakerStatuses: () => new Promise(() => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/markets",
  useRouter: () => ({ push: vi.fn() }),
}));

import MarketsPage from "./page";

const btc: Perp = {
  symbol: "BTC",
  samplingEnabled: false,
  samplingFrequencySeconds: 60,
};

function session(overrides: Partial<TradingSession> = {}): TradingSession {
  return {
    id: "session-1",
    symbol: "BTC",
    decisionMaker: "random",
    decisionFrequencySeconds: 300,
    leverage: 1,
    positionSizeUsd: 100,
    historyWindowSamples: 1000,
    historyFormat: "summary",
    storeDecisionPayloads: false,
    walletId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("MarketsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    fetchPerpStatsMock.mockReset().mockResolvedValue([]);
    fetchPositionsMock.mockReset().mockResolvedValue([]);
    fetchPerpHealthMock.mockReset().mockResolvedValue([]);
    fetchAllTradingSessionsMock.mockReset().mockResolvedValue([]);
    fetchMarketDataMock.mockReset().mockResolvedValue([]);
    updatePerpConfigMock.mockReset();
  });

  it("lists PERPs in the market table", async () => {
    fetchPerpsMock.mockResolvedValue([
      btc,
      { ...btc, symbol: "ETH", samplingEnabled: true },
    ]);

    render(<MarketsPage />);

    await screen.findAllByText("BTC");
    expect(screen.getAllByText("ETH").length).toBeGreaterThan(0);
  });

  it("shows the sampling toggle state via icon buttons", async () => {
    fetchPerpsMock.mockResolvedValue([
      btc,
      { ...btc, symbol: "ETH", samplingEnabled: true },
    ]);

    render(<MarketsPage />);
    await screen.findAllByText("BTC");

    expect(screen.getByLabelText("BTC enable sampling")).toBeInTheDocument();
    expect(screen.getByLabelText("ETH disable sampling")).toBeInTheDocument();
  });

  it("disabling sampling directly patches the config with no dialog", async () => {
    fetchPerpsMock.mockResolvedValue([{ ...btc, samplingEnabled: true }]);
    updatePerpConfigMock.mockResolvedValue({ ...btc, samplingEnabled: false });

    render(<MarketsPage />);
    await screen.findAllByText("BTC");

    fireEvent.click(screen.getByLabelText("BTC disable sampling"));

    await waitFor(() =>
      expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
        samplingEnabled: false,
      }),
    );
  });

  it("counts a symbol's non-closed sessions as trading markets", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchAllTradingSessionsMock.mockResolvedValue([
      session({ status: "active" }),
      session({ id: "session-2", status: "closed" }),
    ]);

    render(<MarketsPage />);

    await screen.findAllByText("BTC");
    expect(screen.getAllByText("Active sessions").length).toBeGreaterThan(0);
  });

  it("shows the PERP health badge on a trading market card", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchAllTradingSessionsMock.mockResolvedValue([session()]);
    fetchPerpHealthMock.mockResolvedValue([
      {
        symbol: "BTC",
        consecutiveFailures: 3,
        lastFailureReason: "jev unavailable",
        lastFailureAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<MarketsPage />);

    await waitFor(() =>
      expect(screen.getByText("3 failures")).toBeInTheDocument(),
    );
  });

  it("shows a healthy badge when a trading market has no recorded failures", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchAllTradingSessionsMock.mockResolvedValue([session()]);
    fetchPerpHealthMock.mockResolvedValue([]);

    render(<MarketsPage />);

    await waitFor(() => expect(screen.getByText("Healthy")).toBeInTheDocument());
  });
});
