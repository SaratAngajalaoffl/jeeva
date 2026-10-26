"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PriceVolumeChart, {
  chartRangeFrom,
  type ChartRange,
  type ChartSelection,
} from "@/components/PriceVolumeChart";
import DecisionHistoryPanel from "@/components/DecisionHistoryPanel";
import { SiteHeader } from "@/components/SiteHeader";
import { Uptime } from "@/components/RelativeTime";
import { formatShortDateTime } from "@/lib/format";
import { formatHistoryWindow } from "@/lib/historyWindow";
import {
  Button,
  Card,
  DetailListSkeleton,
  EmptyState,
  Skeleton,
  StatStripSkeleton,
  TableSkeleton,
} from "@/components/ui";
import { Coins } from "lucide-react";
import {
  fetchFundingPayments,
  fetchMarketData,
  fetchPerpStats,
  fetchPositions,
  fetchTradingSessions,
  hardCloseTradingSession,
  softCloseTradingSession,
  type FundingPayment,
  type MarketDataPoint,
  type PerpStats,
  type Position,
  type TradingSession,
} from "@/lib/api";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

const POLL_MS = 10_000;

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "-";
  return `$${price.toLocaleString(undefined, {
    maximumFractionDigits: price < 1 ? 6 : 2,
  })}`;
}

