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
    historyWindowSeconds: 86400,
    historyFormat: "summary",
    storeDecisionPayloads: false,
    stopLossPct: null,
    walletId: null,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("mergeTradingSessionConfig", () => {
  it("returns the existing config unchanged for an empty patch", () => {
    const existing = session({
      historyWindowSeconds: 3600,
      historyFormat: "raw",
    });
    expect(mergeTradingSessionConfig(existing, {})).toEqual({
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 1,
      positionSizeUsd: 100,
      historyWindowSeconds: 3600,
      historyFormat: "raw",
      storeDecisionPayloads: false,
      stopLossPct: null,
    });
  });

  it("applies only the fields the patch sets", () => {
    const existing = session({
      historyWindowSeconds: 3600,
      historyFormat: "raw",
    });
    expect(mergeTradingSessionConfig(existing, { leverage: 5 })).toEqual({
      decisionMaker: "random",
      decisionFrequencySeconds: 300,
      leverage: 5,
      positionSizeUsd: 100,
      historyWindowSeconds: 3600,
      historyFormat: "raw",
      storeDecisionPayloads: false,
      stopLossPct: null,
    });
  });

  it("applies the history window and format independently", () => {
    const existing = session();

    expect(
      mergeTradingSessionConfig(existing, { historyFormat: "raw" }),
    ).toMatchObject({ historyWindowSeconds: 86400, historyFormat: "raw" });

    expect(
      mergeTradingSessionConfig(existing, { historyWindowSeconds: 600 }),
    ).toMatchObject({ historyWindowSeconds: 600, historyFormat: "summary" });
  });

  it("applies every field when the patch sets them all", () => {
    const merged = mergeTradingSessionConfig(session(), {
      decisionMaker: "openrouter",
      decisionFrequencySeconds: 30,
      leverage: 10,
      positionSizeUsd: 250,
      historyWindowSeconds: 7200,
      historyFormat: "raw",
      storeDecisionPayloads: true,
      stopLossPct: 0.1,
    });

    expect(merged).toEqual({
      decisionMaker: "openrouter",
      decisionFrequencySeconds: 30,
      leverage: 10,
      positionSizeUsd: 250,
      historyWindowSeconds: 7200,
      historyFormat: "raw",
      storeDecisionPayloads: true,
      stopLossPct: 0.1,
    });
  });

  it("clears the stop-loss when the patch explicitly sets it to null", () => {
    const existing = session({ stopLossPct: 0.2 });
    expect(
      mergeTradingSessionConfig(existing, { stopLossPct: null }),
    ).toMatchObject({ stopLossPct: null });
  });

  it("leaves the stop-loss untouched when the patch omits it", () => {
    const existing = session({ stopLossPct: 0.2 });
    expect(mergeTradingSessionConfig(existing, { leverage: 3 })).toMatchObject({
      stopLossPct: 0.2,
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
