import { describe, expect, it } from "vitest";
import { isValidFrequencySeconds } from "./frequency.js";

describe("isValidFrequencySeconds", () => {
  it.each([1, 60, 300, 3600, 86400])("accepts %p", (value) => {
    expect(isValidFrequencySeconds(value)).toBe(true);
  });

  it.each([
    0,
    -1,
    -100,
    NaN,
    Infinity,
    -Infinity,
    86401,
    "60",
    null,
    undefined,
  ])("rejects %p", (value) => {
    expect(isValidFrequencySeconds(value)).toBe(false);
  });
});