function SessionStatusBadge({ status }: { status: TradingSession["status"] }) {
  const styles: Record<TradingSession["status"], string> = {
    active: "border-emerald-400/50 bg-emerald-400/10 text-emerald-400",
    soft_closing: "border-peach/50 bg-peach/10 text-peach",
    hard_closing: "border-destructive/50 bg-destructive/10 text-destructive",
    closed: "border-surface-1 text-subtext-0",
  };
  const labels: Record<TradingSession["status"], string> = {
    active: "Active",
    soft_closing: "Soft closing",
    hard_closing: "Hard closing",
    closed: "Closed",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

export default function SessionDetailPage() {
  const params = useParams<{ symbol: string; sessionId: string }>();
  const symbol = decodeURIComponent(params.symbol);
  const { sessionId } = params;

  const [session, setSession] = useState<TradingSession | null | undefined>(
    undefined,
  );
  const [samples, setSamples] = useState<MarketDataPoint[] | null>(null);
  const [range, setRange] = useState<ChartRange>("1d");
  // A window dragged out on the chart; it zooms the chart and scopes the
  // decision and funding history below to the same period.
  const [selection, setSelection] = useState<ChartSelection | null>(null);
  const [oldestSampleTime, setOldestSampleTime] = useState<
    string | null | undefined
  >(undefined);
  const [stats, setStats] = useState<PerpStats | null>(null);
  const [position, setPosition] = useState<Position | null | undefined>(
    undefined,
  );
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [sectionErrors, setSectionErrors] = useState<{
    marketData?: string;
    position?: string;
    funding?: string;
  }>({});
  const [busy, setBusy] = useState(false);

  function refresh() {
    fetchTradingSessions(symbol)
      .then((sessions) => {
        setSession(sessions.find((s) => s.id === sessionId) ?? null);
      })
      .catch(() => setSession(null));
  }

  useEffect(() => {
    function poll() {
      refresh();
      fetchMarketData(symbol, {
        from: chartRangeFrom(range),
      })
        .then((s) => {
          setSamples(s.samples);
          setOldestSampleTime(s.oldestSampleTime);
          setSectionErrors((prev) => ({ ...prev, marketData: undefined }));
        })
        .catch(() =>
          setSectionErrors((prev) => ({
            ...prev,
            marketData: "Failed to load market data.",
          })),
        );
      fetchPerpStats()
        .then((stats) =>
          setStats(stats.find((s) => s.symbol === symbol) ?? null),
        )
        .catch(() => {});
      fetchPositions()
        .then((positions) => {
          setPosition(positions.find((p) => p.sessionId === sessionId) ?? null);
          setSectionErrors((prev) => ({ ...prev, position: undefined }));
        })
        .catch(() =>
          setSectionErrors((prev) => ({
            ...prev,
            position: "Failed to load position.",
          })),
        );
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [symbol, sessionId, range]);

  useEffect(() => {
    setSelection(null);
  }, [symbol, sessionId, range]);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetchFundingPayments({
        sessionId,
        from: selection ? new Date(selection.from) : chartRangeFrom(range),
        to: selection ? new Date(selection.to) : new Date(),
        limit: 1000,
      })
        .then((payments) => {
          if (cancelled) return;
          setFundingPayments(payments);
          setSectionErrors((prev) => ({ ...prev, funding: undefined }));
        })
        .catch(() => {
          if (cancelled) return;
          setSectionErrors((prev) => ({
            ...prev,
            funding: "Failed to load funding history.",
          }));
        });
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sessionId, range, selection]);

  const pnl = useMemo(() => {
    if (!position || !stats) return null;
    return (
      ((stats.price - position.entryPrice) / position.entryPrice) *
      position.notionalUsd *
      (position.direction === "long" ? 1 : -1)
    );
  }, [position, stats]);

  async function handleSoftClose() {
    setBusy(true);
    setError(null);
    const result = await softCloseTradingSession(sessionId);
    if (!result.ok) setError(result.error);
    setBusy(false);
    refresh();
  }

  async function handleHardClose() {
    setBusy(true);
    setError(null);
    const result = await hardCloseTradingSession(sessionId);
    if (!result.ok) setError(result.error);
    setBusy(false);
    refresh();
  }

  return (
    <SiteHeader>
      <main className="flex flex-col gap-4 px-6 py-8 sm:px-8 lg:px-12">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href={`/dashboard/markets/${symbol}`}
            className="text-sm text-ember hover:underline"
          >
            &larr; {symbol}
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-text">
            Session {sessionId.slice(0, 8)}
          </h1>
          {session && <SessionStatusBadge status={session.status} />}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {session === null ? (
          <Card className="p-5">
            <p className="text-sm text-subtext-1">Session not found.</p>
          </Card>
        ) : session === undefined ? (
          <Card className="p-5">
            <StatStripSkeleton count={7} label="Loading session" />
          </Card>
        ) : (
          <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Started
              </span>
              <span
                className="text-sm font-medium text-text"
                title={new Date(session.createdAt).toLocaleString()}
              >
                {formatShortDateTime(session.createdAt)}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                {session.closedAt ? "Ran for" : "Running for"}
              </span>
              <Uptime
                since={session.createdAt}
                until={session.closedAt}
                className="text-sm font-medium tabular-nums text-text"
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Decision maker
              </span>
              <span className="text-sm font-medium text-text">
                {session.decisionMaker}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Decision freq
              </span>
              <span className="text-sm font-medium text-text">
                {session.decisionFrequencySeconds}s
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Leverage
              </span>
              <span className="text-sm font-medium text-text">
                {session.leverage}x
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Position size
              </span>
              <span className="text-sm font-medium text-text">
                ${session.positionSizeUsd.toLocaleString()}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                History window
              </span>
              <span className="text-sm font-medium text-text">
                {formatHistoryWindow(session.historyWindowSeconds)} ({session.historyFormat})
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Wallet
              </span>
              <span className="text-sm font-medium text-text">
                {session.walletId ? session.walletId.slice(0, 8) : "None"}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                Unrealized P&amp;L
              </span>
              <span
                className={`text-sm font-medium ${
                  pnl === null
                    ? "text-text"
                    : pnl >= 0
                      ? "text-emerald-400"
                      : "text-destructive"
                }`}
              >
                {pnl === null
                  ? "-"
                  : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
              </span>
            </div>

            {session.status === "active" && (
              <div className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={handleSoftClose}
                >
                  Soft close
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={handleHardClose}
                >
                  Hard close
                </Button>
              </div>
            )}
            {session.status === "soft_closing" && (
              <div className="ml-auto">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={handleHardClose}
                >
                  Force close now
                </Button>
              </div>
            )}
          </Card>
        )}

        {sectionErrors.marketData ? (
          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold text-text">
              Market data
            </h2>
            <p className="text-sm text-destructive">
              {sectionErrors.marketData}
            </p>
          </Card>
        ) : samples ? (
          <PriceVolumeChart
            title="Market data"
            range={range}
            onRangeChange={setRange}
            oldestSampleTime={oldestSampleTime}
            pricePoints={samples.map((s) => ({ x: s.time, y: s.price }))}
            volumePoints={samples.map((s) => ({ x: s.time, y: s.volume }))}
            selection={selection}
            onSelectionChange={setSelection}
          />
        ) : (
          <Card className="p-5">
            <h2 className="mb-2 text-sm font-semibold text-text">
              Market data
            </h2>
            <Skeleton className="h-56 w-full" />
          </Card>
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">Position</h2>
          {sectionErrors.position ? (
            <p className="text-sm text-destructive">{sectionErrors.position}</p>
          ) : position === undefined ? (
            <DetailListSkeleton label="Loading position" />
          ) : !position ? (
            <p className="text-sm text-subtext-1">No open position.</p>
          ) : (
            <dl className="grid max-w-sm grid-cols-2 gap-y-2 text-sm">
              <dt className="text-subtext-0">Direction</dt>
              <dd
                className={`text-right font-medium ${
                  position.direction === "long"
                    ? "text-emerald-400"
                    : "text-destructive"
                }`}
              >
                {position.direction}
              </dd>
              <dt className="text-subtext-0">Entry price</dt>
              <dd className="text-right text-text">
                {formatPrice(position.entryPrice)}
              </dd>
              <dt className="text-subtext-0">Notional</dt>
              <dd className="text-right text-text">
                ${position.notionalUsd.toLocaleString()}
              </dd>
              <dt className="text-subtext-0">Opened</dt>
              <dd className="text-right text-text">
                {new Date(position.openedAt).toLocaleString()}
              </dd>
            </dl>
          )}
        </Card>

        <Card className="p-0">
          <h2 className="px-5 pt-5 text-sm font-semibold text-text">
            Decision history
          </h2>
          <DecisionHistoryPanel
            symbol={symbol}
            sessionId={sessionId}
            range={range}
            selection={selection}
          />
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">
            Funding history
          </h2>
          <div className="overflow-x-auto">
            {sectionErrors.funding ? (
              <p className="text-sm text-destructive">
                {sectionErrors.funding}
              </p>
            ) : !fundingPayments ? (
              <TableSkeleton columns={4} label="Loading funding payments" />
            ) : fundingPayments.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No funding payments yet."
                description="Funding is settled periodically while a position is open."
              />
            ) : (
              <table className="w-full min-w-[520px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Time</th>
                    <th className={TH}>Direction</th>
                    <th className={TH}>Rate</th>
                    <th className={TH}>Amount (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {fundingPayments.map((p, i) => (
                    <tr key={i} className="hover:bg-surface-0/60">
                      <td className={TD}>
                        {new Date(p.time).toLocaleString()}
                      </td>
                      <td className={TD}>{p.direction}</td>
                      <td className={TD}>
                        {(p.fundingRate * 100).toFixed(4)}%
                      </td>
                      <td className={TD}>{p.amountUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>
      </main>
    </SiteHeader>
  );
}
