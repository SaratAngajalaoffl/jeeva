export const MIN_FREQUENCY_SECONDS = 1;
export const MAX_FREQUENCY_SECONDS = 24 * 60 * 60; // 24h

export function isValidFrequencySeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_FREQUENCY_SECONDS &&
    value <= MAX_FREQUENCY_SECONDS
  );
}
