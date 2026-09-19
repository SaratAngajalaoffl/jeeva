import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MockWallet } from "@/lib/api";

const fetchMockWalletMock = vi.fn<[], Promise<MockWallet | null>>();
const createMockWalletMock = vi.fn<
  [number],
  Promise<{ ok: true; wallet: MockWallet } | { ok: false; error: string }>
>();

vi.mock("@/lib/api", () => ({
  fetchMockWallet: (...args: []) => fetchMockWalletMock(...args),
  createMockWallet: (...args: [number]) => createMockWalletMock(...args),
}));

import WalletPage from "./page";

describe("WalletPage", () => {
  beforeEach(() => {
    fetchMockWalletMock.mockReset();
    createMockWalletMock.mockReset();
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
});
