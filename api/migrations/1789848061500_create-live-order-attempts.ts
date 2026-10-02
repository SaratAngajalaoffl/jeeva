import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("live_order_attempts", {
    wallet_id: { type: "uuid", references: "wallets", onDelete: "CASCADE" },
    symbol: { type: "text", notNull: true },
    client_order_id: { type: "text", notNull: true },
    action: { type: "jsonb", notNull: true },
    nonce: { type: "bigint", notNull: true },
    signature_r: { type: "text", notNull: true },
    signature_s: { type: "text", notNull: true },
    signature_v: { type: "integer", notNull: true },
    is_buy: { type: "boolean", notNull: true },
    size: { type: "double precision", notNull: true },
    mid_price: { type: "double precision", notNull: true },
    reduce_only: { type: "boolean", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.createIndex("live_order_attempts", ["wallet_id", "symbol"], {
    unique: true,
    name: "live_order_attempts_wallet_symbol",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("live_order_attempts");
}
