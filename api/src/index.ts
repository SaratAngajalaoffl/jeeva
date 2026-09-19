import { getAuthConfig } from "./auth/config.js";
import { createApp } from "./app.js";
import { connectMongo } from "./db.js";
import { migrateMockWallet } from "./mockWallet/repository.js";
import { connectPostgres } from "./postgres.js";

getAuthConfig(); // fail fast on missing auth env vars

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const db = await connectMongo(requireEnv("MONGO_URL"));
const pgPool = connectPostgres(requireEnv("DATABASE_URL"));
await migrateMockWallet(pgPool);

const port = process.env.PORT ?? 4000;
const app = createApp({ db, pgPool });

app.listen(port, () => {
  console.log(`api listening on port ${port}`);
});
