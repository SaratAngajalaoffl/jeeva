import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("perp_health", {
    symbol: { type: "text", primaryKey: true },
    consecutive_failures: { type: "integer", notNull: true, default: 0 },
    last_failure_reason: { type: "text" },
    last_failure_at: { type: "timestamptz" },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("perp_health");
}
