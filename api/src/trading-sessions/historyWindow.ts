/**
 * How much historical price data a trading session sends to its decision
 * maker, and in what form. Both bounds mirror the engine's own read cap
 * (`MAX_HISTORY_WINDOW_SAMPLES`) — a larger window can't be honoured,
 * and the dashboard's history endpoint caps at the same 1000 rows.
 */

export const MIN_HISTORY_WINDOW_SAMPLES = 1;
export const MAX_HISTORY_WINDOW_SAMPLES = 1000;

/** What the engine read (and the dashboard rendered) before this was configurable. */
export const DEFAULT_HISTORY_WINDOW_SAMPLES = MAX_HISTORY_WINDOW_SAMPLES;
export const DEFAULT_HISTORY_FORMAT: HistoryFormat = "summary";

export type HistoryFormat = "summary" | "raw";

export const HISTORY_FORMATS: readonly HistoryFormat[] = ["summary", "raw"];

export function isValidHistoryWindowSamples(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HISTORY_WINDOW_SAMPLES &&
    value <= MAX_HISTORY_WINDOW_SAMPLES
  );
}

export function isValidHistoryFormat(value: unknown): value is HistoryFormat {
  return HISTORY_FORMATS.includes(value as HistoryFormat);
}
