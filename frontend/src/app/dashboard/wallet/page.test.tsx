import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateWalletInput,
  EngineMode,
  EngineModeStatus,
  FundingPayment,
  LiveExecutionHold,
  Wallet,
} from "@/lib/api";

const fetchWalletsMock = vi.fn<[], Promise<Wallet[]>>();
const createWalletMock = vi.fn<
  [CreateWalletInput],
  Promise<{ ok: true; wallet: Wallet } | { ok: false; error: string }>
>();
const deleteWalletMock = vi.fn<
  [string],
  Promise<{ ok: true } | { ok: false; error: string }>
>();
const fetchFundingPaymentsMock = vi.fn<[], Promise<FundingPayment[]>>();
const fetchEngineModeMock = vi.fn<[], Promise<EngineModeStatus>>();
const setEngineModeMock =
  vi.fn<
    [EngineMode],
    Promise<{ ok: true; mode: EngineMode } | { ok: false; error: string }>
  >();
const fetchLiveExecutionHoldsMock = vi.fn<
  [string],
  Promise<LiveExecutionHold[]>
>();
const clearLiveExecutionHoldMock = vi.fn<
  [string, string],
  Promise<{ ok: true } | { ok: false; error: string }>
>();

vi.mock("@/lib/api", () => ({
  fetchWallets: (...args: []) => fetchWalletsMock(...args),
  createWallet: (...args: [CreateWalletInput]) => createWalletMock(...args),
  deleteWallet: (...args: [string]) => deleteWalletMock(...args),
  fetchFundingPayments: (...args: []) => fetchFundingPaymentsMock(...args),
  fetchEngineMode: (...args: []) => fetchEngineModeMock(...args),
  setEngineMode: (...args: [EngineMode]) => setEngineModeMock(...args),
  fetchLiveExecutionHolds: (...args: [string]) =>
    fetchLiveExecutionHoldsMock(...args),
  clearLiveExecutionHold: (...args: [string, string]) =>
    clearLiveExecutionHoldMock(...args),
  fetchDecisionMakerStatuses: () => new Promise(() => {}),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/wallet",
  useRouter: () => ({ push: vi.fn() }),
}));

import WalletPage from "./page";

