import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("mock_wallet", {
    id: { type: "integer", primaryKey: true, default: 1 },
    initial_balance_usd: { type: "double precision", notNull: true },
    current_balance_usd: { type: "double precision", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("mock_wallet", "mock_wallet_singleton", "CHECK (id = 1)");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("mock_wallet");
}
