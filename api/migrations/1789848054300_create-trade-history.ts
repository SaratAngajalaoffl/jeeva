import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("trade_history", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    session_id: { type: "uuid", notNull: true },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    entry_price: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    opened_at: { type: "timestamptz", notNull: true },
    exit_price: { type: "double precision", notNull: true },
    pnl_usd: { type: "double precision", notNull: true },
    closed_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("trade_history", ["symbol", "closed_at"]);
  pgm.createIndex("trade_history", "session_id");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("trade_history");
}
