import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // How much historical market data is sent to the decision maker when
  // building its decision context, and in what form: a min/max/average
  // summary of the window (the original behavior) or every raw sample in
  // it. Defaults preserve the previous implicit behavior exactly — the
  // engine read up to 1000 samples, oldest first, and rendered the
  // averaged summary.
  pgm.addColumns("trading_sessions", {
    history_window_samples: {
      type: "integer",
      notNull: true,
      default: 1000,
    },
    history_format: {
      type: "text",
      notNull: true,
      default: "summary",
    },
  });

  // Upper bound mirrors the engine's own read cap and the dashboard's
  // history endpoint limit (1000 rows).
  pgm.addConstraint(
    "trading_sessions",
    "trading_sessions_history_window_samples_check",
    "CHECK (history_window_samples >= 1 AND history_window_samples <= 1000)",
  );

  pgm.addConstraint(
    "trading_sessions",
    "trading_sessions_history_format_check",
    "CHECK (history_format IN ('summary', 'raw'))",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns("trading_sessions", [
    "history_window_samples",
    "history_format",
  ]);
}
