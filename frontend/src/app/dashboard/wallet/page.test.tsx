import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FundingPayment, MockWallet } from "@/lib/api";

const fetchMockWalletMock = vi.fn<[], Promise<MockWallet | null>>();
const createMockWalletMock = vi.fn<
  [number],
  Promise<{ ok: true; wallet: MockWallet } | { ok: false; error: string }>
>();
const fetchFundingPaymentsMock = vi.fn<[], Promise<FundingPayment[]>>();

vi.mock("@/lib/api", () => ({
  fetchMockWallet: (...args: []) => fetchMockWalletMock(...args),
  createMockWallet: (...args: [number]) => createMockWalletMock(...args),
  fetchFundingPayments: (...args: []) => fetchFundingPaymentsMock(...args),
}));

import WalletPage from "./page";

describe("WalletPage", () => {
  beforeEach(() => {
    fetchMockWalletMock.mockReset();
    createMockWalletMock.mockReset();
    fetchFundingPaymentsMock.mockReset();
    fetchFundingPaymentsMock.mockResolvedValue([]);
  });

  it("shows a creation form when no wallet exists", async () => {
    fetchMockWalletMock.mockResolvedValue(null);

    render(<WalletPage />);

    await screen.findByText("Create wallet");
    expect(screen.getByLabelText("Initial balance (USD)")).toBeInTheDocument();
  });

  it("shows balance and P&L once a wallet exists", async () => {
    fetchMockWalletMock.mockResolvedValue({
      initialBalanceUsd: 10000,
      currentBalanceUsd: 10500,
      allTimePnlUsd: 500,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    render(<WalletPage />);

    await screen.findByText("$10,000");
    expect(screen.getByText("$10,500")).toBeInTheDocument();
    expect(screen.getByText("$500")).toBeInTheDocument();
    expect(screen.queryByText("Create wallet")).not.toBeInTheDocument();
  });

  it("creates a wallet and shows its balance on success", async () => {
    fetchMockWalletMock.mockResolvedValue(null);
    createMockWalletMock.mockResolvedValue({
      ok: true,
      wallet: {
        initialBalanceUsd: 5000,
        currentBalanceUsd: 5000,
        allTimePnlUsd: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    render(<WalletPage />);
    await screen.findByText("Create wallet");

    fireEvent.change(screen.getByLabelText("Initial balance (USD)"), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByText("Create wallet"));

    await waitFor(() => expect(screen.getAllByText("$5,000")).toHaveLength(2));
    expect(createMockWalletMock).toHaveBeenCalledWith(5000);
  });

  it("shows the server's error on a rejected creation (e.g. wallet already exists)", async () => {
    fetchMockWalletMock.mockResolvedValue(null);
    createMockWalletMock.mockResolvedValue({
      ok: false,
      error: "A mock wallet already exists",
    });

    render(<WalletPage />);
    await screen.findByText("Create wallet");

    fireEvent.click(screen.getByText("Create wallet"));

    await waitFor(() =>
      expect(
        screen.getByText("A mock wallet already exists"),
      ).toBeInTheDocument(),
    );
  });

  it("shows recent funding payments once a wallet exists", async () => {
    fetchMockWalletMock.mockResolvedValue({
      initialBalanceUsd: 10000,
      currentBalanceUsd: 9999.9,
      allTimePnlUsd: -0.1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    fetchFundingPaymentsMock.mockResolvedValue([
      {
        time: "2026-01-01T01:00:00.000Z",
        symbol: "BTC",
        direction: "long",
        fundingRate: 0.0001,
        notionalUsd: 1000,
        amountUsd: -0.1,
      },
    ]);

    render(<WalletPage />);

    await screen.findByText("Recent funding payments");
    expect(await screen.findByText("BTC")).toBeInTheDocument();
    expect(screen.getByText("-0.1000")).toBeInTheDocument();
  });

  it("shows an empty state when there are no funding payments yet", async () => {
    fetchMockWalletMock.mockResolvedValue({
      initialBalanceUsd: 10000,
      currentBalanceUsd: 10000,
      allTimePnlUsd: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    render(<WalletPage />);

    expect(
      await screen.findByText("No funding payments yet."),
    ).toBeInTheDocument();
  });
});
