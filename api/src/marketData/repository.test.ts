import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { getMarketDataRange } from "./repository.js";

describe("getMarketDataRange", () => {
  it("queries and returns the earliest and latest sample for one symbol", async () => {
    const earliest = new Date("2026-09-20T21:19:00.432Z");
    const latest = new Date("2026-09-21T18:04:12.789Z");
    const query = vi.fn().mockResolvedValue({ rows: [{ earliest, latest }] });
    const pool = { query } as unknown as Pool;

    await expect(getMarketDataRange(pool, "HYPE")).resolves.toEqual({
      earliest,
      latest,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("MIN(time) AS earliest, MAX(time) AS latest"),
      ["HYPE"],
    );
  });

  it("returns null bounds when the symbol has no samples", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ earliest: null, latest: null }],
    });
    const pool = { query } as unknown as Pool;

    await expect(getMarketDataRange(pool, "HYPE")).resolves.toEqual({
      earliest: null,
      latest: null,
    });
  });
});
