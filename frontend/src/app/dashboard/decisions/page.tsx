"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, XCircle } from "lucide-react";
import {
  fetchDecisions,
  fetchPerpHealth,
  fetchPerpStats,
  fetchPerps,
  fetchPositions,
  type DecisionLogEntry,
  type Perp,
  type PerpHealth,
  type PerpStats,
  type Position,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Card, Label, Select, Skeleton, StatTile } from "@/components/ui";

type PositionState = "flat" | "long" | "short";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-3 pr-4";

const STATE_COLOR: Record<PositionState, string> = {
  flat: "text-subtext-0",
  long: "text-emerald-400",
  short: "text-destructive",
};

const STATE_BADGE: Record<PositionState, string> = {
  flat: "bg-surface-2 text-subtext-0",
  long: "bg-emerald-400/15 text-emerald-400",
  short: "bg-destructive/15 text-destructive",
};

const ACTION_BADGE: Record<string, string> = {
  opened: "bg-emerald-400/15 text-emerald-400",
  closed: "bg-peach/15 text-peach",
  closed_and_opened: "bg-ember/15 text-ember",
  no_op: "bg-surface-2 text-subtext-0",
};

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ProbabilityBar({
  probabilities,
}: {
  probabilities: { long: number; short: number; flat: number };
}) {
  return (
    <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
      <div
        className="bg-emerald-400"
        style={{ width: `${probabilities.long * 100}%` }}
      />
      <div
        className="bg-destructive"
        style={{ width: `${probabilities.short * 100}%` }}
      />
      <div
        className="bg-overlay-1"
        style={{ width: `${probabilities.flat * 100}%` }}
      />
    </div>
  );
}

