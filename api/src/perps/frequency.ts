export const MIN_FREQUENCY_SECONDS = 1;
export const MAX_FREQUENCY_SECONDS = 24 * 60 * 60; // 24h

export const DEFAULT_MIN_SAMPLING_FREQUENCY_SECONDS = MIN_FREQUENCY_SECONDS;

/**
 * Minimum sampling frequency (in seconds) this deployment will accept,
 * from MIN_SAMPLING_FREQUENCY_SECONDS. Any market-data sampling request
 * configured below it is rejected. Defaults to MIN_FREQUENCY_SECONDS.
 * Throws on a malformed value so a bad deployment config fails fast at
 * startup instead of silently sampling at an unintended cadence.
 */
export function getMinSamplingFrequencySeconds(): number {
  const raw = process.env.MIN_SAMPLING_FREQUENCY_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MIN_SAMPLING_FREQUENCY_SECONDS;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_FREQUENCY_SECONDS) {
    throw new Error(
      `Invalid MIN_SAMPLING_FREQUENCY_SECONDS: ${raw} (expected a number of seconds between 0 and ${MAX_FREQUENCY_SECONDS})`,
    );
  }
  return value;
}

export function isValidFrequencySeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_FREQUENCY_SECONDS &&
    value <= MAX_FREQUENCY_SECONDS
  );
}

/**
 * Like `isValidFrequencySeconds`, but additionally rejects frequencies
 * below the deployment's configured sampling minimum.
 */
export function isValidSamplingFrequencySeconds(
  value: unknown,
): value is number {
  return (
    isValidFrequencySeconds(value) && value >= getMinSamplingFrequencySeconds()
  );
}
