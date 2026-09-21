import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

import LoginPage from "./page";

/**
 * Stubs `fetch` for both calls the page makes on mount/submit: the login
 * request (reads `ok`) and the demo-mode probe (reads `json`).
 */
function stubFetch(ok: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok, json: async () => ({}) } as Response),
  );
}

describe("LoginPage", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it("shows a generic error on invalid credentials without navigating", async () => {
    stubFetch(false);

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
    stubFetch(true);

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

  it("links back to the home page", () => {
    stubFetch(true);

    render(<LoginPage />);

    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
