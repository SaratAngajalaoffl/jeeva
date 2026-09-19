import { describe, expect, it } from "vitest";
import { applyToggleRules } from "./toggleRules.js";

describe("applyToggleRules", () => {
  it("enabling trading also enables sampling", () => {
    const result = applyToggleRules(
      { tradingEnabled: false, samplingEnabled: false },
      { tradingEnabled: true },
    );
    expect(result).toEqual({ tradingEnabled: true, samplingEnabled: true });
  });

  it("disabling sampling also disables trading", () => {
    const result = applyToggleRules(
      { tradingEnabled: true, samplingEnabled: true },
      { samplingEnabled: false },
    );
    expect(result).toEqual({ tradingEnabled: false, samplingEnabled: false });
  });

  it("disabling trading leaves sampling untouched", () => {
    const result = applyToggleRules(
      { tradingEnabled: true, samplingEnabled: true },
      { tradingEnabled: false },
    );
    expect(result).toEqual({ tradingEnabled: false, samplingEnabled: true });
  });

  it("enabling sampling alone does not enable trading", () => {
    const result = applyToggleRules(
      { tradingEnabled: false, samplingEnabled: false },
      { samplingEnabled: true },
    );
    expect(result).toEqual({ tradingEnabled: false, samplingEnabled: true });
  });

  it("never produces the invalid combination trading=true, sampling=false", () => {
    const result = applyToggleRules(
      { tradingEnabled: false, samplingEnabled: false },
      { tradingEnabled: true, samplingEnabled: false },
    );
    expect(
      result.tradingEnabled === true && result.samplingEnabled === false,
    ).toBe(false);
  });

  it("is a no-op when the patch is empty", () => {
    const current = { tradingEnabled: true, samplingEnabled: true };
    expect(applyToggleRules(current, {})).toEqual(current);
  });
});
