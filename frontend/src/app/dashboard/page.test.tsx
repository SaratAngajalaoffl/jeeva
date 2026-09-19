import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const replaceMock = vi.fn();
const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock, push: pushMock }),
}));

import DashboardPage from "./page";

describe("DashboardPage", () => {
  beforeEach(() => {
    replaceMock.mockClear();
    pushMock.mockClear();
  });

  it("redirects to /login when the session check fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false } as Response),
    );

    render(<DashboardPage />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/login"));
  });

  it("does not redirect when the session check succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));

    render(<DashboardPage />);

    await waitFor(() => screen.getByText("Dashboard"));
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
