import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("funding_payments", {
    time: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    funding_rate: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    amount_usd: { type: "double precision", notNull: true },
  });

  pgm.sql(
    "SELECT create_hypertable('funding_payments', 'time', if_not_exists => TRUE)",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("funding_payments");
}
