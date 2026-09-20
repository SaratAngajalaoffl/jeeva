/**
 * One-off backfill: run once, after the trading_sessions table migration
 * (1789848053000_create-trading-sessions.ts) has created one legacy
 * session per symbol. Copies each symbol's trading config out of Mongo's
 * perpConfigs (decisionMaker, frequency, sizing, tradingEnabled, walletId)
 * onto its legacy trading_sessions row, since a Postgres migration can't
 * read Mongo. Safe to re-run: it always overwrites with the current
 * perpConfigs values.
 *
 * Usage: node --loader ts-node/esm scripts/backfill-trading-sessions-config.ts
 */
import { connectMongo } from "../src/db.js";
import { connectPostgres } from "../src/postgres.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const db = await connectMongo(requireEnv("MONGO_URL"));
  const pgPool = connectPostgres(requireEnv("DATABASE_URL"));

  const configs = await db
    .collection("perpConfigs")
    .find({}, { projection: { _id: 0 } })
    .toArray();

  for (const config of configs) {
    const status = config.tradingEnabled ? "active" : "closed";
    await pgPool.query(
      `UPDATE trading_sessions
       SET decision_maker = $2,
           decision_frequency_seconds = $3,
           leverage = $4,
           position_size_usd = $5,
           wallet_id = $6,
           status = $7,
           closed_at = CASE WHEN $7 = 'closed' THEN now() ELSE NULL END
       WHERE symbol = $1`,
      [
        config.symbol,
        config.decisionMaker ?? "random",
        config.decisionFrequencySeconds ?? 300,
        config.leverage ?? 1,
        config.positionSizeUsd ?? 100,
        config.walletId ?? null,
        status,
      ],
    );
  }

  console.log(`Backfilled ${configs.length} legacy trading session(s).`);
  await pgPool.end();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
