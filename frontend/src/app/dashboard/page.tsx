"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  checkSession,
  fetchAllTradingSessions,
  fetchDecisions,
  fetchFundingPayments,
  fetchPerpHealth,
  fetchPerps,
  fetchPositions,
  fetchWallets,
  logout,
  type DecisionLogEntry,
  type FundingPayment,
  type Perp,
  type PerpHealth,
  type Position,
  type TradingSession,
  type Wallet,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { DecisionMakerStatusList } from "@/components/DecisionMakerStatusList";
import { Card, StatTile, StatTileSkeleton, Skeleton } from "@/components/ui";
import BarChart from "@/components/BarChart";
import DonutChart from "@/components/DonutChart";
import LineChart from "@/components/LineChart";

const ORDER_ACTIONS = new Set(["opened", "closed", "closed_and_opened"]);

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [sessions, setSessions] = useState<TradingSession[]>([]);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [wallets, setWallets] = useState<Wallet[] | undefined>(undefined);
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [perpHealth, setPerpHealth] = useState<PerpHealth[] | null>(null);

  useEffect(() => {
    let cancelled = false;

    checkSession().then((authenticated) => {
      if (cancelled) return;
      if (!authenticated) {
        router.replace("/login");
        return;
      }
      setChecking(false);
    });

    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (checking) return;
    fetchPerps().then(setPerps).catch(() => setPerps([]));
    fetchAllTradingSessions().then(setSessions).catch(() => setSessions([]));
    fetchPositions().then(setPositions).catch(() => setPositions([]));
    fetchDecisions().then(setDecisions).catch(() => setDecisions([]));
    fetchWallets().then(setWallets).catch(() => setWallets([]));
    fetchFundingPayments()
      .then(setFundingPayments)
      .catch(() => setFundingPayments([]));
    fetchPerpHealth()
      .then(setPerpHealth)
      .catch(() => setPerpHealth([]));
  }, [checking]);

  if (checking) {
    return null;
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const loading =
    !perps ||
    !positions ||
    !decisions ||
    wallets === undefined ||
    !perpHealth;

  const orders = decisions?.filter(
    (d) => d.positionAction && ORDER_ACTIONS.has(d.positionAction),
  ) ?? [];

  const positionSizeBySymbol = new Map<string, number>();
  for (const session of sessions) {
    if (session.status === "closed") continue;
    positionSizeBySymbol.set(
      session.symbol,
      (positionSizeBySymbol.get(session.symbol) ?? 0) + session.positionSizeUsd,
    );
  }
  const totalVolumeUsd = orders.reduce(
    (sum, d) => sum + (positionSizeBySymbol.get(d.symbol) ?? 0),
    0,
  );

  const marketsTraded = new Set([
    ...(positions ?? []).map((p) => p.symbol),
    ...orders.map((d) => d.symbol),
  ]).size;

  const directionCounts = { long: 0, short: 0, flat: 0 };
  for (const d of decisions ?? []) {
    if (d.targetDirection) directionCounts[d.targetDirection] += 1;
  }

  const ordersBySymbol = new Map<string, number>();
  for (const d of orders) {
    ordersBySymbol.set(d.symbol, (ordersBySymbol.get(d.symbol) ?? 0) + 1);
  }
  const orderBars = [...ordersBySymbol.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([label, value]) => ({ label, value }));

  const cumulativeFunding = (() => {
    if (!fundingPayments || fundingPayments.length === 0) return [];
    const sorted = [...fundingPayments].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    );
    let running = 0;
    return sorted.map((p) => {
      running += p.amountUsd;
      return { x: p.time, y: Number(running.toFixed(4)) };
    });
  })();

  const mockWallets = (wallets ?? []).filter((w) => w.kind === "mock");
  const totalBalanceUsd = mockWallets.reduce(
    (sum, w) => sum + (w.currentBalanceUsd ?? 0),
    0,
  );
  const pnl = mockWallets.reduce(
    (sum, w) =>
      sum + ((w.currentBalanceUsd ?? 0) - (w.initialBalanceUsd ?? 0)),
    0,
  );
  const pnlTone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "default";

  const unhealthyMarkets = (perpHealth ?? []).filter(
    (h) => h.consecutiveFailures > 0,
  );

  return (
    <SiteHeader onLogout={handleLogout}>
      <main className="flex flex-col gap-6 px-6 py-8 sm:px-8 lg:px-12">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Overview
        </h1>

        {loading ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <StatTileSkeleton key={i} />
              ))}
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <Skeleton className="h-64 w-full" />
              </Card>
              <Card>
                <Skeleton className="h-64 w-full" />
              </Card>
            </div>
            <Card>
              <Skeleton className="h-48 w-full" />
            </Card>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <Skeleton className="h-48 w-full" />
              </Card>
              <Card>
                <Skeleton className="h-48 w-full" />
              </Card>
              <Card>
                <Skeleton className="h-48 w-full" />
              </Card>
            </div>
          </>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatTile
                label="Wallet balance"
                value={
                  mockWallets.length > 0
                    ? `$${totalBalanceUsd.toLocaleString()}`
                    : "-"
                }
              />
              <StatTile
                label="All-time P&L"
                value={
                  mockWallets.length > 0
                    ? `${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString()}`
                    : "-"
                }
                tone={pnlTone}
              />
              <StatTile
                label="Active positions"
                value={(positions ?? []).length}
              />
              <StatTile label="Markets traded" value={marketsTraded} />
              <StatTile label="Total orders" value={orders.length} />
              <StatTile
                label="Total volume"
                value={`$${totalVolumeUsd.toLocaleString()}`}
              />
            </div>

            <div className="grid gap-4 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <LineChart
                  title="Cumulative funding P&L"
                  unit="USD"
                  points={cumulativeFunding}
                />
              </div>
              <DonutChart
                title="Decision direction split"
                slices={[
                  { label: "Long", value: directionCounts.long, color: "#4ade80" },
                  { label: "Short", value: directionCounts.short, color: "#ff6b6b" },
                  { label: "Flat", value: directionCounts.flat, color: "#8a5b60" },
                ]}
              />
            </div>

            <BarChart title="Orders by market" bars={orderBars} />

            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-text">
                    Open positions
                  </h3>
                  <Link
                    href="/dashboard/decisions"
                    className="text-xs text-ember hover:underline"
                  >
                    View all
                  </Link>
                </div>
                {(positions ?? []).length === 0 ? (
                  <p className="text-sm text-subtext-1">No open positions.</p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {(positions ?? []).map((p) => (
                      <li
                        key={p.symbol}
                        className="flex items-center justify-between border-b border-surface-1 pb-2 last:border-0 last:pb-0"
                      >
                        <span className="font-medium text-text">
                          {p.symbol}
                        </span>
                        <span
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
                            p.direction === "long"
                              ? "bg-emerald-400/15 text-emerald-400"
                              : "bg-destructive/15 text-destructive"
                          }`}
                        >
                          {p.direction}
                        </span>
                        <span className="text-subtext-1">
                          ${p.notionalUsd.toLocaleString()}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card className="flex flex-col gap-3 p-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-text">
                    Engine health
                  </h3>
                  <Link
                    href="/dashboard/markets"
                    className="text-xs text-ember hover:underline"
                  >
                    View markets
                  </Link>
                </div>
                {unhealthyMarkets.length === 0 ? (
                  <p className="flex items-center gap-2 text-sm text-emerald-400">
                    <CheckCircle2 size={16} />
                    All markets healthy
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2 text-sm">
                    {unhealthyMarkets.map((h) => (
                      <li
                        key={h.symbol}
                        className="flex items-start gap-2 border-b border-surface-1 pb-2 last:border-0 last:pb-0"
                      >
                        <AlertTriangle
                          size={16}
                          className="mt-0.5 shrink-0 text-destructive"
                        />
                        <span className="flex flex-col">
                          <span className="font-medium text-text">
                            {h.symbol}
                            <span className="ml-2 text-xs text-subtext-0">
                              {h.consecutiveFailures} consecutive failure
                              {h.consecutiveFailures === 1 ? "" : "s"}
                            </span>
                          </span>
                          {h.lastFailureReason && (
                            <span className="text-xs text-subtext-1">
                              {h.lastFailureReason}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <DecisionMakerStatusList />
            </div>
          </>
        )}
      </main>
    </SiteHeader>
  );
}
