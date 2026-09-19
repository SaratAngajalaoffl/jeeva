"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  checkSession,
  fetchDecisions,
  fetchFundingPayments,
  fetchMockWallet,
  fetchPerps,
  fetchPositions,
  logout,
  type DecisionLogEntry,
  type FundingPayment,
  type MockWallet,
  type Perp,
  type Position,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Card, StatTile } from "@/components/ui";
import BarChart from "@/components/BarChart";
import DonutChart from "@/components/DonutChart";
import LineChart from "@/components/LineChart";

const ORDER_ACTIONS = new Set(["opened", "closed", "closed_and_opened"]);

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [wallet, setWallet] = useState<MockWallet | null | undefined>(
    undefined,
  );
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);

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
    fetchPositions().then(setPositions).catch(() => setPositions([]));
    fetchDecisions().then(setDecisions).catch(() => setDecisions([]));
    fetchMockWallet().then(setWallet).catch(() => setWallet(null));
    fetchFundingPayments()
      .then(setFundingPayments)
      .catch(() => setFundingPayments([]));
  }, [checking]);

  if (checking) {
    return null;
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  const loading = !perps || !positions || !decisions || wallet === undefined;

  const orders = decisions?.filter(
    (d) => d.positionAction && ORDER_ACTIONS.has(d.positionAction),
  ) ?? [];

  const positionSizeBySymbol = new Map(
    (perps ?? []).map((p) => [p.symbol, p.positionSizeUsd]),
  );
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

  const pnl = wallet?.allTimePnlUsd ?? 0;
  const pnlTone = pnl > 0 ? "positive" : pnl < 0 ? "negative" : "default";

  return (
    <SiteHeader onLogout={handleLogout}>
      <main className="flex flex-col gap-6 px-6 py-8 sm:px-8 lg:px-12">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Dashboard
        </h1>

        {loading ? (
          <p className="text-sm text-subtext-1">Loading overview...</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <StatTile
                label="Wallet balance"
                value={
                  wallet
                    ? `$${wallet.currentBalanceUsd.toLocaleString()}`
                    : "-"
                }
              />
              <StatTile
                label="All-time P&L"
                value={
                  wallet ? `${pnl >= 0 ? "+" : ""}$${pnl.toLocaleString()}` : "-"
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

            <div className="grid gap-4 lg:grid-cols-2">
              <BarChart title="Orders by market" bars={orderBars} />
              <Card className="flex flex-col gap-3 p-5">
                <h3 className="text-sm font-medium text-text">
                  Open positions
                </h3>
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
                          className={
                            p.direction === "long"
                              ? "text-emerald-400"
                              : "text-destructive"
                          }
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
            </div>
          </>
        )}
      </main>
    </SiteHeader>
  );
}
