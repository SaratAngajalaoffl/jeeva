"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fetchMarketData,
  fetchPerpHealth,
  fetchPerps,
  fetchPerpStats,
  fetchPositions,
  fetchSelectableWallets,
  updatePerpConfig,
  type DecisionMaker,
  type Perp,
  type PerpHealth,
  type PerpStats,
  type Position,
  type Wallet,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import {
  Button,
  Card,
  IconButton,
  Input,
  Label,
  Select,
  StatTile,
} from "@/components/ui";
import Modal from "@/components/Modal";
import Sparkline from "@/components/Sparkline";
import { SamplingIcon, TradingIcon, ViewIcon } from "@/components/icons";

type MarketRow = Perp & {
  price: number | null;
  changePct: number | null;
  volumeUsd: number | null;
  openInterestUsd: number | null;
};

type SortKey =
  | "symbol"
  | "price"
  | "changePct"
  | "volumeUsd"
  | "openInterestUsd";

type StatusFilter = "all" | "trading" | "sampling" | "inactive";

type ConfigDialog =
  | { type: "sampling"; perp: Perp }
  | { type: "trading"; perp: Perp };

const TD = "border-b border-surface-1 py-2 pr-4";
const PAGE_SIZE = 10;
// Mirrors the engine's AUTO_FLATTEN_THRESHOLD (#12) so the dashboard
// warns the operator before the auto-flatten safety net kicks in.
const AUTO_FLATTEN_THRESHOLD = 5;

const DECISION_MAKER_LABELS: Record<DecisionMaker, string> = {
  fake: "Fake",
  typesafe: "TypeSafe Jev",
  openrouter: "OpenRouter Jev",
};

const SORT_COLUMNS: { key: SortKey; label: string }[] = [
  { key: "symbol", label: "Symbol" },
  { key: "price", label: "Price" },
  { key: "changePct", label: "24h change" },
  { key: "volumeUsd", label: "24h volume" },
  { key: "openInterestUsd", label: "Open interest" },
];

function formatPrice(price: number | null): string {
  if (price === null) return "-";
  return `$${price.toLocaleString(undefined, {
    maximumFractionDigits: price < 1 ? 6 : 2,
  })}`;
}

