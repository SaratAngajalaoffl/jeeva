/**
 * The span of wall-clock time a session's decision context covers,
 * mirroring the API's bounds (api/src/trading-sessions/historyWindow.ts).
 */

export const MIN_HISTORY_WINDOW_SECONDS = 60;
export const MAX_HISTORY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export type HistoryWindowUnit = "minutes" | "hours" | "days";

export const HISTORY_WINDOW_UNIT_SECONDS: Record<HistoryWindowUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

/** An amount in `unit` as whole seconds, or null if it's not a valid window. */
export function historyWindowSeconds(
  amount: string,
  unit: HistoryWindowUnit,
): number | null {
  const seconds = Number(amount) * HISTORY_WINDOW_UNIT_SECONDS[unit];
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_HISTORY_WINDOW_SECONDS ||
    seconds > MAX_HISTORY_WINDOW_SECONDS
  ) {
    return null;
  }
  return seconds;
}

/** "last 90 minutes" / "last 6 hours" / "last 7 days", in the largest whole unit. */
export function formatHistoryWindow(seconds: number): string {
  const units: HistoryWindowUnit[] = ["days", "hours", "minutes"];
  for (const unit of units) {
    const size = HISTORY_WINDOW_UNIT_SECONDS[unit];
    if (seconds >= size && seconds % size === 0) {
      const amount = seconds / size;
      return `last ${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;
    }
  }
  return `last ${seconds} seconds`;
}
