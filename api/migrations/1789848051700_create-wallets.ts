import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("wallets", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    label: { type: "text", notNull: true, unique: true },
    kind: { type: "text", notNull: true },
    public_address: { type: "text" },
    encrypted_private_key: { type: "text" },
    initial_balance_usd: { type: "double precision" },
    current_balance_usd: { type: "double precision" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint(
    "wallets",
    "wallets_kind_check",
    "CHECK (kind IN ('mock', 'live'))",
  );

  pgm.addColumn("mock_positions", {
    wallet_id: { type: "uuid", references: "wallets", onDelete: "CASCADE" },
  });
  pgm.addColumn("funding_payments", {
    wallet_id: { type: "uuid", references: "wallets", onDelete: "CASCADE" },
  });

  pgm.sql(`
    INSERT INTO wallets (label, kind, initial_balance_usd, current_balance_usd, created_at)
    SELECT 'Default mock wallet', 'mock', initial_balance_usd, current_balance_usd, created_at
    FROM mock_wallet
    WHERE id = 1
  `);
  pgm.sql(`
    INSERT INTO wallets (label, kind, public_address)
    SELECT 'Default live wallet', 'live', public_address
    FROM engine_wallet
    WHERE id = 1
  `);

  pgm.dropTable("mock_wallet");
  pgm.dropTable("engine_wallet");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
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

  pgm.createTable("engine_wallet", {
    id: { type: "integer", primaryKey: true, default: 1 },
    public_address: { type: "text", notNull: true },
  });
  pgm.addConstraint(
    "engine_wallet",
    "engine_wallet_singleton",
    "CHECK (id = 1)",
  );

  pgm.sql(`
    INSERT INTO mock_wallet (id, initial_balance_usd, current_balance_usd, created_at)
    SELECT 1, initial_balance_usd, current_balance_usd, created_at
    FROM wallets
    WHERE kind = 'mock'
    ORDER BY created_at
    LIMIT 1
  `);
  pgm.sql(`
    INSERT INTO engine_wallet (id, public_address)
    SELECT 1, public_address
    FROM wallets
    WHERE kind = 'live' AND public_address IS NOT NULL
    ORDER BY created_at
    LIMIT 1
  `);

  pgm.dropColumn("funding_payments", "wallet_id");
  pgm.dropColumn("mock_positions", "wallet_id");
  pgm.dropTable("wallets");
}