describe("WalletPage", () => {
  beforeEach(() => {
    fetchWalletsMock.mockReset();
    createWalletMock.mockReset();
    deleteWalletMock.mockReset();
    fetchFundingPaymentsMock.mockReset();
    fetchFundingPaymentsMock.mockResolvedValue([]);
    fetchEngineModeMock.mockReset();
    fetchEngineModeMock.mockResolvedValue({ mode: "mock" });
    setEngineModeMock.mockReset();
    fetchLiveExecutionHoldsMock.mockReset();
    fetchLiveExecutionHoldsMock.mockResolvedValue([]);
    clearLiveExecutionHoldMock.mockReset();
    clearLiveExecutionHoldMock.mockResolvedValue({ ok: true });
  });

  it("shows an empty state and can open the creation form when no wallets exist", async () => {
    fetchWalletsMock.mockResolvedValue([]);

    render(<WalletPage />);

    await screen.findByText(/No wallets yet\./);
    fireEvent.click(screen.getAllByText("Add wallet")[0]);
    expect(screen.getByText("Create wallet")).toBeInTheDocument();
  });

  it("lists existing wallets with balance and address", async () => {
    fetchWalletsMock.mockResolvedValue([
      {
        id: "1",
        label: "Mock main",
        kind: "mock",
        publicAddress: null,
        initialBalanceUsd: 10000,
        currentBalanceUsd: 10500,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeSessionId: null,
      },
      {
        id: "2",
        label: "Live main",
        kind: "live",
        publicAddress: "0xabc123",
        initialBalanceUsd: null,
        currentBalanceUsd: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeSessionId: null,
      },
    ]);

    render(<WalletPage />);

    await screen.findByText("Mock main");
    expect(screen.getAllByText("$10,500").length).toBeGreaterThan(0);
    expect(screen.getByText("0xabc123")).toBeInTheDocument();
  });

  it("creates a mock wallet and shows it in the list on success", async () => {
    fetchWalletsMock.mockResolvedValue([]);
    createWalletMock.mockResolvedValue({
      ok: true,
      wallet: {
        id: "3",
        label: "New mock",
        kind: "mock",
        publicAddress: null,
        initialBalanceUsd: 5000,
        currentBalanceUsd: 5000,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeSessionId: null,
      },
    });

    render(<WalletPage />);
    await screen.findByText(/No wallets yet\./);
    fireEvent.click(screen.getAllByText("Add wallet")[0]);

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "New mock" },
    });
    fireEvent.change(screen.getByLabelText("Initial balance (USD)"), {
      target: { value: "5000" },
    });
    fireEvent.click(screen.getByText("Create wallet"));

    await waitFor(() => expect(screen.getByText("New mock")).toBeInTheDocument());
    expect(createWalletMock).toHaveBeenCalledWith({
      kind: "mock",
      label: "New mock",
      initialBalanceUsd: 5000,
    });
  });

  it("shows the server's error on a rejected creation (e.g. duplicate label)", async () => {
    fetchWalletsMock.mockResolvedValue([]);
    createWalletMock.mockResolvedValue({
      ok: false,
      error: "A wallet with this label already exists",
    });

    render(<WalletPage />);
    await screen.findByText(/No wallets yet\./);
    fireEvent.click(screen.getAllByText("Add wallet")[0]);

    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Dup" },
    });
    fireEvent.click(screen.getByText("Create wallet"));

    await waitFor(() =>
      expect(
        screen.getByText("A wallet with this label already exists"),
      ).toBeInTheDocument(),
    );
  });

  it("shows recent funding payments", async () => {
    fetchWalletsMock.mockResolvedValue([]);
    fetchFundingPaymentsMock.mockResolvedValue([
      {
        time: "2026-01-01T01:00:00.000Z",
        sessionId: null,
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
    fetchWalletsMock.mockResolvedValue([]);

    render(<WalletPage />);

    expect(
      await screen.findByText("No funding payments yet."),
    ).toBeInTheDocument();
  });

  it("surfaces a live wallet's halted PERP and lets the operator acknowledge it", async () => {
    fetchWalletsMock.mockResolvedValue([
      {
        id: "2",
        label: "Live main",
        kind: "live",
        publicAddress: "0xabc123",
        initialBalanceUsd: null,
        currentBalanceUsd: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeSessionId: null,
      },
    ]);
    fetchLiveExecutionHoldsMock.mockResolvedValue([
      {
        symbol: "BTC",
        reason: "drift policy halt: SizeMismatch",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<WalletPage />);

    expect(await screen.findByText("Execution halted")).toBeInTheDocument();
    expect(screen.getByText("drift policy halt: SizeMismatch")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Acknowledge"));

    await waitFor(() =>
      expect(clearLiveExecutionHoldMock).toHaveBeenCalledWith("2", "BTC"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Execution halted")).not.toBeInTheDocument(),
    );
  });

  it("does not show a hold banner for a mock wallet", async () => {
    fetchWalletsMock.mockResolvedValue([
      {
        id: "1",
        label: "Mock main",
        kind: "mock",
        publicAddress: null,
        initialBalanceUsd: 10000,
        currentBalanceUsd: 10000,
        createdAt: "2026-01-01T00:00:00.000Z",
        activeSessionId: null,
      },
    ]);
    fetchLiveExecutionHoldsMock.mockResolvedValue([
      {
        symbol: "BTC",
        reason: "drift policy halt: SizeMismatch",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    render(<WalletPage />);

    await screen.findByText("Mock main");
    expect(screen.queryByText("Execution halted")).not.toBeInTheDocument();
    expect(fetchLiveExecutionHoldsMock).not.toHaveBeenCalled();
  });
});
