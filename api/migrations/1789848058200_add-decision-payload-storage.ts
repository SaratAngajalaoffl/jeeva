import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Opt-in per session/backtest: when enabled, the engine also persists
  // the exact request/response JSON exchanged with Jev for every
  // decision cycle (including failed ones), not just the parsed
  // direction/confidence/probabilities. Off by default since raw
  // payloads can be large and most sessions don't need them.
  pgm.addColumns("trading_sessions", {
    store_decision_payloads: {
      type: "boolean",
      notNull: true,
      default: false,
    },
  });

  pgm.addColumns("backtest_runs", {
    store_decision_payloads: {
      type: "boolean",
      notNull: true,
      default: false,
    },
  });

  pgm.addColumns("decisions", {
    raw_request: { type: "jsonb" },
    raw_response: { type: "jsonb" },
  });

  pgm.addColumns("backtest_decisions", {
    raw_request: { type: "jsonb" },
    raw_response: { type: "jsonb" },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("backtest_decisions", ["raw_request", "raw_response"]);
  pgm.dropColumns("decisions", ["raw_request", "raw_response"]);
  pgm.dropColumns("backtest_runs", ["store_decision_payloads"]);
  pgm.dropColumns("trading_sessions", ["store_decision_payloads"]);
}
