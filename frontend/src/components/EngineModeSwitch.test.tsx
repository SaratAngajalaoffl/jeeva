import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMode, EngineModeStatus } from "@/lib/api";

const fetchEngineModeMock = vi.fn<[], Promise<EngineModeStatus>>();
const setEngineModeMock =
  vi.fn<
    [EngineMode],
    Promise<{ ok: true; mode: EngineMode } | { ok: false; error: string }>
  >();

vi.mock("@/lib/api", () => ({
  fetchEngineMode: (...args: []) => fetchEngineModeMock(...args),
  setEngineMode: (...args: [EngineMode]) => setEngineModeMock(...args),
}));

import { EngineModeSwitch } from "./EngineModeSwitch";

describe("EngineModeSwitch", () => {
  beforeEach(() => {
    fetchEngineModeMock.mockReset();
    setEngineModeMock.mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("shows a Mock badge and disables the Mock button when already in mock mode", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "mock",
      liveWalletPublicAddress: null,
    });

    render(<EngineModeSwitch />);

    const badge = await screen.findByTestId("engine-mode-badge");
    expect(badge).toHaveTextContent("Mock");
    expect(screen.getByRole("button", { name: "Mock" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Live" })).not.toBeDisabled();
  });

  it("shows a Live badge and the wallet address when already in live mode", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "live",
      liveWalletPublicAddress: "0xabc123",
    });

    render(<EngineModeSwitch />);

    const badge = await screen.findByTestId("engine-mode-badge");
    expect(badge).toHaveTextContent("Live");
    expect(screen.getByText("0xabc123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toBeDisabled();
  });

  it("flags an unconfigured wallet in live mode instead of hiding the problem", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "live",
      liveWalletPublicAddress: null,
    });

    render(<EngineModeSwitch />);

    await screen.findByText("not configured on the engine");
  });

  it("asks for confirmation before switching to live", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "mock",
      liveWalletPublicAddress: null,
    });
    setEngineModeMock.mockResolvedValue({ ok: true, mode: "live" });

    render(<EngineModeSwitch />);
    await screen.findByTestId("engine-mode-badge");

    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    expect(window.confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(setEngineModeMock).toHaveBeenCalledWith("live"));
  });

  it("does not switch when the confirmation is declined", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "mock",
      liveWalletPublicAddress: null,
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<EngineModeSwitch />);
    await screen.findByTestId("engine-mode-badge");

    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    expect(setEngineModeMock).not.toHaveBeenCalled();
  });

  it("switching back to mock does not require confirmation", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "live",
      liveWalletPublicAddress: "0xabc123",
    });
    setEngineModeMock.mockResolvedValue({ ok: true, mode: "mock" });

    render(<EngineModeSwitch />);
    await screen.findByTestId("engine-mode-badge");

    fireEvent.click(screen.getByRole("button", { name: "Mock" }));

    expect(window.confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(setEngineModeMock).toHaveBeenCalledWith("mock"));
  });

  it("updates the badge after a successful switch", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "mock",
      liveWalletPublicAddress: null,
    });
    setEngineModeMock.mockResolvedValue({ ok: true, mode: "live" });

    render(<EngineModeSwitch />);
    await screen.findByTestId("engine-mode-badge");

    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    await waitFor(() =>
      expect(screen.getByTestId("engine-mode-badge")).toHaveTextContent(
        "Live",
      ),
    );
  });

  it("shows an error message when the switch fails", async () => {
    fetchEngineModeMock.mockResolvedValue({
      mode: "mock",
      liveWalletPublicAddress: null,
    });
    setEngineModeMock.mockResolvedValue({
      ok: false,
      error: "live mode is not configured",
    });

    render(<EngineModeSwitch />);
    await screen.findByTestId("engine-mode-badge");

    fireEvent.click(screen.getByRole("button", { name: "Live" }));

    await screen.findByText("live mode is not configured");
    expect(screen.getByTestId("engine-mode-badge")).toHaveTextContent("Mock");
  });

  it("shows an error message when the initial fetch fails", async () => {
    fetchEngineModeMock.mockRejectedValue(new Error("network error"));

    render(<EngineModeSwitch />);

    await screen.findByText("Failed to load engine mode");
  });
});
