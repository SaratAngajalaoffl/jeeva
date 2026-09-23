import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("live_positions", {
    session_id: { type: "uuid", primaryKey: true },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    entry_price: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    opened_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    wallet_id: { type: "uuid", references: "wallets", onDelete: "CASCADE" },
    // Last time this row was confirmed against Hyperliquid's own
    // clearinghouseState, not just written by an open()/close() call.
    // NULL until the reconcile loop (a later slice) starts syncing it.
    last_synced_at: { type: "timestamptz" },
  });

  pgm.createIndex("live_positions", "wallet_id");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("live_positions");
}
