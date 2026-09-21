import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionLogEntry, Perp, Position, TradingSession } from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchAllTradingSessionsMock = vi.fn<[], Promise<TradingSession[]>>();
const fetchDecisionsMock = vi.fn<
  [{ symbol?: string; sessionId?: string }?],
  Promise<DecisionLogEntry[]>
>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchAllTradingSessions: (...args: []) => fetchAllTradingSessionsMock(...args),
  fetchDecisions: (...args: [{ symbol?: string; sessionId?: string }?]) =>
    fetchDecisionsMock(...args),
  fetchPerpStats: () => Promise.resolve([]),
  fetchPerpHealth: () => Promise.resolve([]),
  fetchEngineMode: () => new Promise(() => {}),
  fetchDecisionMakerStatuses: () => new Promise(() => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/decisions",
  useRouter: () => ({ push: vi.fn() }),
}));

import DecisionsPage from "./page";

const btc: Perp = {
  symbol: "BTC",
  samplingEnabled: true,
  samplingFrequencySeconds: 30,
};

const activeBtcSession: TradingSession = {
  id: "session-1",
  symbol: "BTC",
  decisionMaker: "random",
  decisionFrequencySeconds: 60,
  leverage: 2,
  positionSizeUsd: 100,
  historyWindowSamples: 1000,
  historyFormat: "summary",
  storeDecisionPayloads: false,
  walletId: null,
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: null,
};

describe("DecisionsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    fetchPositionsMock.mockReset();
    fetchAllTradingSessionsMock.mockReset().mockResolvedValue([]);
    fetchDecisionsMock.mockReset();
    fetchDecisionsMock.mockResolvedValue([]);
  });

  it("shows flat for a trading-enabled PERP with no open position", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);
    fetchAllTradingSessionsMock.mockResolvedValue([activeBtcSession]);

    render(<DecisionsPage />);

    expect(await screen.findByText("flat")).toBeInTheDocument();
  });

  it("shows the open position's direction, entry price, and notional", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchAllTradingSessionsMock.mockResolvedValue([activeBtcSession]);
    fetchPositionsMock.mockResolvedValue([
      {
        sessionId: "session-1",
        symbol: "BTC",
        direction: "long",
        entryPrice: 65000,
        notionalUsd: 200,
        openedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<DecisionsPage />);

    await screen.findByText("long");
    expect(screen.getByText("65,000")).toBeInTheDocument();
    expect(screen.getAllByText("$200").length).toBeGreaterThan(0);
  });

  it("renders decision history rows", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);
    fetchAllTradingSessionsMock.mockResolvedValue([activeBtcSession]);
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:00:00.000Z",
        sessionId: "session-1",
        symbol: "BTC",
        contextSummary: "context",
        targetDirection: "long",
        confidence: 0.7,
        probabilities: { long: 0.7, short: 0.1, flat: 0.2 },
        positionAction: "opened",
        success: true,
        error: null,
      },
    ]);

    render(<DecisionsPage />);

    await screen.findByText("opened");
    expect(screen.getByText("0.70")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
  });

  it("shows an error status with the error message for a failed cycle", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);
    fetchAllTradingSessionsMock.mockResolvedValue([activeBtcSession]);
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:00:00.000Z",
        sessionId: null,
        symbol: "BTC",
        contextSummary: "no data",
        targetDirection: null,
        confidence: null,
        probabilities: null,
        positionAction: null,
        success: false,
        error: "no market data available yet",
      },
    ]);

    render(<DecisionsPage />);

    await screen.findByText("error: no market data available yet");
  });

  it("refetches decisions when the symbol filter changes", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);
    fetchAllTradingSessionsMock.mockResolvedValue([activeBtcSession]);

    render(<DecisionsPage />);
    await screen.findByRole("option", { name: "BTC" });

    fireEvent.change(screen.getByLabelText("Filter by symbol"), {
      target: { value: "BTC" },
    });

    await waitFor(() =>
      expect(fetchDecisionsMock).toHaveBeenCalledWith({ symbol: "BTC" }),
    );
  });
});
