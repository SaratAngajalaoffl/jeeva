import type { MigrationBuilder } from "node-pg-migrate";

// 30 days, mirroring MAX_HISTORY_WINDOW_SECONDS in
// src/trading-sessions/historyWindow.ts and the engine.
const MAX_SECONDS = 30 * 24 * 60 * 60;

const TABLES = [
  { table: "trading_sessions", default: 24 * 60 * 60 },
  { table: "backtest_runs", default: null },
] as const;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // The history window becomes a span of wall-clock time instead of a
  // count of most-recent samples: "the last N samples" kept handing the
  // decision maker the same stale rows once sampling stopped, however
  // old they were. Existing rows are converted at the default 60s
  // sampling frequency, so a 1000-sample window becomes 1000 minutes.
  for (const { table, default: defaultSeconds } of TABLES) {
    pgm.addColumn(table, {
      history_window_seconds: {
        type: "integer",
        notNull: false,
      },
    });
    pgm.sql(
      `UPDATE ${table}
       SET history_window_seconds = LEAST(GREATEST(history_window_samples * 60, 60), ${MAX_SECONDS})`,
    );
    pgm.alterColumn(table, "history_window_seconds", {
      notNull: true,
      ...(defaultSeconds === null ? {} : { default: defaultSeconds }),
    });
    pgm.addConstraint(
      table,
      `${table}_history_window_seconds_check`,
      `CHECK (history_window_seconds >= 60 AND history_window_seconds <= ${MAX_SECONDS})`,
    );
    pgm.dropConstraint(table, `${table}_history_window_samples_check`);
    pgm.dropColumn(table, "history_window_samples");
  }
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  for (const { table } of TABLES) {
    pgm.addColumn(table, {
      history_window_samples: { type: "integer", notNull: false },
    });
    pgm.sql(
      `UPDATE ${table}
       SET history_window_samples = LEAST(GREATEST(history_window_seconds / 60, 1), 1000)`,
    );
    pgm.alterColumn(table, "history_window_samples", {
      notNull: true,
      ...(table === "trading_sessions" ? { default: 1000 } : {}),
    });
    pgm.addConstraint(
      table,
      `${table}_history_window_samples_check`,
      "CHECK (history_window_samples >= 1 AND history_window_samples <= 1000)",
    );
    pgm.dropConstraint(table, `${table}_history_window_seconds_check`);
    pgm.dropColumn(table, "history_window_seconds");
  }
}
