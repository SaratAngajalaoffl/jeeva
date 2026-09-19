import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createExtension("timescaledb", { ifNotExists: true });

  pgm.createTable("market_data", {
    time: { type: "timestamptz", notNull: true },
    symbol: { type: "text", notNull: true },
    price: { type: "double precision", notNull: true },
    open_interest: { type: "double precision", notNull: true },
    volume: { type: "double precision", notNull: true },
    spread: { type: "double precision", notNull: true },
    mid_price: { type: "double precision", notNull: true },
  });

  pgm.sql(
    "SELECT create_hypertable('market_data', 'time', if_not_exists => TRUE)",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("market_data");
}
