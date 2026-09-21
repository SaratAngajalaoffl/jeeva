import { describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_FORMAT,
  DEFAULT_HISTORY_WINDOW_SAMPLES,
  HISTORY_FORMATS,
  isValidHistoryFormat,
  isValidHistoryWindowSamples,
  MAX_HISTORY_WINDOW_SAMPLES,
} from "./historyWindow.js";

describe("isValidHistoryWindowSamples", () => {
  it.each([1, 60, 250, MAX_HISTORY_WINDOW_SAMPLES])("accepts %p", (value) => {
    expect(isValidHistoryWindowSamples(value)).toBe(true);
  });

  it.each([
    0,
    -1,
    1001,
    1.5,
    NaN,
    Infinity,
    "100",
    null,
    undefined,
  ])("rejects %p", (value) => {
    expect(isValidHistoryWindowSamples(value)).toBe(false);
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
  it("preserves the pre-configurable behavior", () => {
    // The engine previously always read up to 1000 samples and rendered
    // the averaged summary.
    expect(DEFAULT_HISTORY_WINDOW_SAMPLES).toBe(MAX_HISTORY_WINDOW_SAMPLES);
    expect(DEFAULT_HISTORY_WINDOW_SAMPLES).toBe(1000);
    expect(DEFAULT_HISTORY_FORMAT).toBe("summary");
  });
});
