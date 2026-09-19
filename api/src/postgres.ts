import { Pool } from "pg";

export function connectPostgres(connectionString: string): Pool {
  return new Pool({ connectionString });
}
