import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Perp, PerpHealth, PerpStats, Position, Wallet } from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const fetchPerpStatsMock = vi.fn<[], Promise<PerpStats[]>>();
const fetchPositionsMock = vi.fn<[], Promise<Position[]>>();
const fetchPerpHealthMock = vi.fn<[], Promise<PerpHealth[]>>();
const fetchMarketDataMock = vi.fn<[string], Promise<never[]>>();
const updatePerpConfigMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();
const fetchSelectableWalletsMock = vi.fn<
  [string, number],
  Promise<Wallet[]>
>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  fetchPerpStats: (...args: []) => fetchPerpStatsMock(...args),
  fetchPositions: (...args: []) => fetchPositionsMock(...args),
  fetchPerpHealth: (...args: []) => fetchPerpHealthMock(...args),
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
  fetchSelectableWallets: (...args: [string, number]) =>
    fetchSelectableWalletsMock(...args),
  updatePerpConfig: (...args: [string, Partial<Perp>]) =>
    updatePerpConfigMock(...args),
}));

import MarketsPage from "./page";

const testWallet: Wallet = {
  id: "wallet-1",
  label: "Test wallet",
  kind: "mock",
  publicAddress: null,
  initialBalanceUsd: 10000,
  currentBalanceUsd: 10000,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const btc: Perp = {
  symbol: "BTC",
  tradingEnabled: false,
  samplingEnabled: false,
  decisionFrequencySeconds: 300,
  samplingFrequencySeconds: 60,
  leverage: 1,
  positionSizeUsd: 100,
  decisionMaker: "fake",
  walletId: null,
};

describe("MarketsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    fetchPerpStatsMock.mockReset().mockResolvedValue([]);
    fetchPositionsMock.mockReset().mockResolvedValue([]);
    fetchPerpHealthMock.mockReset().mockResolvedValue([]);
    fetchMarketDataMock.mockReset().mockResolvedValue([]);
    fetchSelectableWalletsMock.mockReset().mockResolvedValue([testWallet]);
    updatePerpConfigMock.mockReset();
  });

  it("lists PERPs in the market table", async () => {
    fetchPerpsMock.mockResolvedValue([
      btc,
      { ...btc, symbol: "ETH", tradingEnabled: true, samplingEnabled: true },
    ]);

    render(<MarketsPage />);

    await screen.findAllByText("BTC");
    expect(screen.getAllByText("ETH").length).toBeGreaterThan(0);
  });

  it("shows the trading/sampling toggle state via icon buttons", async () => {
    fetchPerpsMock.mockResolvedValue([
      btc,
      { ...btc, symbol: "ETH", tradingEnabled: true, samplingEnabled: true },
    ]);

    render(<MarketsPage />);
    await screen.findAllByText("BTC");

    expect(
      screen.getByLabelText("BTC enable sampling"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("BTC enable trading")).toBeInTheDocument();
    expect(
      screen.getByLabelText("ETH disable sampling"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("ETH disable trading")).toBeInTheDocument();
  });

  it("disabling trading directly patches the config with no dialog", async () => {
    fetchPerpsMock.mockResolvedValue([
      { ...btc, tradingEnabled: true, samplingEnabled: true },
    ]);
    updatePerpConfigMock.mockResolvedValue({
      ...btc,
      tradingEnabled: false,
      samplingEnabled: true,
    });

    render(<MarketsPage />);
    await screen.findAllByText("BTC");

    fireEvent.click(screen.getByLabelText("BTC disable trading"));

    await waitFor(() =>
      expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
        tradingEnabled: false,
      }),
    );
  });

  it("enabling trading opens a dialog and submits the configured values", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    updatePerpConfigMock.mockResolvedValue({
      ...btc,
      tradingEnabled: true,
      samplingEnabled: true,
      decisionFrequencySeconds: 30,
      leverage: 5,
      positionSizeUsd: 250,
    });

    render(<MarketsPage />);
    await screen.findAllByText("BTC");

    fireEvent.click(screen.getByLabelText("BTC enable trading"));

    await screen.findByText("Enable trading — BTC");
    fireEvent.change(screen.getByLabelText("Decision frequency (seconds)"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByLabelText("Leverage"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Position size (USD)"), {
      target: { value: "250" },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Wallet")).toHaveValue("wallet-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Enable trading" }));

    await waitFor(() =>
      expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
        tradingEnabled: true,
        decisionFrequencySeconds: 30,
        leverage: 5,
        positionSizeUsd: 250,
        decisionMaker: "fake",
        walletId: "wallet-1",
      }),
    );
  });

  it("shows the PERP health badge on a trading market card", async () => {
    fetchPerpsMock.mockResolvedValue([
      { ...btc, tradingEnabled: true, samplingEnabled: true },
    ]);
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
    fetchPerpsMock.mockResolvedValue([
      { ...btc, tradingEnabled: true, samplingEnabled: true },
    ]);
    fetchPerpHealthMock.mockResolvedValue([]);

    render(<MarketsPage />);

    await waitFor(() => expect(screen.getByText("Healthy")).toBeInTheDocument());
  });
});
