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

export interface DecisionHistoryFilter {
  symbol?: string;
  sessionId?: string;
  from: Date;
  to: Date;
  limit: number;
}

export async function getDecisionHistory(
  pool: Pool,
  filter: DecisionHistoryFilter,
): Promise<DecisionLogEntry[]> {
  const conditions: string[] = ["time >= $1", "time <= $2"];
  const params: unknown[] = [filter.from, filter.to];

  if (filter.symbol) {
    params.push(filter.symbol);
    conditions.push(`symbol = $${params.length}`);
  }

  if (filter.sessionId) {
    params.push(filter.sessionId);
    conditions.push(`session_id = $${params.length}`);
  }

  params.push(filter.limit);
  const limitParam = `$${params.length}`;

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
     WHERE ${conditions.join(" AND ")}
     ORDER BY time DESC
     LIMIT ${limitParam}`,
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
