import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("trading_sessions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    symbol: { type: "text", notNull: true },
    decision_maker: { type: "text", notNull: true, default: "random" },
    decision_frequency_seconds: {
      type: "double precision",
      notNull: true,
      default: 300,
    },
    leverage: { type: "double precision", notNull: true, default: 1 },
    position_size_usd: {
      type: "double precision",
      notNull: true,
      default: 100,
    },
    wallet_id: { type: "uuid", references: "wallets" },
    status: { type: "text", notNull: true, default: "active" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    closed_at: { type: "timestamptz" },
  });

  pgm.addConstraint(
    "trading_sessions",
    "trading_sessions_status_check",
    "CHECK (status IN ('active', 'soft_closing', 'hard_closing', 'closed'))",
  );

  // A wallet may be attached to at most one non-closed session at a time,
  // across all markets.
  pgm.createIndex("trading_sessions", "wallet_id", {
    name: "trading_sessions_wallet_id_active_unique",
    unique: true,
    where: "status <> 'closed'",
  });

  pgm.createIndex("trading_sessions", ["symbol", "status"]);

  pgm.addColumn("decisions", {
    session_id: { type: "uuid" },
  });
  pgm.addColumn("funding_payments", {
    session_id: { type: "uuid" },
  });
  pgm.addColumn("mock_positions", {
    session_id: { type: "uuid" },
  });

  // Backfill: one legacy session per symbol that already has trading
  // history, carrying forward its wallet if it has exactly one associated
  // with existing positions/funding. Session-level trading config
  // (decision maker, frequencies, sizing, tradingEnabled) lives in Mongo's
  // perpConfigs and is backfilled separately by
  // api/scripts/backfill-trading-sessions-config.ts, since it can't be
  // read from a Postgres migration.
  pgm.sql(`
    INSERT INTO trading_sessions (symbol, wallet_id, status)
    SELECT DISTINCT ON (symbol) symbol, wallet_id, 'active'
    FROM (
      SELECT symbol, wallet_id FROM mock_positions
      UNION
      SELECT symbol, wallet_id FROM funding_payments WHERE wallet_id IS NOT NULL
      UNION
      SELECT symbol, NULL::uuid AS wallet_id FROM decisions
    ) legacy
    ORDER BY symbol, wallet_id NULLS LAST
  `);

  pgm.sql(`
    UPDATE mock_positions mp
    SET session_id = ts.id
    FROM trading_sessions ts
    WHERE ts.symbol = mp.symbol
  `);
  pgm.sql(`
    UPDATE decisions d
    SET session_id = ts.id
    FROM trading_sessions ts
    WHERE ts.symbol = d.symbol
  `);
  pgm.sql(`
    UPDATE funding_payments fp
    SET session_id = ts.id
    FROM trading_sessions ts
    WHERE ts.symbol = fp.symbol
  `);

  // mock_positions now identifies an open position by session, not bare
  // symbol, so multiple sessions on the same symbol can hold independent
  // positions.
  pgm.alterColumn("mock_positions", "session_id", { notNull: true });
  pgm.dropConstraint("mock_positions", "mock_positions_pkey");
  pgm.addConstraint("mock_positions", "mock_positions_pkey", {
    primaryKey: "session_id",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("mock_positions", "mock_positions_pkey");
  pgm.addConstraint("mock_positions", "mock_positions_pkey", {
    primaryKey: "symbol",
  });
  pgm.dropColumn("mock_positions", "session_id");
  pgm.dropColumn("funding_payments", "session_id");
  pgm.dropColumn("decisions", "session_id");
  pgm.dropTable("trading_sessions");
}
