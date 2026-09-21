import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MIN_SAMPLING_FREQUENCY_SECONDS,
  getMinSamplingFrequencySeconds,
  isValidFrequencySeconds,
  isValidSamplingFrequencySeconds,
} from "./frequency.js";

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

describe("getMinSamplingFrequencySeconds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults when unset", () => {
    vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", "");
    expect(getMinSamplingFrequencySeconds()).toBe(
      DEFAULT_MIN_SAMPLING_FREQUENCY_SECONDS,
    );
  });

  it("reads the configured minimum", () => {
    vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", "30");
    expect(getMinSamplingFrequencySeconds()).toBe(30);
  });

  it.each(["0", "-5", "not-a-number", "86401"])(
    "throws on the malformed value %p",
    (value) => {
      vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", value);
      expect(() => getMinSamplingFrequencySeconds()).toThrow();
    },
  );
});

describe("isValidSamplingFrequencySeconds", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts values at or above the default minimum", () => {
    vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", "");
    expect(isValidSamplingFrequencySeconds(1)).toBe(true);
  });

  it("rejects values below the configured minimum", () => {
    vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", "60");
    expect(isValidSamplingFrequencySeconds(59)).toBe(false);
    expect(isValidSamplingFrequencySeconds(60)).toBe(true);
    expect(isValidSamplingFrequencySeconds(300)).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, 86401, "60", null, undefined])(
    "still rejects the baseline-invalid value %p",
    (value) => {
      vi.stubEnv("MIN_SAMPLING_FREQUENCY_SECONDS", "");
      expect(isValidSamplingFrequencySeconds(value)).toBe(false);
    },
  );
});
