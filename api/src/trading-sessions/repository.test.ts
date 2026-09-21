import { describe, expect, it } from "vitest";
import {
  mergeTradingSessionConfig,
  type TradingSession,
} from "./repository.js";

function session(overrides: Partial<TradingSession> = {}): TradingSession {
  return {
    id: "session-1",
    symbol: "BTC",
    decisionMaker: "random",
    decisionFrequencySeconds: 300,
    leverage: 1,
    positionSizeUsd: 100,
    historyWindowSamples: 1000,
    historyFormat: "summary",
    storeDecisionPayloads: false,
    walletId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("mergeTradingSessionConfig", () => {
  it("returns the existing config unchanged for an empty patch", () => {
    const existing = session({ historyWindowSamples: 40, historyFormat: "raw" });
    expect(mergeTradingSessionConfig(existing, {})).toEqual({
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 1,
      positionSizeUsd: 100,
      historyWindowSamples: 40,
      historyFormat: "raw",
      storeDecisionPayloads: false,
    });
  });

  it("applies only the fields the patch sets", () => {
    const existing = session({ historyWindowSamples: 40, historyFormat: "raw" });
    expect(mergeTradingSessionConfig(existing, { leverage: 5 })).toEqual({
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 5,
      positionSizeUsd: 100,
      historyWindowSamples: 40,
      historyFormat: "raw",
      storeDecisionPayloads: false,
    });
  });

  it("applies the history window and format independently", () => {
    const existing = session();

    expect(
      mergeTradingSessionConfig(existing, { historyFormat: "raw" }),
    ).toMatchObject({ historyWindowSamples: 1000, historyFormat: "raw" });

    expect(
      mergeTradingSessionConfig(existing, { historyWindowSamples: 10 }),
    ).toMatchObject({ historyWindowSamples: 10, historyFormat: "summary" });
  });

  it("applies every field when the patch sets them all", () => {
    const merged = mergeTradingSessionConfig(session(), {
      decisionMaker: "openrouter",
      decisionFrequencySeconds: 30,
      leverage: 10,
      positionSizeUsd: 250,
      historyWindowSamples: 60,
      historyFormat: "raw",
      storeDecisionPayloads: true,
    });

    expect(merged).toEqual({
      decisionMaker: "openrouter",
      decisionFrequencySeconds: 30,
      leverage: 10,
      positionSizeUsd: 250,
      historyWindowSamples: 60,
      historyFormat: "raw",
      storeDecisionPayloads: true,
    });
  });

  it("never returns undefined for a field the patch omits", () => {
    const merged = mergeTradingSessionConfig(session(), {
      leverage: 2,
      historyFormat: "raw",
    });
    expect(Object.values(merged)).not.toContain(undefined);
  });
});
