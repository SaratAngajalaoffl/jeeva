import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketDataPoint } from "@/lib/api";

const fetchMarketDataMock = vi.fn<[string], Promise<MarketDataPoint[]>>();

vi.mock("@/lib/api", () => ({
  fetchMarketData: (...args: [string]) => fetchMarketDataMock(...args),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ symbol: "BTC" }),
  usePathname: () => "/dashboard/markets/BTC",
}));

import MarketDataPage from "./page";

describe("MarketDataPage", () => {
  beforeEach(() => {
    fetchMarketDataMock.mockReset();
  });

  it("renders a chart section per metric once data loads", async () => {
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

    await waitFor(() => screen.getByText("Price"));
    expect(screen.getByText("Open interest")).toBeInTheDocument();
    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(screen.getByText("Spread")).toBeInTheDocument();
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
});
