"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Brain,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  fetchDecisionPage,
  type DecisionLogEntry,
  type DecisionPageQuery,
  type TradingSession,
} from "@/lib/api";
import {
  chartRangeFrom,
  type ChartRange,
  type ChartSelection,
} from "@/components/PriceVolumeChart";
import { Button, EmptyState, Select, TableSkeleton } from "@/components/ui";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

const POLL_MS = 10_000;
const PAGE_SIZES = [20, 50, 100];
const CONFIDENCE_FLOORS = [0.5, 0.6, 0.7, 0.8, 0.9];

type SortField = NonNullable<DecisionPageQuery["sort"]>;
type SortOrder = NonNullable<DecisionPageQuery["order"]>;

interface Filters {
  sessionId: string;
  direction: "" | NonNullable<DecisionPageQuery["direction"]>;
  action: "" | NonNullable<DecisionPageQuery["action"]>;
  status: "" | NonNullable<DecisionPageQuery["status"]>;
  minConfidence: string;
}

const NO_FILTERS: Filters = {
  sessionId: "",
  direction: "",
  action: "",
  status: "",
  minConfidence: "",
};

function SortHeader({
  field,
  label,
  sort,
  order,
  onSort,
}: {
  field: SortField;
  label: string;
  sort: SortField;
  order: SortOrder;
  onSort: (field: SortField) => void;
}) {
  const active = sort === field;
  const Icon = !active ? ArrowUpDown : order === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={TH}
      aria-sort={
        active ? (order === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-text ${
          active ? "text-text" : ""
        }`}
      >
        {label}
        <Icon className="h-3 w-3" aria-hidden />
      </button>
    </th>
  );
}

/**
 * A market's or a session's decision log: server-side paged, filtered and
 * sorted, scoped to whatever time window the page's chart is showing.
 */
export default function DecisionHistoryPanel({
  symbol,
  sessionId,
  sessions = null,
  range,
  selection,
}: {
  symbol: string;
  /** Pins the log to one session, dropping the session column and filter. */
  sessionId?: string;
  /** Options for the session filter when the log spans a whole market. */
  sessions?: TradingSession[] | null;
  range: ChartRange;
  /** A dragged chart window; overrides `range` when set. */
  selection: ChartSelection | null;
}) {
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<SortField>("time");
  const [order, setOrder] = useState<SortOrder>("desc");
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [page, setPage] = useState(0);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState(false);
  const requestId = useRef(0);

  // Any change to what is being matched invalidates the current page.
  useEffect(() => {
    setPage(0);
  }, [filters, sort, order, pageSize, range, selection, symbol, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setDecisions(null);

    function load() {
      const id = ++requestId.current;
      fetchDecisionPage({
        symbol,
        sessionId: sessionId ?? (filters.sessionId || undefined),
        direction: filters.direction || undefined,
        action: filters.action || undefined,
        status: filters.status || undefined,
        minConfidence: filters.minConfidence
          ? Number(filters.minConfidence)
          : undefined,
        sort,
        order,
        // Resolved per request so a rolling range keeps sliding forward.
        from: selection ? new Date(selection.from) : chartRangeFrom(range),
        to: selection ? new Date(selection.to) : new Date(),
        limit: pageSize,
        offset: page * pageSize,
      })
        .then((result) => {
          if (cancelled || id !== requestId.current) return;
          setDecisions(result.decisions);
          setTotal(result.total);
          setError(false);
        })
        .catch(() => {
          if (cancelled || id !== requestId.current) return;
          setDecisions((prev) => prev ?? []);
          setError(true);
        });
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    symbol,
    sessionId,
    filters,
    sort,
    order,
    pageSize,
    page,
    range,
    selection,
  ]);

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function handleSort(field: SortField) {
    if (field === sort) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(field);
      setOrder("desc");
    }
  }

  const filtered = Object.values(filters).some((v) => v !== "");
  const showSession = sessionId === undefined;
  // Only sessions with payload storage enabled have anything to show here.
  const showPayloads = (decisions ?? []).some(
    (d) => d.rawRequest || d.rawResponse,
  );
  const columns = 5 + (showSession ? 1 : 0) + (showPayloads ? 1 : 0);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : page * pageSize + 1;
  const lastRow = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-surface-1 px-5 py-3">
        {showSession && (
          <Select
            aria-label="Session"
            value={filters.sessionId}
            onChange={(e) => setFilter("sessionId", e.target.value)}
            className="py-1.5 text-xs"
          >
            <option value="">All sessions</option>
            {sessions?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.slice(0, 8)} ({s.status})
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label="Direction"
          value={filters.direction}
          onChange={(e) =>
            setFilter("direction", e.target.value as Filters["direction"])
          }
          className="py-1.5 text-xs"
        >
          <option value="">Any direction</option>
          <option value="long">long</option>
          <option value="short">short</option>
          <option value="flat">flat</option>
        </Select>
        <Select
          aria-label="Action"
          value={filters.action}
          onChange={(e) =>
            setFilter("action", e.target.value as Filters["action"])
          }
          className="py-1.5 text-xs"
        >
          <option value="">Any action</option>
          <option value="no_op">no_op</option>
          <option value="opened">opened</option>
          <option value="closed">closed</option>
          <option value="closed_and_opened">closed_and_opened</option>
        </Select>
        <Select
          aria-label="Status"
          value={filters.status}
          onChange={(e) =>
            setFilter("status", e.target.value as Filters["status"])
          }
          className="py-1.5 text-xs"
        >
          <option value="">Any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
        </Select>
        <Select
          aria-label="Minimum confidence"
          value={filters.minConfidence}
          onChange={(e) => setFilter("minConfidence", e.target.value)}
          className="py-1.5 text-xs"
        >
          <option value="">Any confidence</option>
          {CONFIDENCE_FLOORS.map((floor) => (
            <option key={floor} value={floor}>
              ≥ {floor.toFixed(2)}
            </option>
          ))}
        </Select>
        {filtered && (
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="px-2 text-xs text-subtext-1 transition-colors hover:text-ember"
          >
            Clear filters
          </button>
        )}
        {selection && (
          <span className="ml-auto text-xs text-subtext-0">
            Limited to the period selected on the chart
          </span>
        )}
      </div>

      {error && (
        <p className="px-5 pt-3 text-xs text-destructive">
          Failed to load decision history.
        </p>
      )}

      <div className="overflow-x-auto">
        {!decisions ? (
          <TableSkeleton
            columns={columns}
            label="Loading decisions"
            className="p-5"
          />
        ) : decisions.length === 0 ? (
          <EmptyState
            icon={Brain}
            title={
              filtered
                ? "No decisions match these filters."
                : "No decisions yet."
            }
            description={
              filtered
                ? "Try loosening a filter or widening the chart's time period."
                : showSession
                  ? "Decisions in the chart's time period appear here as sessions make them."
                  : "Decisions in the chart's time period appear here as this session makes them."
            }
          />
        ) : (
          <table className="w-full min-w-[560px] border-collapse text-left text-sm text-text">
            <thead>
              <tr>
                <SortHeader
                  field="time"
                  label="Time"
                  sort={sort}
                  order={order}
                  onSort={handleSort}
                />
                {showSession && <th className={TH}>Session</th>}
                <th className={TH}>Direction</th>
                <SortHeader
                  field="confidence"
                  label="Confidence"
                  sort={sort}
                  order={order}
                  onSort={handleSort}
                />
                <th className={TH}>Action</th>
                <th className={TH}>Status</th>
                {showPayloads && <th className={TH}>Payload</th>}
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={`${d.time}-${i}`} className="hover:bg-surface-0/60">
                  <td className={TD}>{new Date(d.time).toLocaleString()}</td>
                  {showSession && (
                    <td className={TD}>
                      {d.sessionId ? (
                        <Link
                          href={`/dashboard/markets/${symbol}/sessions/${d.sessionId}`}
                          className="text-ember hover:underline"
                        >
                          {d.sessionId.slice(0, 8)}
                        </Link>
                      ) : (
                        "-"
                      )}
                    </td>
                  )}
                  <td className={TD}>{d.targetDirection ?? "-"}</td>
                  <td className={TD}>
                    {d.confidence !== null ? d.confidence.toFixed(2) : "-"}
                  </td>
                  <td className={TD}>{d.positionAction ?? "-"}</td>
                  <td className={TD}>
                    {d.success ? (
                      <span className="text-emerald-400">ok</span>
                    ) : (
                      <div className="text-destructive">
                        <span>error</span>
                        {d.error && (
                          <div
                            className="mt-1 max-w-xs whitespace-pre-wrap text-xs"
                            title={d.error}
                          >
                            {d.error}
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  {showPayloads && (
                    <td className={TD}>
                      {d.rawRequest || d.rawResponse ? (
                        <details>
                          <summary className="cursor-pointer text-subtext-0">
                            view
                          </summary>
                          <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap text-xs text-subtext-1">
                            {JSON.stringify(
                              {
                                request: d.rawRequest,
                                response: d.rawResponse,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      ) : (
                        "-"
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {decisions && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs text-subtext-1">
          <div className="flex items-center gap-2">
            <span>
              {firstRow.toLocaleString()}–{lastRow.toLocaleString()} of{" "}
              {total.toLocaleString()}
            </span>
            <Select
              aria-label="Rows per page"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="py-1 text-xs"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="px-2 py-1"
              aria-label="Previous page"
              disabled={page === 0}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <span>
              Page {page + 1} of {pageCount}
            </span>
            <Button
              variant="ghost"
              className="px-2 py-1"
              aria-label="Next page"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
