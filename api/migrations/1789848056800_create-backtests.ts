import type { MigrationBuilder } from "node-pg-migrate";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("backtest_runs", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    symbol: { type: "text", notNull: true },
    decision_maker: { type: "text", notNull: true },
    decision_frequency_seconds: { type: "double precision", notNull: true },
    leverage: { type: "double precision", notNull: true },
    position_size_usd: { type: "double precision", notNull: true },
    history_window_samples: { type: "integer", notNull: true },
    history_format: { type: "text", notNull: true },
    start_time: { type: "timestamptz", notNull: true },
    end_time: { type: "timestamptz", notNull: true },
    initial_balance_usd: { type: "double precision", notNull: true },
    current_balance_usd: { type: "double precision", notNull: true },
    status: { type: "text", notNull: true, default: "pending" },
    error: { type: "text" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    completed_at: { type: "timestamptz" },
  });

  pgm.addConstraint(
    "backtest_runs",
    "backtest_runs_status_check",
    "CHECK (status IN ('pending', 'running', 'completed', 'failed'))",
  );
  pgm.addConstraint(
    "backtest_runs",
    "backtest_runs_history_format_check",
    "CHECK (history_format IN ('summary', 'raw'))",
  );
  pgm.addConstraint(
    "backtest_runs",
    "backtest_runs_history_window_samples_check",
    "CHECK (history_window_samples >= 1 AND history_window_samples <= 1000)",
  );
  pgm.addConstraint(
    "backtest_runs",
    "backtest_runs_time_range_check",
    "CHECK (end_time > start_time)",
  );

  pgm.createIndex("backtest_runs", ["symbol", "created_at"]);
  pgm.createIndex("backtest_runs", "status");

  pgm.createTable("backtest_positions", {
    backtest_run_id: {
      type: "uuid",
      primaryKey: true,
      references: "backtest_runs",
      onDelete: "CASCADE",
    },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    entry_price: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    opened_at: { type: "timestamptz", notNull: true },
  });

  pgm.createTable("backtest_decisions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    backtest_run_id: {
      type: "uuid",
      notNull: true,
      references: "backtest_runs",
      onDelete: "CASCADE",
    },
    sim_time: { type: "timestamptz", notNull: true },
    symbol: { type: "text", notNull: true },
    context_summary: { type: "text", notNull: true },
    target_direction: { type: "text" },
    confidence: { type: "double precision" },
    prob_long: { type: "double precision" },
    prob_short: { type: "double precision" },
    prob_flat: { type: "double precision" },
    position_action: { type: "text" },
    success: { type: "boolean", notNull: true },
    error: { type: "text" },
    auto_flatten: { type: "boolean", notNull: true, default: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("backtest_decisions", ["backtest_run_id", "sim_time"]);

  pgm.createTable("backtest_trades", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    backtest_run_id: {
      type: "uuid",
      notNull: true,
      references: "backtest_runs",
      onDelete: "CASCADE",
    },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    entry_price: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    opened_at: { type: "timestamptz", notNull: true },
    exit_price: { type: "double precision", notNull: true },
    pnl_usd: { type: "double precision", notNull: true },
    closed_at: { type: "timestamptz", notNull: true },
  });

  pgm.createIndex("backtest_trades", ["backtest_run_id", "closed_at"]);

  pgm.createTable("backtest_funding_payments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    backtest_run_id: {
      type: "uuid",
      notNull: true,
      references: "backtest_runs",
      onDelete: "CASCADE",
    },
    sim_time: { type: "timestamptz", notNull: true },
    symbol: { type: "text", notNull: true },
    direction: { type: "text", notNull: true },
    funding_rate: { type: "double precision", notNull: true },
    notional_usd: { type: "double precision", notNull: true },
    amount_usd: { type: "double precision", notNull: true },
  });

  pgm.createIndex("backtest_funding_payments", ["backtest_run_id", "sim_time"]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("backtest_funding_payments");
  pgm.dropTable("backtest_trades");
  pgm.dropTable("backtest_decisions");
  pgm.dropTable("backtest_positions");
  pgm.dropTable("backtest_runs");
}
