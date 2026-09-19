import { describe, expect, it } from "vitest";
import { isValidLeverage, isValidPositionSizeUsd } from "./sizing.js";

describe("isValidLeverage", () => {
  it.each([1, 3, 10, 50])("accepts %p", (value) => {
    expect(isValidLeverage(value)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 51, "5", null, undefined])(
    "rejects %p",
    (value) => {
      expect(isValidLeverage(value)).toBe(false);
    },
  );
});

describe("isValidPositionSizeUsd", () => {
  it.each([1, 100, 5000, 1_000_000])("accepts %p", (value) => {
    expect(isValidPositionSizeUsd(value)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 1_000_001, "100", null, undefined])(
    "rejects %p",
    (value) => {
      expect(isValidPositionSizeUsd(value)).toBe(false);
    },
  );
});
