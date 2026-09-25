import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The integration suites share one migrated PostgreSQL database. Running
    // them in separate forks would let concurrent setup teardowns erase rows.
    fileParallelism: false,
  },
});
