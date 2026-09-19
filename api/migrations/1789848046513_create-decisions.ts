import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("decisions", {
    time: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    symbol: { type: "text", notNull: true },
    context_summary: { type: "text", notNull: true },
    target_direction: { type: "text" },
    confidence: { type: "double precision" },
    prob_long: { type: "double precision" },
    prob_short: { type: "double precision" },
    prob_flat: { type: "double precision" },
    position_action: { type: "text" },
    success: { type: "boolean", notNull: true },
    error: { type: "text" },
    auto_flatten: { type: "boolean", notNull: true, default: false },
  });

  pgm.sql(
    "SELECT create_hypertable('decisions', 'time', if_not_exists => TRUE)",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("decisions");
}
