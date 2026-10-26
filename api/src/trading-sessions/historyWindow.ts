/**
 * How much historical price data a trading session sends to its decision
 * maker, and in what form. The window is a span of wall-clock time ending
 * at each decision cycle — never "the last N samples", which would keep
 * replaying stale data once sampling stops. Both bounds mirror the
 * engine's own (`MIN/MAX_HISTORY_WINDOW_SECONDS`); however long the
 * window, the engine thins it to at most 1000 samples.
 */

export const MIN_HISTORY_WINDOW_SECONDS = 60;
export const MAX_HISTORY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export const DEFAULT_HISTORY_WINDOW_SECONDS = 24 * 60 * 60;
export const DEFAULT_HISTORY_FORMAT: HistoryFormat = "summary";

export type HistoryFormat = "summary" | "raw";

export const HISTORY_FORMATS: readonly HistoryFormat[] = ["summary", "raw"];

export function isValidHistoryWindowSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HISTORY_WINDOW_SECONDS &&
    value <= MAX_HISTORY_WINDOW_SECONDS
  );
}

export function isValidHistoryFormat(value: unknown): value is HistoryFormat {
  return HISTORY_FORMATS.includes(value as HistoryFormat);
}
