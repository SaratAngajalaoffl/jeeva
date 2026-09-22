import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("trading_sessions", {
    // Fraction of notional (0-1] at which an open position is force-
    // closed, e.g. 0.1 = closes once unrealized loss reaches 10% of
    // notional. NULL means no stop-loss is configured for the session.
    stop_loss_pct: { type: "double precision" },
  });

  pgm.addConstraint(
    "trading_sessions",
    "trading_sessions_stop_loss_pct_check",
    "CHECK (stop_loss_pct IS NULL OR (stop_loss_pct > 0 AND stop_loss_pct <= 1))",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("trading_sessions", "trading_sessions_stop_loss_pct_check");
  pgm.dropColumn("trading_sessions", "stop_loss_pct");
}
