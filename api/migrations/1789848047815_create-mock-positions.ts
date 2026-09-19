import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("mock_positions", {
    symbol: { type: "text", primaryKey: true },
    direction: { type: "text", notNull: true },
    entry_price: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    opened_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("mock_positions");
}
