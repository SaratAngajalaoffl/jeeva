import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Perp } from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const updatePerpConfigMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  updatePerpConfig: (...args: [string, Partial<Perp>]) =>
    updatePerpConfigMock(...args),
}));

import MarketsPage from "./page";

const btc: Perp = {
  symbol: "BTC",
  tradingEnabled: false,
  samplingEnabled: false,
  decisionFrequencySeconds: 300,
  samplingFrequencySeconds: 60,
};

describe("MarketsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    updatePerpConfigMock.mockReset();
  });

  it("lists PERPs with their current toggle state", async () => {
    fetchPerpsMock.mockResolvedValue([
      btc,
      { ...btc, symbol: "ETH", tradingEnabled: true, samplingEnabled: true },
    ]);

    render(<MarketsPage />);

    await screen.findByText("BTC");
    expect(screen.getByText("ETH")).toBeInTheDocument();
    expect(screen.getByLabelText("BTC trading enabled")).not.toBeChecked();
    expect(screen.getByLabelText("ETH trading enabled")).toBeChecked();
  });

  it("shows the current decision and sampling frequencies", async () => {
    fetchPerpsMock.mockResolvedValue([
      { ...btc, decisionFrequencySeconds: 120, samplingFrequencySeconds: 15 },
    ]);

    render(<MarketsPage />);
    await screen.findByText("BTC");

    expect(screen.getByLabelText("BTC decision frequency seconds")).toHaveValue(
      120,
    );
    expect(screen.getByLabelText("BTC sampling frequency seconds")).toHaveValue(
      15,
    );
  });

  it("enabling trading visibly also enables sampling once the server responds", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    updatePerpConfigMock.mockResolvedValue({
      ...btc,
      tradingEnabled: true,
      samplingEnabled: true,
    });

    render(<MarketsPage />);
    await screen.findByText("BTC");

    fireEvent.click(screen.getByLabelText("BTC trading enabled"));

    await waitFor(() =>
      expect(screen.getByLabelText("BTC sampling enabled")).toBeChecked(),
    );
    expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
      tradingEnabled: true,
    });
  });

  it("saves an edited decision frequency on blur", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    updatePerpConfigMock.mockResolvedValue({
      ...btc,
      decisionFrequencySeconds: 900,
    });

    render(<MarketsPage />);
    await screen.findByText("BTC");

    const input = screen.getByLabelText("BTC decision frequency seconds");
    fireEvent.change(input, { target: { value: "900" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
        decisionFrequencySeconds: 900,
      }),
    );
  });

  it("saves an edited sampling frequency on blur", async () => {
    fetchPerpsMock.mockResolvedValue([btc]);
    updatePerpConfigMock.mockResolvedValue({
      ...btc,
      samplingFrequencySeconds: 5,
    });

    render(<MarketsPage />);
    await screen.findByText("BTC");

    const input = screen.getByLabelText("BTC sampling frequency seconds");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);

    await waitFor(() =>
      expect(updatePerpConfigMock).toHaveBeenCalledWith("BTC", {
        samplingFrequencySeconds: 5,
      }),
    );
  });
});
