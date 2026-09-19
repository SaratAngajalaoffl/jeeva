import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it("shows a generic error on invalid credentials without navigating", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false } as Response),
    );

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "wrong" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Invalid username or password",
      ),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("navigates to /dashboard on successful login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true } as Response));

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("Username"), {
      target: { value: "admin" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct" },
    });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard"));
  });
});
