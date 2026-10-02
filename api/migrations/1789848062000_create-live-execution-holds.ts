import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("live_execution_holds", {
    wallet_id: { type: "uuid", references: "wallets", onDelete: "CASCADE" },
    symbol: { type: "text", notNull: true },
    reason: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex("live_execution_holds", ["wallet_id", "symbol"], {
    unique: true,
    name: "live_execution_holds_wallet_symbol",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("live_execution_holds");
}