function PositionCard({
  perp,
  position,
  markPrice,
  health,
}: {
  perp: Perp;
  position: Position | undefined;
  markPrice: number | undefined;
  health: PerpHealth | undefined;
}) {
  const state: PositionState = position?.direction ?? "flat";
  const unhealthy = (health?.consecutiveFailures ?? 0) > 0;

  const unrealizedPnlUsd =
    position && markPrice
      ? position.notionalUsd *
        (markPrice / position.entryPrice - 1) *
        (position.direction === "long" ? 1 : -1)
      : null;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-text">{perp.symbol}</span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATE_BADGE[state]}`}
          >
            {state}
          </span>
        </div>
        <span
          className={`h-2 w-2 rounded-full ${
            unhealthy ? "bg-destructive" : "bg-emerald-400"
          }`}
          title={
            unhealthy
              ? `${health?.consecutiveFailures} consecutive failure(s): ${health?.lastFailureReason ?? "unknown"}`
              : "Healthy"
          }
        />
      </div>

      {position ? (
        <>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-xs uppercase tracking-wide text-subtext-0">
                Entry price
              </span>
              <p className="text-text">{position.entryPrice.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-subtext-0">
                Mark price
              </span>
              <p className="text-text">
                {markPrice ? markPrice.toLocaleString() : "-"}
              </p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-subtext-0">
                Notional
              </span>
              <p className="text-text">${position.notionalUsd.toLocaleString()}</p>
            </div>
            <div>
              <span className="text-xs uppercase tracking-wide text-subtext-0">
                Unrealized P&amp;L
              </span>
              <p
                className={
                  unrealizedPnlUsd === null
                    ? "text-text"
                    : unrealizedPnlUsd >= 0
                      ? "text-emerald-400"
                      : "text-destructive"
                }
              >
                {unrealizedPnlUsd === null
                  ? "-"
                  : `${unrealizedPnlUsd >= 0 ? "+" : ""}$${unrealizedPnlUsd.toFixed(2)}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 text-xs text-subtext-0">
            <Clock size={12} />
            Opened {timeAgo(position.openedAt)}
          </div>
        </>
      ) : (
        <p className="text-sm text-subtext-1">No open position.</p>
      )}
    </Card>
  );
}

export default function DecisionsPage() {
  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [perpStats, setPerpStats] = useState<PerpStats[]>([]);
  const [perpHealth, setPerpHealth] = useState<PerpHealth[]>([]);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [symbolFilter, setSymbolFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchPerps(), fetchPositions()])
      .then(([perps, positions]) => {
        setPerps(perps);
        setPositions(positions);
      })
      .catch(() => setError("Failed to load positions"));
    fetchPerpStats()
      .then(setPerpStats)
      .catch(() => setPerpStats([]));
    fetchPerpHealth()
      .then(setPerpHealth)
      .catch(() => setPerpHealth([]));
  }, []);

  useEffect(() => {
    fetchDecisions(symbolFilter || undefined)
      .then(setDecisions)
      .catch(() => setError("Failed to load decision history"));
  }, [symbolFilter]);

  const statsBySymbol = useMemo(
    () => new Map(perpStats.map((s) => [s.symbol, s.price])),
    [perpStats],
  );
  const healthBySymbol = useMemo(
    () => new Map(perpHealth.map((h) => [h.symbol, h])),
    [perpHealth],
  );

  const tradingPerps = (perps ?? []).filter((p) => p.tradingEnabled);
  const openPositions = positions ?? [];
  const longCount = openPositions.filter((p) => p.direction === "long").length;
  const shortCount = openPositions.filter(
    (p) => p.direction === "short",
  ).length;
  const totalNotionalUsd = openPositions.reduce(
    (sum, p) => sum + p.notionalUsd,
    0,
  );
  const totalUnrealizedPnlUsd = openPositions.reduce((sum, p) => {
    const markPrice = statsBySymbol.get(p.symbol);
    if (!markPrice) return sum;
    const pnl =
      p.notionalUsd *
      (markPrice / p.entryPrice - 1) *
      (p.direction === "long" ? 1 : -1);
    return sum + pnl;
  }, 0);

  return (
    <SiteHeader>
      <main className="flex flex-col gap-8 px-6 py-8 sm:px-8 lg:px-12">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Positions
        </h1>

        {error && <p className="-mt-4 text-sm text-destructive">{error}</p>}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {!perps || !positions ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="flex flex-col gap-2 p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-16" />
              </Card>
            ))
          ) : (
            <>
              <StatTile label="Open positions" value={openPositions.length} />
              <StatTile label="Long / Short" value={`${longCount} / ${shortCount}`} />
              <StatTile
                label="Total notional"
                value={`$${totalNotionalUsd.toLocaleString()}`}
              />
              <StatTile
                label="Unrealized P&L"
                value={`${totalUnrealizedPnlUsd >= 0 ? "+" : ""}$${totalUnrealizedPnlUsd.toFixed(2)}`}
                tone={
                  totalUnrealizedPnlUsd > 0
                    ? "positive"
                    : totalUnrealizedPnlUsd < 0
                      ? "negative"
                      : "default"
                }
              />
            </>
          )}
        </section>

        <section className="flex flex-col gap-3">
          {!perps || !positions ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="flex flex-col gap-3 p-5">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-16 w-full" />
                </Card>
              ))}
            </div>
          ) : tradingPerps.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-sm text-subtext-1">
                No markets have trading enabled yet.
              </p>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {tradingPerps.map((perp) => (
                <PositionCard
                  key={perp.symbol}
                  perp={perp}
                  position={positions.find((p) => p.symbol === perp.symbol)}
                  markPrice={statsBySymbol.get(perp.symbol)}
                  health={healthBySymbol.get(perp.symbol)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold tracking-tight text-text">
              Decision history
            </h2>
            <label className="flex items-center gap-2">
              <Label>Filter by symbol</Label>
              <Select
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
              >
                <option value="">All</option>
                {perps?.map((p) => (
                  <option key={p.symbol} value={p.symbol}>
                    {p.symbol}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          {!decisions ? (
            <Card className="p-0">
              <div className="flex flex-col gap-px p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </Card>
          ) : decisions.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-sm text-subtext-1">No decisions yet.</p>
            </Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Time</th>
                    <th className={TH}>Symbol</th>
                    <th className={TH}>Target direction</th>
                    <th className={TH}>Probabilities</th>
                    <th className={TH}>Confidence</th>
                    <th className={TH}>Action</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d, i) => (
                    <tr key={i} className="hover:bg-surface-0/60">
                      <td className={`${TD} text-subtext-1`}>
                        {new Date(d.time).toLocaleString()}
                      </td>
                      <td className={`${TD} font-medium`}>{d.symbol}</td>
                      <td
                        className={`${TD} ${d.targetDirection ? STATE_COLOR[d.targetDirection] : "text-subtext-0"}`}
                      >
                        {d.targetDirection ?? "-"}
                      </td>
                      <td className={TD}>
                        {d.probabilities ? (
                          <ProbabilityBar probabilities={d.probabilities} />
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className={`${TD} text-subtext-1`}>
                        {d.confidence !== null ? d.confidence.toFixed(2) : "-"}
                      </td>
                      <td className={TD}>
                        {d.positionAction ? (
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${ACTION_BADGE[d.positionAction] ?? ACTION_BADGE.no_op}`}
                          >
                            {d.positionAction}
                          </span>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className={TD}>
                        {d.success ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 size={14} />
                            ok
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-destructive">
                            <XCircle size={14} />
                            {`error: ${d.error}`}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      </main>
    </SiteHeader>
  );
}
