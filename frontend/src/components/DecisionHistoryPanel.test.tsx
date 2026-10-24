import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DecisionLogEntry,
  DecisionPage,
  DecisionPageQuery,
} from "@/lib/api";

const fetchDecisionPageMock =
  vi.fn<(query: DecisionPageQuery) => Promise<DecisionPage>>();

vi.mock("@/lib/api", () => ({
  fetchDecisionPage: (query: DecisionPageQuery) => fetchDecisionPageMock(query),
}));

import DecisionHistoryPanel from "./DecisionHistoryPanel";

function decision(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    time: "2026-10-24T12:00:00.000Z",
    sessionId: "f9773bb0-0000-0000-0000-000000000000",
    symbol: "BTC",
    contextSummary: "",
    targetDirection: "short",
    confidence: 0.6,
    probabilities: null,
    positionAction: "no_op",
    success: true,
    error: null,
    rawRequest: null,
    rawResponse: null,
    ...overrides,
  };
}

function lastQuery(): DecisionPageQuery {
  return fetchDecisionPageMock.mock.calls.at(-1)![0];
}

describe("DecisionHistoryPanel", () => {
  beforeEach(() => {
    fetchDecisionPageMock.mockReset().mockResolvedValue({
      decisions: [decision()],
      total: 45,
    });
  });

  it("requests the first page newest first and shows the match count", async () => {
    render(
      <DecisionHistoryPanel
        symbol="BTC"
        sessions={[]}
        range="1d"
        selection={null}
      />,
    );

    await screen.findByText("1–20 of 45");
    expect(lastQuery()).toMatchObject({
      symbol: "BTC",
      sort: "time",
      order: "desc",
      limit: 20,
      offset: 0,
    });
  });

  it("pages forward and resets to the first page when a filter changes", async () => {
    render(
      <DecisionHistoryPanel
        symbol="BTC"
        sessions={[]}
        range="1d"
        selection={null}
      />,
    );
    await screen.findByText("Page 1 of 3");

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(lastQuery().offset).toBe(20));

    fireEvent.change(screen.getByLabelText("Direction"), {
      target: { value: "long" },
    });
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ direction: "long", offset: 0 }),
    );
  });

  it("toggles confidence sorting from its column header", async () => {
    render(
      <DecisionHistoryPanel
        symbol="BTC"
        sessions={[]}
        range="1d"
        selection={null}
      />,
    );
    await screen.findByText("1–20 of 45");

    const header = screen.getByRole("button", { name: /confidence/i });
    fireEvent.click(header);
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ sort: "confidence", order: "desc" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /confidence/i }));
    await waitFor(() =>
      expect(lastQuery()).toMatchObject({ sort: "confidence", order: "asc" }),
    );
  });

  it("scopes requests to a chart selection", async () => {
    render(
      <DecisionHistoryPanel
        symbol="BTC"
        sessions={[]}
        range="1d"
        selection={{
          from: "2026-10-23T18:00:00.000Z",
          to: "2026-10-23T20:00:00.000Z",
        }}
      />,
    );

    await waitFor(() => expect(fetchDecisionPageMock).toHaveBeenCalled());
    expect(lastQuery().from).toEqual(new Date("2026-10-23T18:00:00.000Z"));
    expect(lastQuery().to).toEqual(new Date("2026-10-23T20:00:00.000Z"));
  });
});
