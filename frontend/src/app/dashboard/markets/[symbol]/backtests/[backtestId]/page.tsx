"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SiteHeader } from "@/components/SiteHeader";
import { Card, Skeleton } from "@/components/ui";
import {
  fetchBacktest,
  fetchBacktestDecisions,
  fetchBacktestPosition,
  fetchBacktestTrades,
  type BacktestDecisionEntry,
  type BacktestPosition,
  type BacktestRun,
  type BacktestTrade,
} from "@/lib/api";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

const POLL_MS = 5_000;

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "-";
  return `$${price.toLocaleString(undefined, {
    maximumFractionDigits: price < 1 ? 6 : 2,
  })}`;
}

function StatusBadge({ status }: { status: BacktestRun["status"] }) {
  const styles: Record<BacktestRun["status"], string> = {
    pending: "border-surface-1 text-subtext-0",
    running: "border-peach/50 bg-peach/10 text-peach",
    completed: "border-emerald-400/50 bg-emerald-400/10 text-emerald-400",
    failed: "border-destructive/50 bg-destructive/10 text-destructive",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${styles[status]}`}
    >
      {status}
    </span>
  );
}

export default function BacktestDetailPage() {
  const params = useParams<{ symbol: string; backtestId: string }>();
  const { symbol, backtestId } = params;

  const [backtest, setBacktest] = useState<BacktestRun | null | undefined>(
    undefined,
  );
  const [position, setPosition] = useState<BacktestPosition | null>(null);
  const [decisions, setDecisions] = useState<BacktestDecisionEntry[] | null>(
    null,
  );
  const [trades, setTrades] = useState<BacktestTrade[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    function poll() {
      fetchBacktest(backtestId)
        .then((b) => {
          if (!cancelled) setBacktest(b);
        })
        .catch(() => {
          if (!cancelled) setBacktest(null);
        });
      fetchBacktestPosition(backtestId)
        .then((p) => !cancelled && setPosition(p))
        .catch(() => {});
      fetchBacktestDecisions(backtestId)
        .then((d) => !cancelled && setDecisions(d))
        .catch(() => !cancelled && setDecisions([]));
      fetchBacktestTrades(backtestId)
        .then((t) => !cancelled && setTrades(t))
        .catch(() => !cancelled && setTrades([]));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [backtestId]);

  const totalPnl = trades?.reduce((sum, t) => sum + t.pnlUsd, 0) ?? null;

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
            Backtest {backtestId.slice(0, 8)}
          </h1>
          {backtest && <StatusBadge status={backtest.status} />}
        </div>

        {backtest === null ? (
          <Card className="p-5">
            <p className="text-sm text-subtext-1">Backtest not found.</p>
          </Card>
        ) : backtest === undefined ? (
          <Card className="p-5">
            <Skeleton className="h-24 w-full" />
          </Card>
        ) : (
          <>
            <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Decision maker
                </span>
                <span className="text-sm font-medium text-text">
                  {backtest.decisionMaker}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Decision freq
                </span>
                <span className="text-sm font-medium text-text">
                  {backtest.decisionFrequencySeconds}s
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Leverage
                </span>
                <span className="text-sm font-medium text-text">
                  {backtest.leverage}x
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Position size
                </span>
                <span className="text-sm font-medium text-text">
                  ${backtest.positionSizeUsd.toLocaleString()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Range
                </span>
                <span className="text-sm font-medium text-text">
                  {new Date(backtest.startTime).toLocaleDateString()} &rarr;{" "}
                  {new Date(backtest.endTime).toLocaleDateString()}
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Balance
                </span>
                <span className="text-sm font-medium text-text">
                  ${backtest.currentBalanceUsd.toLocaleString()} / $
                  {backtest.initialBalanceUsd.toLocaleString()} initial
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] uppercase tracking-wide text-subtext-0">
                  Realized P&amp;L
                </span>
                <span
                  className={`text-sm font-medium ${
                    totalPnl === null
                      ? "text-text"
                      : totalPnl >= 0
                        ? "text-emerald-400"
                        : "text-destructive"
                  }`}
                >
                  {totalPnl === null
                    ? "-"
                    : `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`}
                </span>
              </div>
            </Card>

            {backtest.error && (
              <Card className="p-5">
                <p className="text-sm text-destructive">{backtest.error}</p>
              </Card>
            )}
          </>
        )}

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">
            Open position (as of latest replayed step)
          </h2>
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
              <dt className="text-subtext-0">Opened (sim time)</dt>
              <dd className="text-right text-text">
                {new Date(position.openedAt).toLocaleString()}
              </dd>
            </dl>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">
            Decision history (simulated time)
          </h2>
          <div className="overflow-x-auto">
            {!decisions ? (
              <p className="text-sm text-subtext-1">Loading...</p>
            ) : decisions.length === 0 ? (
              <p className="text-sm text-subtext-1">No decisions yet.</p>
            ) : (
              <table className="w-full min-w-[560px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Sim time</th>
                    <th className={TH}>Direction</th>
                    <th className={TH}>Confidence</th>
                    <th className={TH}>Action</th>
                    <th className={TH}>Status</th>
                    <th className={TH}>Payload</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d) => (
                    <tr key={d.id} className="hover:bg-surface-0/60">
                      <td className={TD}>
                        {new Date(d.simTime).toLocaleString()}
                      </td>
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
                      <td className={TD}>
                        {d.rawRequest || d.rawResponse ? (
                          <details>
                            <summary className="cursor-pointer text-subtext-0">
                              view
                            </summary>
                            <pre className="mt-1 max-w-xs overflow-x-auto whitespace-pre-wrap text-xs text-subtext-1">
                              {JSON.stringify(
                                { request: d.rawRequest, response: d.rawResponse },
                                null,
                                2,
                              )}
                            </pre>
                          </details>
                        ) : (
                          "-"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-text">
            Closed trades
          </h2>
          <div className="overflow-x-auto">
            {!trades ? (
              <p className="text-sm text-subtext-1">Loading...</p>
            ) : trades.length === 0 ? (
              <p className="text-sm text-subtext-1">No closed trades yet.</p>
            ) : (
              <table className="w-full min-w-[620px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Closed</th>
                    <th className={TH}>Direction</th>
                    <th className={TH}>Entry</th>
                    <th className={TH}>Exit</th>
                    <th className={TH}>Notional</th>
                    <th className={TH}>P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr key={t.id} className="hover:bg-surface-0/60">
                      <td className={TD}>
                        {new Date(t.closedAt).toLocaleString()}
                      </td>
                      <td className={TD}>{t.direction}</td>
                      <td className={TD}>{formatPrice(t.entryPrice)}</td>
                      <td className={TD}>{formatPrice(t.exitPrice)}</td>
                      <td className={TD}>${t.notionalUsd.toLocaleString()}</td>
                      <td
                        className={`${TD} ${
                          t.pnlUsd >= 0 ? "text-emerald-400" : "text-destructive"
                        }`}
                      >
                        {t.pnlUsd >= 0 ? "+" : ""}
                        {t.pnlUsd.toFixed(2)}
                      </td>
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
