"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  Coins,
  Minus,
  Radio,
  Wallet as WalletIcon,
  XCircle,
} from "lucide-react";
import {
  checkSession,
  fetchAllTradingSessions,
  fetchDecisions,
  fetchEngineMode,
  fetchFundingPayments,
  fetchMarketData,
  fetchPerpHealth,
  fetchPerps,
  fetchPerpStats,
  fetchPositions,
  fetchWallets,
  logout,
  type DecisionLogEntry,
  type EngineMode,
  type FundingPayment,
  type MarketDataPoint,
  type Perp,
  type PerpHealth,
  type PerpStats,
  type Position,
  type TradingSessionRow,
  type Wallet,
} from "@/lib/api";
import {
  formatCompactUsd,
  formatDuration,
  formatPrice,
  formatSignedPct,
  formatSignedUsd,
  formatUsd,
} from "@/lib/format";
import {
  AUTO_FLATTEN_THRESHOLD,
  bucketCounts,
  buildActivityFeed,
  buildPerformanceSeries,
  buildPositionRows,
  buildSessionRows,
  chooseGranularity,
  cumulativeFunding,
  ORDER_ACTIONS,
  summariseDecisions,
  summarisePortfolio,
  topSymbols,
  type ActivityEvent,
  type PositionRow,
  type SessionRow,
} from "@/lib/overview";
import {
  CHART,
  DIRECTION_FILL,
  DIRECTION_ORDER,
  NEUTRAL,
  seriesColor,
  STATUS,
} from "@/lib/viz";
import { SiteHeader } from "@/components/SiteHeader";
import { DecisionMakerStatusList } from "@/components/DecisionMakerStatusList";
import {
  Card,
  ChartCard,
  Select,
  Skeleton,
  StatTile,
  StatTileSkeleton,
  StatusPill,
} from "@/components/ui";
import DonutChart from "@/components/DonutChart";
import LineChart from "@/components/LineChart";
import PerformanceChart from "@/components/PerformanceChart";
import RingMeter from "@/components/RingMeter";
import SegmentedBar from "@/components/SegmentedBar";
import StackedBarChart from "@/components/StackedBarChart";
import { Countdown, TimeAgo } from "@/components/RelativeTime";

const POLL_MS = 15_000;
const HISTORY_LIMIT = 1000;

