import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_FORMAT,
  DEFAULT_HISTORY_WINDOW_SECONDS,
  HISTORY_FORMATS,
  isValidHistoryFormat,
  isValidHistoryWindowSeconds,
  MAX_HISTORY_WINDOW_SECONDS,
  MIN_HISTORY_WINDOW_SECONDS,
} from "./historyWindow.js";

describe("isValidHistoryWindowSeconds", () => {
  it.each([
    MIN_HISTORY_WINDOW_SECONDS,
    3600,
    86400,
    MAX_HISTORY_WINDOW_SECONDS,
  ])("accepts %p", (value) => {
    expect(isValidHistoryWindowSeconds(value)).toBe(true);
  });

  it.each([
    0,
    59,
    -1,
    MAX_HISTORY_WINDOW_SECONDS + 1,
    90.5,
    NaN,
    Infinity,
    "100",
    null,
    undefined,
  ])("rejects %p", (value) => {
    expect(isValidHistoryWindowSeconds(value)).toBe(false);
  });
});

describe("isValidHistoryFormat", () => {
  it.each(HISTORY_FORMATS)("accepts %p", (value) => {
    expect(isValidHistoryFormat(value)).toBe(true);
  });

  it.each(["averaged", "SUMMARY", "", null, undefined])(
    "rejects %p",
    (value) => {
      expect(isValidHistoryFormat(value)).toBe(false);
    },
  );
});

describe("defaults", () => {
  it("reads the last day as an averaged summary", () => {
    expect(DEFAULT_HISTORY_WINDOW_SECONDS).toBe(24 * 60 * 60);
    expect(DEFAULT_HISTORY_FORMAT).toBe("summary");
  });
});