function formatVolume(volume: number | null): string {
  if (volume === null) return "-";
  if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(2)}B`;
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `$${(volume / 1_000).toFixed(2)}K`;
  return `$${volume.toFixed(2)}`;
}

export default function MarketsPage() {
  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [stats, setStats] = useState<PerpStats[] | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [health, setHealth] = useState<PerpHealth[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("volumeUsd");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<ConfigDialog | null>(null);

  useEffect(() => {
    fetchPerps()
      .then(setPerps)
      .catch(() => setError("Failed to load markets"));
    fetchPerpStats()
      .then(setStats)
      .catch(() => setStats([]));
    fetchPositions()
      .then(setPositions)
      .catch(() => setPositions([]));
    fetchPerpHealth()
      .then(setHealth)
      .catch(() => setHealth([]));
  }, []);

  async function applyPatch(
    symbol: string,
    patch: Partial<Omit<Perp, "symbol">>,
  ) {
    // Optimistic UI update; corrected by the server response, which also
    // enforces the trading/sampling dependency rule and value limits.
    setPerps(
      (prev) =>
        prev?.map((p) => (p.symbol === symbol ? { ...p, ...patch } : p)) ??
        prev,
    );

    try {
      const updated = await updatePerpConfig(symbol, patch);
      setPerps(
        (prev) => prev?.map((p) => (p.symbol === symbol ? updated : p)) ?? prev,
      );
    } catch {
      setError("Failed to update market");
    }
  }

  function handleSort(key: SortKey) {
    setPage(1);
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function handleSamplingClick(perp: Perp) {
    if (perp.samplingEnabled) {
      applyPatch(perp.symbol, { samplingEnabled: false });
    } else {
      setDialog({ type: "sampling", perp });
    }
  }

  function handleTradingClick(perp: Perp) {
    if (perp.tradingEnabled) {
      applyPatch(perp.symbol, { tradingEnabled: false });
    } else {
      setDialog({ type: "trading", perp });
    }
  }

  const rows: MarketRow[] = useMemo(() => {
    if (!perps) return [];
    const statsBySymbol = new Map((stats ?? []).map((s) => [s.symbol, s]));
    return perps.map((p) => {
      const s = statsBySymbol.get(p.symbol);
      return {
        ...p,
        price: s?.price ?? null,
        changePct: s?.changePct ?? null,
        volumeUsd: s?.volumeUsd ?? null,
        openInterestUsd: s?.openInterestUsd ?? null,
      };
    });
  }, [perps, stats]);

  const filteredSorted = useMemo(() => {
    let result = rows;

    const query = search.trim().toUpperCase();
    if (query) {
      result = result.filter((p) => p.symbol.toUpperCase().includes(query));
    }

    if (statusFilter === "trading") {
      result = result.filter((p) => p.tradingEnabled);
    } else if (statusFilter === "sampling") {
      result = result.filter((p) => p.samplingEnabled);
    } else if (statusFilter === "inactive") {
      result = result.filter((p) => !p.tradingEnabled && !p.samplingEnabled);
    }

    const dir = sortDir === "asc" ? 1 : -1;
    result = [...result].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * dir;
      }
      return (Number(av) - Number(bv)) * dir;
    });

    return result;
  }, [rows, search, statusFilter, sortKey, sortDir]);

  const samplingMarkets = useMemo(
    () => rows.filter((p) => p.samplingEnabled),
    [rows],
  );
  const tradingMarkets = useMemo(
    () => rows.filter((p) => p.tradingEnabled),
    [rows],
  );
  const positionsBySymbol = useMemo(
    () => new Map(positions.map((p) => [p.symbol, p])),
    [positions],
  );
  const healthBySymbol = useMemo(
    () => new Map(health.map((h) => [h.symbol, h])),
    [health],
  );

  const pageCount = Math.max(1, Math.ceil(filteredSorted.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const paged = filteredSorted.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  return (
    <SiteHeader>
      <main className="flex flex-col gap-4 px-6 py-8 sm:px-8 lg:px-12">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Markets
        </h1>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {perps && (
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile label="Total markets" value={perps.length} />
            <StatTile
              label="Markets trading"
              value={perps.filter((p) => p.tradingEnabled).length}
            />
            <StatTile
              label="Markets syncing"
              value={perps.filter((p) => p.samplingEnabled).length}
            />
          </div>
        )}

        {perps && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-text">
                Sampling markets
              </h2>
              <span className="text-sm text-subtext-0">
                {samplingMarkets.length}
              </span>
            </div>
            {samplingMarkets.length === 0 ? (
              <Card className="p-5">
                <p className="text-sm text-subtext-1">No markets yet.</p>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {samplingMarkets.map((m) => (
                  <SamplingMarketCard key={m.symbol} market={m} />
                ))}
              </div>
            )}
          </div>
        )}

        {perps && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-text">
                Trading markets
              </h2>
              <span className="text-sm text-subtext-0">
                {tradingMarkets.length}
              </span>
            </div>
            {tradingMarkets.length === 0 ? (
              <Card className="p-5">
                <p className="text-sm text-subtext-1">No markets yet.</p>
              </Card>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {tradingMarkets.map((m) => (
                  <TradingMarketCard
                    key={m.symbol}
                    market={m}
                    position={positionsBySymbol.get(m.symbol) ?? null}
                    health={healthBySymbol.get(m.symbol) ?? null}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {!perps ? (
          <p className="text-sm text-subtext-1">Loading markets...</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold tracking-tight text-text">
                Market List
              </h2>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  type="search"
                  placeholder="Search symbol..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  className="w-48"
                />
                <Select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as StatusFilter);
                    setPage(1);
                  }}
                  className="w-44"
                >
                  <option value="all">All markets</option>
                  <option value="trading">Trading enabled</option>
                  <option value="sampling">Sampling enabled</option>
                  <option value="inactive">Inactive</option>
                </Select>
                <span className="text-sm text-subtext-0">
                  {filteredSorted.length} of {perps.length} markets
                </span>
              </div>
            </div>

            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[720px] border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    {SORT_COLUMNS.map((col) => (
                      <th
                        key={col.key}
                        className="cursor-pointer select-none border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0 hover:text-text"
                        onClick={() => handleSort(col.key)}
                      >
                        {col.label}
                        {sortKey === col.key && (
                          <span className="ml-1 text-peach">
                            {sortDir === "asc" ? "↑" : "↓"}
                          </span>
                        )}
                      </th>
                    ))}
                    <th className="border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {paged.length === 0 ? (
                    <tr>
                      <td
                        colSpan={SORT_COLUMNS.length + 1}
                        className="py-6 text-center text-sm text-subtext-1"
                      >
                        No markets match your filters.
                      </td>
                    </tr>
                  ) : (
                    paged.map((perp) => (
                      <tr key={perp.symbol} className="hover:bg-surface-0/60">
                        <td className={`${TD} font-medium`}>{perp.symbol}</td>
                        <td className={TD}>{formatPrice(perp.price)}</td>
                        <td className={TD}>
                          {perp.changePct === null ? (
                            "-"
                          ) : (
                            <span
                              className={
                                perp.changePct >= 0
                                  ? "text-emerald-400"
                                  : "text-destructive"
                              }
                            >
                              {perp.changePct >= 0 ? "+" : ""}
                              {perp.changePct.toFixed(2)}%
                            </span>
                          )}
                        </td>
                        <td className={TD}>{formatVolume(perp.volumeUsd)}</td>
                        <td className={TD}>{formatVolume(perp.openInterestUsd)}</td>
                        <td className={TD}>
                          <div className="flex items-center gap-2">
                            <IconButton
                              active={perp.samplingEnabled}
                              aria-label={`${perp.symbol} ${
                                perp.samplingEnabled
                                  ? "disable sampling"
                                  : "enable sampling"
                              }`}
                              title={
                                perp.samplingEnabled
                                  ? "Disable sampling"
                                  : "Enable sampling"
                              }
                              onClick={() => handleSamplingClick(perp)}
                            >
                              <SamplingIcon className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              active={perp.tradingEnabled}
                              aria-label={`${perp.symbol} ${
                                perp.tradingEnabled
                                  ? "disable trading"
                                  : "enable trading"
                              }`}
                              title={
                                perp.tradingEnabled
                                  ? "Disable trading"
                                  : "Enable trading"
                              }
                              onClick={() => handleTradingClick(perp)}
                            >
                              <TradingIcon className="h-4 w-4" />
                            </IconButton>
                            <Link
                              href={`/dashboard/markets/${perp.symbol}`}
                              aria-label={`View ${perp.symbol} market`}
                              title="View market"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-surface-1 text-subtext-1 transition-colors hover:border-ember/40 hover:text-text"
                            >
                              <ViewIcon className="h-4 w-4" />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </Card>

            {pageCount > 1 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-subtext-0">
                  Page {currentPage} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    disabled={currentPage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={currentPage >= pageCount}
                    onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {dialog?.type === "sampling" && (
          <Modal
            title={`Enable sampling — ${dialog.perp.symbol}`}
            onClose={() => setDialog(null)}
          >
            <SamplingForm
              perp={dialog.perp}
              onCancel={() => setDialog(null)}
              onSubmit={async (values) => {
                await applyPatch(dialog.perp.symbol, {
                  samplingEnabled: true,
                  ...values,
                });
                setDialog(null);
              }}
            />
          </Modal>
        )}

        {dialog?.type === "trading" && (
          <Modal
            title={`Enable trading — ${dialog.perp.symbol}`}
            onClose={() => setDialog(null)}
          >
            <TradingForm
              perp={dialog.perp}
              onCancel={() => setDialog(null)}
              onSubmit={async (values) => {
                await applyPatch(dialog.perp.symbol, {
                  tradingEnabled: true,
                  ...values,
                });
                setDialog(null);
              }}
            />
          </Modal>
        )}
      </main>
    </SiteHeader>
  );
}

function useSparklinePrices(symbol: string): number[] {
  const [prices, setPrices] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchMarketData(symbol)
      .then((samples) => {
        if (!cancelled) setPrices(samples.map((s) => s.price));
      })
      .catch(() => {
        if (!cancelled) setPrices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return prices;
}

function MarketCardHeader({ market }: { market: MarketRow }) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-medium text-text">{market.symbol}</span>
      {market.changePct !== null && (
        <span
          className={`text-sm ${
            market.changePct >= 0 ? "text-emerald-400" : "text-destructive"
          }`}
        >
          {market.changePct >= 0 ? "+" : ""}
          {market.changePct.toFixed(2)}%
        </span>
      )}
    </div>
  );
}

function CardStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-subtext-0">
        {label}
      </span>
      <span className="text-sm font-medium text-text">{value}</span>
    </div>
  );
}

function SamplingMarketCard({ market }: { market: MarketRow }) {
  const prices = useSparklinePrices(market.symbol);
  const color = (market.changePct ?? 0) >= 0 ? "#4ade80" : "#ff6b6b";

  return (
    <Link href={`/dashboard/markets/${market.symbol}`} className="block">
      <Card className="flex flex-col gap-3 p-4 transition-colors hover:border-ember/50">
        <MarketCardHeader market={market} />
        <Sparkline points={prices} color={color} />
        <div className="grid grid-cols-3 gap-2">
          <CardStat label="Open interest" value={formatVolume(market.openInterestUsd)} />
          <CardStat label="24h volume" value={formatVolume(market.volumeUsd)} />
          <CardStat
            label="Sampling freq"
            value={`${market.samplingFrequencySeconds}s`}
          />
        </div>
      </Card>
    </Link>
  );
}

function HealthBadge({ health }: { health: PerpHealth | null }) {
  const count = health?.consecutiveFailures ?? 0;
  if (count === 0) {
    return <span className="text-sm font-medium text-emerald-400">Healthy</span>;
  }
  const critical = count >= AUTO_FLATTEN_THRESHOLD;
  return (
    <span
      className={`text-sm font-medium ${critical ? "text-destructive" : "text-amber-400"}`}
      title={health?.lastFailureReason ?? undefined}
    >
      {count} failure{count === 1 ? "" : "s"}
    </span>
  );
}

function TradingMarketCard({
  market,
  position,
  health,
}: {
  market: MarketRow;
  position: Position | null;
  health: PerpHealth | null;
}) {
  const prices = useSparklinePrices(market.symbol);
  const color = (market.changePct ?? 0) >= 0 ? "#4ade80" : "#ff6b6b";

  const pnl =
    position && market.price !== null
      ? ((market.price - position.entryPrice) / position.entryPrice) *
        position.notionalUsd *
        (position.direction === "long" ? 1 : -1)
      : null;

  return (
    <Link href={`/dashboard/markets/${market.symbol}`} className="block">
      <Card className="flex flex-col gap-3 p-4 transition-colors hover:border-ember/50">
        <MarketCardHeader market={market} />
        <Sparkline points={prices} color={color} />
        <div className="grid grid-cols-2 gap-2">
          <CardStat
            label="Position"
            value={position ? position.direction : "flat"}
          />
          <CardStat
            label="Unrealized P&L"
            value={pnl === null ? "-" : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
          />
          <CardStat
            label="Position size"
            value={`$${market.positionSizeUsd.toLocaleString()}`}
          />
          <CardStat label="Leverage" value={`${market.leverage}x`} />
          <CardStat
            label="Decision maker"
            value={DECISION_MAKER_LABELS[market.decisionMaker]}
          />
        </div>
        <div className="flex items-center justify-between border-t border-surface-1 pt-2">
          <span className="text-[11px] uppercase tracking-wide text-subtext-0">
            Health
          </span>
          <HealthBadge health={health} />
        </div>
      </Card>
    </Link>
  );
}

function SamplingForm({
  perp,
  onSubmit,
  onCancel,
}: {
  perp: Perp;
  onSubmit: (values: { samplingFrequencySeconds: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [samplingFrequencySeconds, setSamplingFrequencySeconds] = useState(
    String(perp.samplingFrequencySeconds),
  );
  const [submitting, setSubmitting] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const value = Number(samplingFrequencySeconds);
        if (!Number.isFinite(value) || value <= 0) return;
        setSubmitting(true);
        await onSubmit({ samplingFrequencySeconds: value });
        setSubmitting(false);
      }}
    >
      <label className="flex flex-col gap-1">
        <Label>Sampling frequency (seconds)</Label>
        <Input
          type="number"
          min={1}
          value={samplingFrequencySeconds}
          onChange={(e) => setSamplingFrequencySeconds(e.target.value)}
        />
      </label>
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Enabling..." : "Enable sampling"}
        </Button>
      </div>
    </form>
  );
}

function TradingForm({
  perp,
  onSubmit,
  onCancel,
}: {
  perp: Perp;
  onSubmit: (values: {
    decisionFrequencySeconds: number;
    leverage: number;
    positionSizeUsd: number;
    decisionMaker: DecisionMaker;
    walletId: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [decisionFrequencySeconds, setDecisionFrequencySeconds] = useState(
    String(perp.decisionFrequencySeconds),
  );
  const [leverage, setLeverage] = useState(String(perp.leverage));
  const [positionSizeUsd, setPositionSizeUsd] = useState(
    String(perp.positionSizeUsd),
  );
  const [decisionMaker, setDecisionMaker] = useState<DecisionMaker>(
    perp.decisionMaker ?? "fake",
  );
  const [walletId, setWalletId] = useState(perp.walletId ?? "");
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const size = Number(positionSizeUsd);
    if (!Number.isFinite(size) || size <= 0) {
      setWallets([]);
      return;
    }
    let cancelled = false;
    fetchSelectableWallets(perp.symbol, size)
      .then((w) => {
        if (!cancelled) setWallets(w);
      })
      .catch(() => {
        if (!cancelled) setWallets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [perp.symbol, positionSizeUsd]);

  useEffect(() => {
    if (wallets && !wallets.some((w) => w.id === walletId)) {
      setWalletId(wallets[0]?.id ?? "");
    }
  }, [wallets, walletId]);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const decision = Number(decisionFrequencySeconds);
        const lev = Number(leverage);
        const size = Number(positionSizeUsd);
        if (
          !Number.isFinite(decision) ||
          decision <= 0 ||
          !Number.isFinite(lev) ||
          lev <= 0 ||
          !Number.isFinite(size) ||
          size <= 0 ||
          !walletId
        ) {
          return;
        }
        setSubmitting(true);
        await onSubmit({
          decisionFrequencySeconds: decision,
          leverage: lev,
          positionSizeUsd: size,
          decisionMaker,
          walletId,
        });
        setSubmitting(false);
      }}
    >
      <p className="text-xs text-subtext-0">
        Enabling trading also enables sampling for this market.
      </p>
      <label className="flex flex-col gap-1">
        <Label>Decision maker</Label>
        <Select
          value={decisionMaker}
          onChange={(e) => setDecisionMaker(e.target.value as DecisionMaker)}
        >
          <option value="fake">Fake (synthetic decisions)</option>
          <option value="typesafe">TypeSafe Jev</option>
          <option value="openrouter">
            OpenRouter Jev (not yet implemented)
          </option>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <Label>Decision frequency (seconds)</Label>
        <Input
          type="number"
          min={1}
          value={decisionFrequencySeconds}
          onChange={(e) => setDecisionFrequencySeconds(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <Label>Leverage</Label>
        <Input
          type="number"
          min={1}
          value={leverage}
          onChange={(e) => setLeverage(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <Label>Position size (USD)</Label>
        <Input
          type="number"
          min={1}
          value={positionSizeUsd}
          onChange={(e) => setPositionSizeUsd(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <Label>Wallet</Label>
        <Select
          value={walletId}
          onChange={(e) => setWalletId(e.target.value)}
        >
          <option value="" disabled>
            {wallets === null
              ? "Loading..."
              : wallets.length === 0
                ? "No eligible wallets"
                : "Select a wallet"}
          </option>
          {wallets?.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label} ({w.kind}
              {w.currentBalanceUsd !== null
                ? `, $${w.currentBalanceUsd.toLocaleString()}`
                : ""}
              )
            </option>
          ))}
        </Select>
      </label>
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !walletId}>
          {submitting ? "Enabling..." : "Enable trading"}
        </Button>
      </div>
    </form>
  );
}