const RANGES = [
  { id: "6h", label: "Last 6 hours", ms: 6 * 60 * 60 * 1000 },
  { id: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", label: "Last 30 days", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

type RangeId = (typeof RANGES)[number]["id"];

/**
 * The performance chart draws at most three markets: with any two lines
 * able to end up neighbours, three is the number of hues that clears the
 * all-pairs colour-separation gate (see lib/viz). Markets past the third
 * are still listed in the watchlist beside it.
 */
const PERFORMANCE_SERIES_CAP = 3;
/** Stacked bars only put neighbouring slots next to each other, so four fit. */
const MARKET_STACK_CAP = 4;

const DIRECTION_LABEL = { long: "Long", flat: "Flat", short: "Short" } as const;

const ACTION_LABEL: Record<string, string> = {
  no_op: "held",
  opened: "opened",
  closed: "closed",
  closed_and_opened: "flipped",
};

interface Snapshot {
  perps: Perp[];
  stats: PerpStats[];
  positions: Position[];
  decisions: DecisionLogEntry[];
  funding: FundingPayment[];
  wallets: Wallet[];
  sessions: TradingSessionRow[];
  health: PerpHealth[];
  engineMode: EngineMode | null;
}

export default function DashboardPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [rangeId, setRangeId] = useState<RangeId>("24h");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [marketData, setMarketData] = useState<Map<string, MarketDataPoint[]>>(
    new Map(),
  );
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);

  const rangeMs = RANGES.find((r) => r.id === rangeId)!.ms;

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

  const load = useCallback(async (): Promise<Snapshot> => {
    const to = new Date();
    const from = new Date(to.getTime() - rangeMs);
    const history = { from, to, limit: HISTORY_LIMIT };

    const [
      perps,
      stats,
      positions,
      decisions,
      funding,
      wallets,
      sessions,
      health,
      engineMode,
    ] = await Promise.all([
      fetchPerps().catch(() => []),
      fetchPerpStats().catch(() => []),
      fetchPositions().catch(() => []),
      fetchDecisions(history).catch(() => []),
      fetchFundingPayments(history).catch(() => []),
      fetchWallets().catch(() => []),
      fetchAllTradingSessions().catch(() => []),
      fetchPerpHealth().catch(() => []),
      fetchEngineMode()
        .then((m) => m.mode)
        .catch(() => null),
    ]);

    return {
      perps,
      stats,
      positions,
      decisions,
      funding,
      wallets,
      sessions,
      health,
      engineMode,
    };
  }, [rangeMs]);

  // Poll on a fixed cadence and on every range change. A refresh swaps the
  // data in under the existing render — no skeleton flash, no layout jump.
  const isFirstLoad = useRef(true);
  useEffect(() => {
    if (checking) return;
    let cancelled = false;

    if (!isFirstLoad.current) setReloading(true);

    function poll() {
      load()
        .then((next) => {
          if (cancelled) return;
          setSnapshot(next);
          setUpdatedAt(new Date().toISOString());
          setReloading(false);
          isFirstLoad.current = false;
        })
        .catch(() => {
          if (!cancelled) setReloading(false);
        });
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [checking, load]);

  const sampledSymbols = useMemo(
    () =>
      (snapshot?.perps ?? [])
        .filter((p) => p.samplingEnabled)
        .map((p) => p.symbol)
        .sort((a, b) => a.localeCompare(b)),
    [snapshot?.perps],
  );
  const chartedSymbols = useMemo(
    () => sampledSymbols.slice(0, PERFORMANCE_SERIES_CAP),
    [sampledSymbols],
  );
  const chartedKey = chartedSymbols.join(",");

  // Keyed on the joined symbol list rather than the array, so a poll that
  // returns the same markets doesn't refetch every history in the chart.
  useEffect(() => {
    if (!chartedKey) return;
    let cancelled = false;

    const to = new Date();
    const from = new Date(to.getTime() - rangeMs);

    Promise.all(
      chartedKey.split(",").map((symbol) =>
        fetchMarketData(symbol, { from, to })
          .then((history) => [symbol, history.samples] as const)
          .catch(() => [symbol, [] as MarketDataPoint[]] as const),
      ),
    ).then((entries) => {
      if (!cancelled) setMarketData(new Map(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [chartedKey, rangeMs]);

  if (checking) {
    return null;
  }

  async function handleLogout() {
    await logout();
    router.push("/login");
  }

  return (
    <SiteHeader onLogout={handleLogout}>
      <main className="flex flex-col gap-6 px-6 py-8 sm:px-8 lg:px-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight text-text">
              Overview
            </h1>
            <p className="text-sm text-subtext-1">
              Everything Jeeva is holding, deciding and watching, right now.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {snapshot?.engineMode && (
              <StatusPill
                tone={snapshot.engineMode === "live" ? "critical" : "muted"}
                title={
                  snapshot.engineMode === "live"
                    ? "Real orders are placed on Hyperliquid"
                    : "Fills are simulated against mock wallets"
                }
              >
                {snapshot.engineMode === "live"
                  ? "Live execution"
                  : "Mock execution"}
              </StatusPill>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-1 px-2.5 py-1 text-xs text-subtext-0">
              <Radio size={12} className={reloading ? "text-peach" : "text-emerald-400"} />
              Updated <TimeAgo iso={updatedAt} />
            </span>
            <label className="flex items-center gap-2">
              <span className="sr-only">History window</span>
              <Select
                value={rangeId}
                onChange={(e) => setRangeId(e.target.value as RangeId)}
                className="py-1.5 text-xs"
              >
                {RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>

        {!snapshot ? (
          <OverviewSkeleton />
        ) : (
          <OverviewContent
            snapshot={snapshot}
            marketData={marketData}
            sampledSymbols={sampledSymbols}
            chartedSymbols={chartedSymbols}
            rangeLabel={RANGES.find((r) => r.id === rangeId)!.label.toLowerCase()}
          />
        )}
      </main>
    </SiteHeader>
  );
}

function OverviewContent({
  snapshot,
  marketData,
  sampledSymbols,
  chartedSymbols,
  rangeLabel,
}: {
  snapshot: Snapshot;
  marketData: Map<string, MarketDataPoint[]>;
  sampledSymbols: string[];
  chartedSymbols: string[];
  rangeLabel: string;
}) {
  const {
    perps,
    stats,
    positions,
    decisions,
    funding,
    wallets,
    sessions,
    health,
  } = snapshot;

  const marks = useMemo(
    () => new Map(stats.map((s) => [s.symbol, s.price])),
    [stats],
  );
  const statsBySymbol = useMemo(
    () => new Map(stats.map((s) => [s.symbol, s])),
    [stats],
  );

  const portfolio = useMemo(
    () => summarisePortfolio(wallets, positions, sessions, marks),
    [wallets, positions, sessions, marks],
  );
  const decisionStats = useMemo(
    () => summariseDecisions(decisions, sessions),
    [decisions, sessions],
  );
  const positionRows = useMemo(
    () => buildPositionRows(positions, sessions, marks),
    [positions, sessions, marks],
  );
  const sessionRows = useMemo(
    () => buildSessionRows(sessions, wallets, positions, decisions, marks),
    [sessions, wallets, positions, decisions, marks],
  );

  const activeSessions = sessions.filter((s) => s.status !== "closed");
  const longPositions = positions.filter((p) => p.direction === "long").length;

  // --- Market performance -------------------------------------------------
  const performance = useMemo(() => {
    const charted = new Map(
      chartedSymbols
        .map((s) => [s, marketData.get(s) ?? []] as const)
        .filter(([, samples]) => samples.length > 0),
    );
    return buildPerformanceSeries(charted);
  }, [chartedSymbols, marketData]);

  const performanceSeries = performance.symbols.map((symbol) => ({
    key: symbol,
    label: symbol,
    color: seriesColor(chartedSymbols.indexOf(symbol)),
  }));

  // --- Decision flow ------------------------------------------------------
  const decisionFlow = useMemo(() => {
    const granularity = chooseGranularity(
      decisions.map((d) => new Date(d.time).getTime()),
    );
    if (!granularity) return null;
    return bucketCounts(
      decisions,
      (d) => new Date(d.time).getTime(),
      (d) => d.targetDirection,
      granularity,
    );
  }, [decisions]);

  const directionSeries = DIRECTION_ORDER.map((direction) => ({
    key: direction,
    label: DIRECTION_LABEL[direction],
    color: DIRECTION_FILL[direction],
  }));

  // --- Order flow by market ----------------------------------------------
  const orders = useMemo(
    () =>
      decisions.filter(
        (d) => d.positionAction !== null && ORDER_ACTIONS.includes(d.positionAction),
      ),
    [decisions],
  );

  const orderFlow = useMemo(() => {
    const counts = new Map<string, number>();
    for (const o of orders) {
      counts.set(o.symbol, (counts.get(o.symbol) ?? 0) + 1);
    }
    const { symbols, hasOther } = topSymbols(counts, MARKET_STACK_CAP);
    const granularity = chooseGranularity(
      orders.map((o) => new Date(o.time).getTime()),
    );
    if (!granularity) return null;

    const series = [
      ...symbols.map((symbol, i) => ({
        key: symbol,
        label: symbol,
        color: seriesColor(i),
      })),
      ...(hasOther
        ? [{ key: "__other__", label: "Other", color: NEUTRAL }]
        : []),
    ];

    const data = bucketCounts(
      orders,
      (o) => new Date(o.time).getTime(),
      (o) => (symbols.includes(o.symbol) ? o.symbol : "__other__"),
      granularity,
    );

    return { series, data };
  }, [orders]);

  // --- Funding ------------------------------------------------------------
  const fundingCurve = useMemo(() => cumulativeFunding(funding), [funding]);
  const netFundingUsd = funding.reduce((sum, p) => sum + p.amountUsd, 0);

  const feed = useMemo(
    () => buildActivityFeed(decisions, funding, 12),
    [decisions, funding],
  );

  const unhealthy = health.filter((h) => h.consecutiveFailures > 0);

  return (
    <>
      {/* Portfolio ------------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="flex flex-col justify-between gap-5 p-6 lg:col-span-2">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-subtext-0">
                <WalletIcon size={13} />
                Portfolio equity
              </span>
              <span className="text-5xl font-semibold leading-none tracking-tight text-text">
                {portfolio.fundedWalletCount > 0
                  ? formatUsd(portfolio.equityUsd)
                  : "-"}
              </span>
              <span className="text-xs text-subtext-0">
                settled balance {formatUsd(portfolio.balanceUsd)} + open
                positions marked to market
              </span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${
                  portfolio.totalPnlUsd > 0
                    ? "bg-emerald-400/10 text-emerald-400"
                    : portfolio.totalPnlUsd < 0
                      ? "bg-destructive/10 text-destructive"
                      : "bg-surface-1 text-subtext-0"
                }`}
              >
                {portfolio.totalPnlUsd > 0 ? (
                  <ArrowUpRight size={15} />
                ) : portfolio.totalPnlUsd < 0 ? (
                  <ArrowDownRight size={15} />
                ) : (
                  <Minus size={15} />
                )}
                {formatSignedUsd(portfolio.totalPnlUsd)}
                {portfolio.roiPct !== null && ` · ${formatSignedPct(portfolio.roiPct)}`}
              </span>
              <span className="text-xs text-subtext-0">
                against {formatUsd(portfolio.initialUsd)} funded
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <MiniStat
              label="Realized"
              value={formatSignedUsd(portfolio.realizedPnlUsd)}
              tone={portfolio.realizedPnlUsd}
              hint="closed trades + funding"
            />
            <MiniStat
              label="Unrealized"
              value={formatSignedUsd(portfolio.unrealizedPnlUsd)}
              tone={portfolio.unrealizedPnlUsd}
              hint={`${positions.length} position${positions.length === 1 ? "" : "s"} open`}
            />
            <MiniStat
              label="Wallets"
              value={`${portfolio.fundedWalletCount}`}
              hint={
                portfolio.liveWalletCount > 0
                  ? `${portfolio.liveWalletCount} live wallet${portfolio.liveWalletCount === 1 ? "" : "s"}`
                  : "mock only"
              }
            />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium uppercase tracking-wide text-subtext-0">
                Capital deployment
              </span>
              <span className="text-subtext-1">
                {portfolio.deployedPct.toFixed(1)}% of balance as margin
              </span>
            </div>
            <SegmentedBar
              segments={[
                {
                  key: "deployed",
                  label: "Deployed margin",
                  value: portfolio.deployedMarginUsd,
                  color: CHART.accent,
                  display: formatUsd(portfolio.deployedMarginUsd),
                },
                {
                  key: "free",
                  label: "Free capital",
                  value: portfolio.freeCapitalUsd,
                  color: NEUTRAL,
                  display: formatUsd(portfolio.freeCapitalUsd),
                },
              ]}
              emptyLabel="No funded wallet yet — add one from the Wallet page."
            />
          </div>
        </Card>

        <ChartCard
          title="Exposure"
          subtitle="Notional currently at risk"
          action={
            <span className="text-xs text-subtext-0">
              {portfolio.leverageX.toFixed(2)}× equity
            </span>
          }
        >
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-subtext-0">
              Net
            </span>
            <span
              className={`text-3xl font-semibold tracking-tight ${
                portfolio.netExposureUsd > 0
                  ? "text-emerald-400"
                  : portfolio.netExposureUsd < 0
                    ? "text-destructive"
                    : "text-text"
              }`}
            >
              {formatSignedUsd(portfolio.netExposureUsd)}
            </span>
            <span className="text-xs text-subtext-0">
              {formatUsd(portfolio.grossExposureUsd)} gross across{" "}
              {positions.length} position{positions.length === 1 ? "" : "s"}
            </span>
          </div>

          <SegmentedBar
            segments={[
              {
                key: "long",
                label: "Long",
                value: portfolio.longExposureUsd,
                color: DIRECTION_FILL.long,
                display: formatUsd(portfolio.longExposureUsd),
              },
              {
                key: "short",
                label: "Short",
                value: portfolio.shortExposureUsd,
                color: DIRECTION_FILL.short,
                display: formatUsd(portfolio.shortExposureUsd),
              },
            ]}
            emptyLabel="Flat across every session."
          />
        </ChartCard>
      </section>

      {/* Headline counters ----------------------------------------------- */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Open positions"
          value={positions.length}
          hint={`${longPositions} long · ${positions.length - longPositions} short`}
        />
        <StatTile
          label="Active sessions"
          value={activeSessions.length}
          hint={`${new Set(activeSessions.map((s) => s.symbol)).size} markets · ${
            sessions.length - activeSessions.length
          } closed`}
        />
        <StatTile
          label="Decisions"
          value={decisionStats.total.toLocaleString()}
          hint={
            decisionStats.decisionsPerHour
              ? `≈${decisionStats.decisionsPerHour.toFixed(1)}/hour · ${rangeLabel}`
              : rangeLabel
          }
        />
        <StatTile
          label="Orders filled"
          value={decisionStats.orderCount.toLocaleString()}
          hint={`${decisionStats.actionCounts.no_op.toLocaleString()} cycles held`}
        />
        <StatTile
          label="Traded volume"
          value={formatCompactUsd(decisionStats.filledNotionalUsd)}
          hint="notional crossed"
        />
        <StatTile
          label="Markets watched"
          value={sampledSymbols.length}
          hint={`of ${perps.length} on Hyperliquid`}
        />
      </section>

      {/* Market performance ---------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Sampled market performance"
          subtitle={`Each market rebased to 100 at the start of the ${rangeLabel.replace("last ", "")}`}
          action={
            <Link
              href="/dashboard/markets"
              className="shrink-0 text-xs text-ember hover:underline"
            >
              All markets
            </Link>
          }
        >
          <PerformanceChart series={performanceSeries} rows={performance.rows} />
        </ChartCard>

        <ChartCard
          title="Watchlist"
          subtitle={
            sampledSymbols.length > PERFORMANCE_SERIES_CAP
              ? `${sampledSymbols.length} sampled · first ${PERFORMANCE_SERIES_CAP} charted`
              : "Markets Jeeva is recording"
          }
        >
          {sampledSymbols.length === 0 ? (
            <p className="text-sm text-subtext-1">
              No markets are being sampled yet.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-surface-1">
              {sampledSymbols.map((symbol, i) => {
                const s = statsBySymbol.get(symbol);
                const charted = i < PERFORMANCE_SERIES_CAP;
                return (
                  <li key={symbol} className="py-2 first:pt-0 last:pb-0">
                    <Link
                      href={`/dashboard/markets/${symbol}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <span
                        aria-hidden
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{
                          backgroundColor: charted ? seriesColor(i) : "transparent",
                          border: charted ? undefined : `1px solid ${NEUTRAL}`,
                        }}
                      />
                      <span className="font-medium text-text">{symbol}</span>
                      <span className="ml-auto tabular-nums text-subtext-1">
                        {formatPrice(s?.price ?? null)}
                      </span>
                      <span
                        className={`w-16 text-right tabular-nums ${
                          (s?.changePct ?? 0) >= 0
                            ? "text-emerald-400"
                            : "text-destructive"
                        }`}
                      >
                        {s ? formatSignedPct(s.changePct) : "-"}
                      </span>
                    </Link>
                    {s && (
                      <div className="mt-0.5 flex gap-4 pl-4 text-[11px] text-subtext-0">
                        <span>OI {formatCompactUsd(s.openInterestUsd)}</span>
                        <span>24h vol {formatCompactUsd(s.volumeUsd)}</span>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ChartCard>
      </section>

      {/* Engine activity -------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Decision flow"
          subtitle={`Target direction Jev returned each cycle · ${rangeLabel}`}
        >
          <StackedBarChart
            series={directionSeries}
            data={decisionFlow ?? []}
            emptyLabel="No decisions in this window."
          />
        </ChartCard>

        <ChartCard
          title="Direction split"
          subtitle="Where the engine wanted to be"
        >
          <div className="flex flex-1 flex-col justify-center">
            <DonutChart
              totalLabel="decisions"
              slices={DIRECTION_ORDER.map((direction) => ({
                label: DIRECTION_LABEL[direction],
                value: decisionStats.directionCounts[direction],
                color: DIRECTION_FILL[direction],
              }))}
              emptyLabel="No decisions in this window."
            />
          </div>
        </ChartCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Order flow by market"
          subtitle={`Cycles that moved a position · ${rangeLabel}`}
        >
          <StackedBarChart
            series={orderFlow?.series ?? []}
            data={orderFlow?.data ?? []}
            emptyLabel="No orders in this window."
          />
        </ChartCard>

        <ChartCard title="Engine vitals" subtitle={`Across ${decisionStats.total} cycles`}>
          <div className="flex items-start justify-around gap-2">
            <RingMeter
              label="Cycle success"
              value={decisionStats.successRatePct}
              color={
                decisionStats.failures === 0 ? STATUS.good : STATUS.critical
              }
              caption={
                decisionStats.failures === 0
                  ? "clean"
                  : `${decisionStats.failures} failed`
              }
              size={92}
            />
            <RingMeter
              label="Action rate"
              value={
                decisionStats.total > 0
                  ? (decisionStats.orderCount / decisionStats.total) * 100
                  : null
              }
              color={CHART.accent}
              caption="traded"
              size={92}
            />
            <RingMeter
              label="Avg confidence"
              value={
                decisionStats.avgConfidence === null
                  ? null
                  : decisionStats.avgConfidence * 100
              }
              color={STATUS.warning}
              caption="of 1.00"
              size={92}
            />
          </div>

          <ul className="flex flex-col gap-1.5 border-t border-surface-1 pt-3 text-xs">
            {(["opened", "closed", "closed_and_opened", "no_op"] as const).map(
              (action) => (
                <li key={action} className="flex items-center justify-between">
                  <span className="text-subtext-0">
                    {action === "closed_and_opened"
                      ? "Flipped side"
                      : action === "no_op"
                        ? "Held position"
                        : action === "opened"
                          ? "Opened"
                          : "Closed"}
                  </span>
                  <span className="font-medium tabular-nums text-text">
                    {decisionStats.actionCounts[action].toLocaleString()}
                  </span>
                </li>
              ),
            )}
          </ul>
        </ChartCard>
      </section>

      {/* Positions --------------------------------------------------------- */}
      <ChartCard
        title="Open positions"
        subtitle="Marked against the live Hyperliquid price"
        action={
          <Link
            href="/dashboard/decisions"
            className="shrink-0 text-xs text-ember hover:underline"
          >
            All positions
          </Link>
        }
      >
        {positionRows.length === 0 ? (
          <p className="text-sm text-subtext-1">
            Flat everywhere — no session is holding a position right now.
          </p>
        ) : (
          <PositionsTable rows={positionRows} />
        )}
      </ChartCard>

      {/* Sessions ---------------------------------------------------------- */}
      <ChartCard
        title="Trading sessions"
        subtitle="One independent decision loop per row"
        action={
          <Link
            href="/dashboard/markets"
            className="shrink-0 text-xs text-ember hover:underline"
          >
            Manage
          </Link>
        }
      >
        {sessionRows.length === 0 ? (
          <p className="text-sm text-subtext-1">
            No trading sessions yet — start one from a market&apos;s page.
          </p>
        ) : (
          <SessionsTable rows={sessionRows} />
        )}
      </ChartCard>

      {/* Ops --------------------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <ChartCard
          title="Engine health"
          subtitle={`Auto-flatten fires at ${AUTO_FLATTEN_THRESHOLD} consecutive failures`}
        >
          {health.length === 0 ? (
            <p className="text-sm text-subtext-1">No health reports yet.</p>
          ) : unhealthy.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 size={16} />
              All {health.length} market{health.length === 1 ? "" : "s"} healthy
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {unhealthy.map((h) => (
                <li key={h.symbol} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <AlertTriangle
                      size={14}
                      className={
                        h.consecutiveFailures >= AUTO_FLATTEN_THRESHOLD
                          ? "text-destructive"
                          : "text-peach"
                      }
                    />
                    <span className="font-medium text-text">{h.symbol}</span>
                    <span className="ml-auto text-xs text-subtext-1">
                      {h.consecutiveFailures}/{AUTO_FLATTEN_THRESHOLD} failures
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-1">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, (h.consecutiveFailures / AUTO_FLATTEN_THRESHOLD) * 100)}%`,
                        backgroundColor:
                          h.consecutiveFailures >= AUTO_FLATTEN_THRESHOLD
                            ? STATUS.critical
                            : STATUS.warning,
                      }}
                    />
                  </div>
                  {h.lastFailureReason && (
                    <p className="text-xs text-subtext-0">{h.lastFailureReason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </ChartCard>

        <DecisionMakerStatusList />

        <ChartCard
          title="Funding flow"
          subtitle="Settled into the wallet balance as it accrues"
          action={
            <span
              className={`shrink-0 text-xs font-medium ${
                netFundingUsd >= 0 ? "text-emerald-400" : "text-destructive"
              }`}
            >
              {formatSignedUsd(netFundingUsd, 4)}
            </span>
          }
        >
          <LineChart
            label="Cumulative funding"
            unit="USD"
            points={fundingCurve}
            color={netFundingUsd >= 0 ? STATUS.good : STATUS.critical}
            zeroLine
            height={150}
            emptyLabel="No funding payments in this window."
          />
        </ChartCard>
      </section>

      {/* Activity ---------------------------------------------------------- */}
      <ChartCard
        title="Live activity"
        subtitle="Decision cycles and funding settlements, newest first"
        action={
          <Link
            href="/dashboard/decisions"
            className="shrink-0 text-xs text-ember hover:underline"
          >
            Full log
          </Link>
        }
      >
        {feed.length === 0 ? (
          <p className="text-sm text-subtext-1">Nothing has happened yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-surface-1">
            {feed.map((event, i) => (
              <ActivityRow key={i} event={event} />
            ))}
          </ul>
        )}
      </ChartCard>
    </>
  );
}

function MiniStat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: number;
}) {
  const toneClass =
    tone === undefined || tone === 0
      ? "text-text"
      : tone > 0
        ? "text-emerald-400"
        : "text-destructive";
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-surface-1 bg-mantle/40 px-3 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-subtext-0">
        {label}
      </span>
      <span className={`text-lg font-semibold tracking-tight ${toneClass}`}>
        {value}
      </span>
      {hint && <span className="text-[11px] text-subtext-0">{hint}</span>}
    </div>
  );
}

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2.5 pr-4 last:pr-0";

function DirectionBadge({ direction }: { direction: "long" | "short" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        direction === "long"
          ? "bg-emerald-400/15 text-emerald-400"
          : "bg-destructive/15 text-destructive"
      }`}
    >
      {direction === "long" ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {direction}
    </span>
  );
}

function PositionsTable({ rows }: { rows: PositionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm text-text">
        <thead>
          <tr>
            <th className={TH}>Market</th>
            <th className={TH}>Side</th>
            <th className={TH}>Notional</th>
            <th className={TH}>Entry</th>
            <th className={TH}>Mark</th>
            <th className={TH}>Unrealized</th>
            <th className={TH}>Held</th>
            <th className={TH}>Session</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { position, session, markPrice, unrealizedPnlUsd, pnlPct } = row;
            const tone =
              unrealizedPnlUsd === null || unrealizedPnlUsd === 0
                ? "text-subtext-1"
                : unrealizedPnlUsd > 0
                  ? "text-emerald-400"
                  : "text-destructive";
            return (
              <tr key={position.sessionId} className="hover:bg-surface-0/60">
                <td className={`${TD} font-medium`}>{position.symbol}</td>
                <td className={TD}>
                  <DirectionBadge direction={position.direction} />
                </td>
                <td className={`${TD} tabular-nums`}>
                  {formatUsd(position.notionalUsd)}
                  {session && (
                    <span className="ml-1 text-xs text-subtext-0">
                      {session.leverage}×
                    </span>
                  )}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {formatPrice(position.entryPrice)}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {formatPrice(markPrice)}
                </td>
                <td className={`${TD} tabular-nums ${tone}`}>
                  {unrealizedPnlUsd === null
                    ? "-"
                    : `${formatSignedUsd(unrealizedPnlUsd)} · ${formatSignedPct(pnlPct ?? 0)}`}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {formatDuration(Date.now() - new Date(position.openedAt).getTime())}
                </td>
                <td className={TD}>
                  <Link
                    href={`/dashboard/markets/${position.symbol}/sessions/${position.sessionId}`}
                    className="font-mono text-xs text-ember hover:underline"
                  >
                    {position.sessionId.slice(0, 8)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const SESSION_STATUS_TONE = {
  active: "good",
  soft_closing: "warning",
  hard_closing: "critical",
  closed: "muted",
} as const;

const SESSION_STATUS_LABEL = {
  active: "Active",
  soft_closing: "Soft closing",
  hard_closing: "Hard closing",
  closed: "Closed",
} as const;

const DECISION_MAKER_LABEL = {
  random: "Random",
  typesafe: "TypeSafe Jev",
  openrouter: "OpenRouter Jev",
} as const;

function SessionsTable({ rows }: { rows: SessionRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] border-collapse text-left text-sm text-text">
        <thead>
          <tr>
            <th className={TH}>Session</th>
            <th className={TH}>Status</th>
            <th className={TH}>Decision maker</th>
            <th className={TH}>Cadence</th>
            <th className={TH}>Sizing</th>
            <th className={TH}>Wallet</th>
            <th className={TH}>Realized</th>
            <th className={TH}>Position</th>
            <th className={TH}>Next tick</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const { session, wallet, realizedPnlUsd, position } = row;
            const tone =
              realizedPnlUsd === null || realizedPnlUsd === 0
                ? "text-subtext-1"
                : realizedPnlUsd > 0
                  ? "text-emerald-400"
                  : "text-destructive";
            return (
              <tr key={session.id} className="hover:bg-surface-0/60">
                <td className={TD}>
                  <Link
                    href={`/dashboard/markets/${session.symbol}/sessions/${session.id}`}
                    className="flex flex-col"
                  >
                    <span className="font-medium text-text hover:text-ember">
                      {session.symbol}
                    </span>
                    <span className="font-mono text-[11px] text-subtext-0">
                      {session.id.slice(0, 8)}
                    </span>
                  </Link>
                </td>
                <td className={TD}>
                  <StatusPill tone={SESSION_STATUS_TONE[session.status]}>
                    {SESSION_STATUS_LABEL[session.status]}
                  </StatusPill>
                </td>
                <td className={`${TD} text-subtext-1`}>
                  {DECISION_MAKER_LABEL[session.decisionMaker]}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {formatDuration(session.decisionFrequencySeconds * 1000)}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {formatUsd(session.positionSizeUsd, 0)} · {session.leverage}×
                </td>
                <td className={`${TD} text-subtext-1`}>
                  {wallet ? wallet.label : <span className="text-subtext-0">none</span>}
                </td>
                <td className={`${TD} tabular-nums ${tone}`}>
                  {realizedPnlUsd === null ? "-" : formatSignedUsd(realizedPnlUsd)}
                </td>
                <td className={TD}>
                  {position ? (
                    <DirectionBadge direction={position.direction} />
                  ) : (
                    <span className="text-xs uppercase tracking-wide text-subtext-0">
                      flat
                    </span>
                  )}
                </td>
                <td className={`${TD} tabular-nums text-subtext-1`}>
                  {session.status === "closed" ? (
                    "-"
                  ) : (
                    <Countdown iso={row.nextDecisionAt} />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  if (event.kind === "funding") {
    const { payment } = event;
    return (
      <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0 text-sm">
        <Coins size={15} className="shrink-0 text-peach" />
        <span className="font-medium text-text">{payment.symbol}</span>
        <span className="text-subtext-1">
          funding on a {payment.direction} position at{" "}
          {(payment.fundingRate * 100).toFixed(4)}%
        </span>
        <span
          className={`ml-auto shrink-0 tabular-nums ${
            payment.amountUsd >= 0 ? "text-emerald-400" : "text-destructive"
          }`}
        >
          {formatSignedUsd(payment.amountUsd, 4)}
        </span>
        <TimeAgo iso={payment.time} className="w-20 shrink-0 text-right text-xs text-subtext-0" />
      </li>
    );
  }

  const { decision } = event;
  const direction = decision.targetDirection;
  const Icon = !decision.success
    ? XCircle
    : direction === "long"
      ? ArrowUpRight
      : direction === "short"
        ? ArrowDownRight
        : direction === "flat"
          ? Minus
          : Activity;
  const iconClass = !decision.success
    ? "text-destructive"
    : direction === "long"
      ? "text-emerald-400"
      : direction === "short"
        ? "text-destructive"
        : "text-subtext-0";

  return (
    <li className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0">
      <Icon size={15} className={`shrink-0 ${iconClass}`} />
      <span className="font-medium text-text">{decision.symbol}</span>
      {decision.success ? (
        <span className="truncate text-subtext-1">
          target <span className="text-text">{direction ?? "-"}</span>
          {decision.positionAction &&
            ` — ${ACTION_LABEL[decision.positionAction] ?? decision.positionAction}`}
          {decision.confidence !== null &&
            ` · confidence ${decision.confidence.toFixed(2)}`}
        </span>
      ) : (
        <span className="truncate text-destructive">
          cycle failed: {decision.error ?? "unknown error"}
        </span>
      )}
      <TimeAgo iso={decision.time} className="ml-auto w-20 shrink-0 text-right text-xs text-subtext-0" />
    </li>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <Skeleton className="h-44 w-full" />
        </Card>
        <Card>
          <Skeleton className="h-44 w-full" />
        </Card>
      </div>
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
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <Skeleton className="h-44 w-full" />
          </Card>
        ))}
      </div>
    </>
  );
}
