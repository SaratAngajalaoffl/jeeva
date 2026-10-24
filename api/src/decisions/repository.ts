import type { Pool } from "pg";

export interface DecisionLogEntry {
  time: string;
  sessionId: string | null;
  symbol: string;
  contextSummary: string;
  targetDirection: "long" | "short" | "flat" | null;
  confidence: number | null;
  probabilities: {
    long: number;
    short: number;
    flat: number;
  } | null;
  positionAction: "no_op" | "opened" | "closed" | "closed_and_opened" | null;
  success: boolean;
  error: string | null;
  rawRequest: unknown | null;
  rawResponse: unknown | null;
}

export type DecisionSortField = "time" | "confidence";
export type SortOrder = "asc" | "desc";

export interface DecisionHistoryFilter {
  symbol?: string;
  sessionId?: string;
  targetDirection?: "long" | "short" | "flat";
  positionAction?: "no_op" | "opened" | "closed" | "closed_and_opened";
  success?: boolean;
  minConfidence?: number;
  maxConfidence?: number;
  from: Date;
  to: Date;
}

export interface DecisionHistoryQuery extends DecisionHistoryFilter {
  limit: number;
  offset?: number;
  sort?: DecisionSortField;
  order?: SortOrder;
}

function buildWhere(filter: DecisionHistoryFilter): {
  where: string;
  params: unknown[];
} {
  const conditions: string[] = ["time >= $1", "time <= $2"];
  const params: unknown[] = [filter.from, filter.to];

  function add(column: string, op: string, value: unknown) {
    params.push(value);
    conditions.push(`${column} ${op} $${params.length}`);
  }

  if (filter.symbol) add("symbol", "=", filter.symbol);
  if (filter.sessionId) add("session_id", "=", filter.sessionId);
  if (filter.targetDirection)
    add("target_direction", "=", filter.targetDirection);
  if (filter.positionAction) add("position_action", "=", filter.positionAction);
  if (filter.success !== undefined) add("success", "=", filter.success);
  if (filter.minConfidence !== undefined)
    add("confidence", ">=", filter.minConfidence);
  if (filter.maxConfidence !== undefined)
    add("confidence", "<=", filter.maxConfidence);

  return { where: conditions.join(" AND "), params };
}

/** Counts every decision matching `filter`, ignoring paging. */
export async function countDecisions(
  pool: Pool,
  filter: DecisionHistoryFilter,
): Promise<number> {
  const { where, params } = buildWhere(filter);
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM decisions WHERE ${where}`,
    params,
  );
  return Number(result.rows[0].count);
}

export async function getDecisionHistory(
  pool: Pool,
  filter: DecisionHistoryQuery,
): Promise<DecisionLogEntry[]> {
  const { where, params } = buildWhere(filter);

  params.push(filter.limit);
  const limitParam = `$${params.length}`;
  params.push(filter.offset ?? 0);
  const offsetParam = `$${params.length}`;

  // Both values come from closed unions, never raw input, so they are safe
  // to interpolate. Ties (and confidence-less error rows) fall back to time.
  const direction = filter.order === "asc" ? "ASC" : "DESC";
  const orderBy =
    filter.sort === "confidence"
      ? `confidence ${direction} NULLS LAST, time DESC`
      : `time ${direction}`;

  const result = await pool.query<{
    time: Date;
    session_id: string | null;
    symbol: string;
    context_summary: string;
    target_direction: "long" | "short" | "flat" | null;
    confidence: string | null;
    prob_long: string | null;
    prob_short: string | null;
    prob_flat: string | null;
    position_action: "no_op" | "opened" | "closed" | "closed_and_opened" | null;
    success: boolean;
    error: string | null;
    raw_request: unknown | null;
    raw_response: unknown | null;
  }>(
    `SELECT time, session_id, symbol, context_summary, target_direction, confidence,
            prob_long, prob_short, prob_flat, position_action, success, error,
            raw_request, raw_response
     FROM decisions
     WHERE ${where}
     ORDER BY ${orderBy}
     LIMIT ${limitParam} OFFSET ${offsetParam}`,
    params,
  );

  return result.rows.map((row) => ({
    time: row.time.toISOString(),
    sessionId: row.session_id,
    symbol: row.symbol,
    contextSummary: row.context_summary,
    targetDirection: row.target_direction,
    confidence: row.confidence === null ? null : Number(row.confidence),
    probabilities:
      row.prob_long === null ||
      row.prob_short === null ||
      row.prob_flat === null
        ? null
        : {
            long: Number(row.prob_long),
            short: Number(row.prob_short),
            flat: Number(row.prob_flat),
          },
    positionAction: row.position_action,
    success: row.success,
    error: row.error,
    rawRequest: row.raw_request,
    rawResponse: row.raw_response,
  }));
}
