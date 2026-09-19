import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LineChart from "./LineChart";

describe("LineChart", () => {
  it("renders the title and an accessible chart image", () => {
    render(
      <LineChart
        title="Price"
        points={[
          { x: "2026-01-01T00:00:00.000Z", y: 100 },
          { x: "2026-01-01T00:01:00.000Z", y: 110 },
        ]}
      />,
    );

    expect(screen.getByText("Price")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Price over time" }),
    ).toBeInTheDocument();
  });

  it("shows a placeholder when there are no points", () => {
    render(<LineChart title="Price" points={[]} />);
    expect(screen.getByText("No data yet.")).toBeInTheDocument();
  });
});
