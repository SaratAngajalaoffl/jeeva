import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LineChart from "./LineChart";

describe("LineChart", () => {
  it("renders an accessible chart image labelled by its series", () => {
    render(
      <LineChart
        label="Price"
        points={[
          { x: "2026-01-01T00:00:00.000Z", y: 100 },
          { x: "2026-01-01T00:01:00.000Z", y: 110 },
        ]}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Price over time" }),
    ).toBeInTheDocument();
  });

  it("shows a placeholder when there are no points", () => {
    render(<LineChart label="Price" points={[]} />);
    expect(screen.getByText("No data yet.")).toBeInTheDocument();
  });

  it("uses the caller's empty state copy", () => {
    render(<LineChart label="Funding" points={[]} emptyLabel="No funding yet." />);
    expect(screen.getByText("No funding yet.")).toBeInTheDocument();
  });
});
