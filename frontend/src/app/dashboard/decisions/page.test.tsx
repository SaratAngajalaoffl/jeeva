import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionLogEntry, Perp, Position } from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchDecisionsMock = vi.fn<
  [string | undefined],
  Promise<DecisionLogEntry[]>
>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchDecisions: (...args: [string | undefined]) =>
    fetchDecisionsMock(...args),
}));

import DecisionsPage from "./page";

const btc: Perp = {
  symbol: "BTC",
  tradingEnabled: true,
  samplingEnabled: true,
  decisionFrequencySeconds: 60,
  samplingFrequencySeconds: 30,
  leverage: 2,
  positionSizeUsd: 100,
  decisionMaker: "fake",
  walletId: null,
};

describe("DecisionsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    fetchPositionsMock.mockReset();
    fetchDecisionsMock.mockReset();
    fetchDecisionsMock.mockResolvedValue([]);
  });

  it("shows flat for a trading-enabled PERP with no open position", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);

    render(<DecisionsPage />);

    expect(await screen.findByText("flat")).toBeInTheDocument();
  });

  it("shows the open position's direction, entry price, and notional", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([
      {
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
    expect(screen.getByText("200")).toBeInTheDocument();
  });

  it("renders decision history rows", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    fetchPositionsMock.mockResolvedValue([]);
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:00:00.000Z",
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
    fetchDecisionsMock.mockResolvedValue([
      {
        time: "2026-01-01T00:00:00.000Z",
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

    render(<DecisionsPage />);
    await screen.findByText("Filter by symbol");

    fireEvent.change(screen.getByLabelText("Filter by symbol"), {
      target: { value: "BTC" },
    });

    await waitFor(() => expect(fetchDecisionsMock).toHaveBeenCalledWith("BTC"));
  });
});
