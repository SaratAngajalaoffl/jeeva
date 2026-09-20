"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import PriceVolumeChart, {
  chartRangeMs,
  type ChartRange,
} from "@/components/PriceVolumeChart";
import { SiteHeader } from "@/components/SiteHeader";
import { Button, Card, Skeleton } from "@/components/ui";
import {
  fetchDecisions,
  fetchFundingPayments,
  fetchMarketData,
  fetchPerpStats,
  fetchPositions,
  fetchTradingSessions,
  hardCloseTradingSession,
  softCloseTradingSession,
  type DecisionLogEntry,
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
  const { symbol, sessionId } = params;

  const [session, setSession] = useState<TradingSession | null | undefined>(
    undefined,
  );
  const [samples, setSamples] = useState<MarketDataPoint[] | null>(null);
  const [range, setRange] = useState<ChartRange>("1d");
  const [oldestSampleTime, setOldestSampleTime] = useState<
    string | null | undefined
  >(undefined);
  const [stats, setStats] = useState<PerpStats | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
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
      fetchMarketData(symbol, { from: new Date(Date.now() - chartRangeMs(range)) })
        .then((s) => {
          setSamples(s.samples);
          setOldestSampleTime(s.oldestSampleTime);
        })
        .catch(() => {});
      fetchPerpStats()
        .then((stats) => setStats(stats.find((s) => s.symbol === symbol) ?? null))
        .catch(() => {});
      fetchPositions()
        .then((positions) => {
          setPosition(positions.find((p) => p.sessionId === sessionId) ?? null);
        })
        .catch(() => {});
      fetchDecisions({ sessionId })
        .then(setDecisions)
        .catch(() => setDecisions([]));
      fetchFundingPayments()
        .then((payments) => {
          setFundingPayments(payments.filter((p) => p.sessionId === sessionId));
        })
        .catch(() => setFundingPayments([]));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [symbol, sessionId, range]);

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
            <Skeleton className="h-24 w-full" />
          </Card>
        ) : (
          <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
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
                {pnl === null ? "-" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
              </span>
            </div>

            {session.status === "active" && (
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" disabled={busy} onClick={handleSoftClose}>
                  Soft close
                </Button>
                <Button variant="ghost" disabled={busy} onClick={handleHardClose}>
                  Hard close
                </Button>
              </div>
            )}
            {session.status === "soft_closing" && (
              <div className="ml-auto">
                <Button variant="ghost" disabled={busy} onClick={handleHardClose}>
                  Force close now
                </Button>
              </div>
            )}
          </Card>
        )}

        {samples && (
          <PriceVolumeChart
            title="Market data"
            range={range}
            onRangeChange={setRange}
            oldestSampleTime={oldestSampleTime}
            pricePoints={samples.map((s) => ({ x: s.time, y: s.price }))}
            volumePoints={samples.map((s) => ({ x: s.time, y: s.volume }))}
          />
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">Position</h2>
          {!position ? (
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

        <Card className="flex flex-col p-0">
          <h2 className="p-5 pb-0 text-sm font-semibold text-text">
            Decision history
          </h2>
          <div className="overflow-x-auto">
            {!decisions ? (
              <p className="p-5 text-sm text-subtext-1">Loading...</p>
            ) : decisions.length === 0 ? (
              <p className="p-5 text-sm text-subtext-1">No decisions yet.</p>
            ) : (
              <table className="w-full min-w-[560px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Time</th>
                    <th className={TH}>Direction</th>
                    <th className={TH}>Confidence</th>
                    <th className={TH}>Action</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.slice(0, 50).map((d, i) => (
                    <tr key={i} className="hover:bg-surface-0/60">
                      <td className={TD}>{new Date(d.time).toLocaleString()}</td>
                      <td className={TD}>{d.targetDirection ?? "-"}</td>
                      <td className={TD}>
                        {d.confidence !== null ? d.confidence.toFixed(2) : "-"}
                      </td>
                      <td className={TD}>{d.positionAction ?? "no_op"}</td>
                      <td className={TD}>
                        {d.success ? (
                          <span className="text-emerald-400">ok</span>
                        ) : (
                          <span className="text-destructive">error</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card className="flex flex-col p-0">
          <h2 className="p-5 pb-0 text-sm font-semibold text-text">
            Funding history
          </h2>
          <div className="overflow-x-auto">
            {!fundingPayments ? (
              <p className="p-5 text-sm text-subtext-1">Loading...</p>
            ) : fundingPayments.length === 0 ? (
              <p className="p-5 text-sm text-subtext-1">
                No funding payments yet.
              </p>
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
                      <td className={TD}>{new Date(p.time).toLocaleString()}</td>
                      <td className={TD}>{p.direction}</td>
                      <td className={TD}>{(p.fundingRate * 100).toFixed(4)}%</td>
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
