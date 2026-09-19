import { describe, expect, it } from "vitest";
import { isValidInitialBalanceUsd } from "./balance.js";

describe("isValidInitialBalanceUsd", () => {
  it.each([1, 100, 10_000, 100_000_000])("accepts %p", (value) => {
    expect(isValidInitialBalanceUsd(value)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 100_000_001, "100", null, undefined])(
    "rejects %p",
    (value) => {
      expect(isValidInitialBalanceUsd(value)).toBe(false);
    },
  );
});
