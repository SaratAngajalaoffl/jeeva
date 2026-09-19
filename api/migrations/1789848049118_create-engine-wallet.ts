import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("engine_wallet", {
    id: { type: "integer", primaryKey: true, default: 1 },
    public_address: { type: "text", notNull: true },
  });
  pgm.addConstraint(
    "engine_wallet",
    "engine_wallet_singleton",
    "CHECK (id = 1)",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("engine_wallet");
}
