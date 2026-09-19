export interface TimeRange {
  from: Date;
  to: Date;
}

const DEFAULT_RANGE_MS = 24 * 60 * 60 * 1000;

/**
 * Parses optional `from`/`to` query params into a validated time range,
 * defaulting to the last 24h when omitted. Returns null on an invalid
 * or inverted range so the caller can respond with 400.
 */
export function parseTimeRange(
  query: { from?: unknown; to?: unknown },
  now: Date = new Date(),
): TimeRange | null {
  const to = query.to !== undefined ? new Date(String(query.to)) : now;
  const from =
    query.from !== undefined
      ? new Date(String(query.from))
      : new Date(to.getTime() - DEFAULT_RANGE_MS);

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return null;
  }
  if (from > to) {
    return null;
  }

  return { from, to };
}
