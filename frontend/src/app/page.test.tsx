import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

const REPO_URL = "https://github.com/SaratAngajalaoffl/jeeva";

describe("Home", () => {
  it("renders the app title", () => {
    render(<Home />);
    // The wordmark appears in both the header and the footer.
    expect(screen.getAllByRole("img", { name: "Jeeva" }).length).toBeGreaterThan(
      0,
    );
  });

  it("leads with the engine being modular", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "A trading engine built from swappable parts.",
    );
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

  it("links to the source repository", () => {
    render(<Home />);
    const source = screen.getAllByRole("link", {
      name: /read the source|source|github/i,
    });
    expect(source.length).toBeGreaterThan(0);
    for (const link of source) {
      expect(link).toHaveAttribute("href", REPO_URL);
    }
  });

  it("names the sections a visitor can jump to", () => {
    render(<Home />);
    for (const title of [
      "An operator's trading loop, not a black box",
      "One tick, six steps, every time",
      "Three seams, and what fills them is up to you",
      "Pick who decides. Pick where it lands.",
      "The boring guarantees",
    ]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
  });

  it("presents the extension points rather than the shipped implementations", () => {
    render(<Home />);
    for (const name of [
      "MarketDataSource",
      "DecisionMaker",
      "WalletAdapter",
    ]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
  });
});
