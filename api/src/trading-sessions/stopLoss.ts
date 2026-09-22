export const MIN_STOP_LOSS_PCT = 0;
export const MAX_STOP_LOSS_PCT = 1;

/**
 * `value` is expressed as a fraction of notional (e.g. 0.1 = 10%), not
 * whole percentage points, matching `MIN_CONFIDENCE_TO_SHIFT`'s 0-1
 * convention elsewhere in the system. `null` (no stop-loss configured)
 * is valid; `0` is not, since a 0% stop-loss would close the position
 * immediately.
 */
export function isValidStopLossPct(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > MIN_STOP_LOSS_PCT &&
    value <= MAX_STOP_LOSS_PCT
  );
}
