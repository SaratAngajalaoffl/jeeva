import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("renders the app title", () => {
    render(<Home />);
    // The wordmark appears in both the header and the footer.
    expect(
      screen.getAllByRole("img", { name: "Jeeva" }).length,
    ).toBeGreaterThan(0);
  });

  it("leads with what the product does", () => {
    render(<Home />);
    expect(
      screen.getByRole("heading", { level: 1 }),
    ).toHaveTextContent("Hyperliquid perps, traded on a logged decision.");
  });

  it("sends visitors to the login page", () => {
    render(<Home />);
    const signIn = screen.getAllByRole("link", {
      name: /open the dashboard|sign in/i,
    });
    expect(signIn.length).toBeGreaterThan(0);
    for (const link of signIn) {
      expect(link).toHaveAttribute("href", "/login");
    }
  });

  it("names the sections a visitor can jump to", () => {
    render(<Home />);
    for (const title of [
      "An operator's trading loop, not a black box",
      "One tick, six steps, every time",
      "Pick who decides. Pick where it lands.",
      "The boring guarantees",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });
});
