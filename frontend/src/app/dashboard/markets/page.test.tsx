import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Perp } from "@/lib/api";

const fetchPerpsMock = vi.fn<[], Promise<Perp[]>>();
const updatePerpTogglesMock = vi.fn<[string, Partial<Perp>], Promise<Perp>>();

vi.mock("@/lib/api", () => ({
  fetchPerps: (...args: []) => fetchPerpsMock(...args),
  updatePerpToggles: (...args: [string, Partial<Perp>]) =>
    updatePerpTogglesMock(...args),
}));

import MarketsPage from "./page";

describe("MarketsPage", () => {
  beforeEach(() => {
    fetchPerpsMock.mockReset();
    updatePerpTogglesMock.mockReset();
  });

  it("lists PERPs with their current toggle state", async () => {
    fetchPerpsMock.mockResolvedValue([
      { symbol: "BTC", tradingEnabled: false, samplingEnabled: false },
      { symbol: "ETH", tradingEnabled: true, samplingEnabled: true },
    ]);

    render(<MarketsPage />);

    await screen.findByText("BTC");
    expect(screen.getByText("ETH")).toBeInTheDocument();
    expect(screen.getByLabelText("BTC trading enabled")).not.toBeChecked();
    expect(screen.getByLabelText("ETH trading enabled")).toBeChecked();
  });

  it("enabling trading visibly also enables sampling once the server responds", async () => {
    fetchPerpsMock.mockResolvedValue([
      { symbol: "BTC", tradingEnabled: false, samplingEnabled: false },
    ]);
    updatePerpTogglesMock.mockResolvedValue({
      symbol: "BTC",
      tradingEnabled: true,
      samplingEnabled: true,
    });

    render(<MarketsPage />);
    await screen.findByText("BTC");

    fireEvent.click(screen.getByLabelText("BTC trading enabled"));

    await waitFor(() =>
      expect(screen.getByLabelText("BTC sampling enabled")).toBeChecked(),
    );
    expect(updatePerpTogglesMock).toHaveBeenCalledWith("BTC", {
      tradingEnabled: true,
    });
  });
});
