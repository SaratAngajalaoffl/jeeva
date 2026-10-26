import { describe, expect, it } from "vitest";
import {
  formatHistoryWindow,
  historyWindowSeconds,
  MAX_HISTORY_WINDOW_SECONDS,
} from "./historyWindow";

describe("historyWindowSeconds", () => {
  it("converts an amount in a unit to seconds", () => {
    expect(historyWindowSeconds("90", "minutes")).toBe(5400);
    expect(historyWindowSeconds("6", "hours")).toBe(21600);
    expect(historyWindowSeconds("1.5", "hours")).toBe(5400);
    expect(historyWindowSeconds("30", "days")).toBe(MAX_HISTORY_WINDOW_SECONDS);
  });

  it.each([
    ["0", "minutes"],
    ["", "hours"],
    ["31", "days"],
    ["0.5", "minutes"],
    ["abc", "hours"],
  ] as const)("rejects %p %s", (amount, unit) => {
    expect(historyWindowSeconds(amount, unit)).toBeNull();
  });
});

describe("formatHistoryWindow", () => {
  it("uses the largest whole unit", () => {
    expect(formatHistoryWindow(60)).toBe("last 1 minute");
    expect(formatHistoryWindow(5400)).toBe("last 90 minutes");
    expect(formatHistoryWindow(3600)).toBe("last 1 hour");
    expect(formatHistoryWindow(129600)).toBe("last 36 hours");
    expect(formatHistoryWindow(604800)).toBe("last 7 days");
    expect(formatHistoryWindow(90)).toBe("last 90 seconds");
  });
});
