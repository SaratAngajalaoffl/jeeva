"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import PriceVolumeChart, {
  chartRangeMs,
  type ChartRange,
  type TradeMarker,
} from "@/components/PriceVolumeChart";
import Modal from "@/components/Modal";
import { SamplingIcon } from "@/components/icons";
import {
  attachSessionWallet,
  createBacktest,
  createTradingSession,
  fetchDecisions,
  fetchFundingPayments,
  fetchMarketData,
  fetchOrderBook,
  fetchPerps,
  fetchPerpStats,
  fetchPositions,
  fetchRecentTrades,
  fetchSelectableWallets,
  fetchTradeHistory,
  fetchTradingSessions,
  hardCloseTradingSession,
  softCloseTradingSession,
  updatePerpConfig,
  type ClosedTrade,
  type DecisionLogEntry,
  type DecisionMaker,
  type HistoryFormat,
  type FundingPayment,
  type MarketDataPoint,
  type OrderBook,
  type Perp,
  type PerpStats,
  type Position,
  type Trade,
  type TradingSession,
  type Wallet,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Button, Card, IconButton, Input, Label, Select, Skeleton } from "@/components/ui";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "-";
  return `$${price.toLocaleString(undefined, {
    maximumFractionDigits: price < 1 ? 6 : 2,
  })}`;
}

function formatVolume(volume: number | null | undefined): string {
  if (volume === null || volume === undefined) return "-";
  if (volume >= 1_000_000_000) return `$${(volume / 1_000_000_000).toFixed(2)}B`;
  if (volume >= 1_000_000) return `$${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `$${(volume / 1_000).toFixed(2)}K`;
  return `$${volume.toFixed(2)}`;
}

function HeaderStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-subtext-0">
        {label}
      </span>
      <span className="text-sm font-medium text-text">{value}</span>
    </div>
  );
}

function StatusBadge({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        active
          ? "border-peach/50 bg-peach/10 text-peach"
          : "border-surface-1 text-subtext-0"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          active ? "bg-peach" : "bg-overlay-0"
        }`}
      />
      {label}: {active ? "On" : "Off"}
    </span>
  );
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

type ConfigDialog = "sampling" | "new-session" | null;
type DetailTab = "position" | "decisions" | "funding" | "sessions";
type BookTab = "book" | "trades";

const POLL_MS = 10_000;
const TRADES_LIMIT = 40;

export default function MarketDataPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = params.symbol;

  const [samples, setSamples] = useState<MarketDataPoint[] | null>(null);
  const [range, setRange] = useState<ChartRange>("1d");
  const [oldestSampleTime, setOldestSampleTime] = useState<
    string | null | undefined
  >(undefined);
  const [perp, setPerp] = useState<Perp | null>(null);
  const [stats, setStats] = useState<PerpStats | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [closedTrades, setClosedTrades] = useState<ClosedTrade[] | null>(null);
  const [decisions, setDecisions] = useState<DecisionLogEntry[] | null>(null);
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [sessions, setSessions] = useState<TradingSession[] | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ConfigDialog>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("sessions");
  const [bookTab, setBookTab] = useState<BookTab>("book");

  function refreshSessions() {
    fetchTradingSessions(symbol)
      .then((s) => setSessions(s))
      .catch(() => {});
  }

  useEffect(() => {
    let cancelled = false;
    setTrades(null);
    setOrderBook(null);

    function poll() {
      const rangeMs = chartRangeMs(range);
      fetchMarketData(symbol, { from: new Date(Date.now() - rangeMs) })
        .then((s) => {
          if (!cancelled) {
            setSamples(s.samples);
            setOldestSampleTime(s.oldestSampleTime);
          }
        })
        .catch(() => {
          if (!cancelled) setError("Failed to load market data");
        });
      fetchPerps()
        .then((perps) => {
          if (!cancelled) setPerp(perps.find((p) => p.symbol === symbol) ?? null);
        })
        .catch(() => {});
      fetchPerpStats()
        .then((stats) => {
          if (!cancelled) setStats(stats.find((s) => s.symbol === symbol) ?? null);
        })
        .catch(() => {});
      fetchPositions()
        .then((positions) => {
          if (!cancelled) {
            setPositions(positions.filter((p) => p.symbol === symbol));
          }
        })
        .catch(() => {});
      fetchDecisions({ symbol })
        .then((d) => {
          if (!cancelled) setDecisions(d);
        })
        .catch(() => {
          if (!cancelled) setDecisions([]);
        });
      fetchTradeHistory({ symbol, from: new Date(Date.now() - rangeMs) })
        .then((t) => {
          if (!cancelled) setClosedTrades(t);
        })
        .catch(() => {
          if (!cancelled) setClosedTrades([]);
        });
      fetchFundingPayments()
        .then((payments) => {
          if (!cancelled) {
            setFundingPayments(payments.filter((p) => p.symbol === symbol));
          }
        })
        .catch(() => {
          if (!cancelled) setFundingPayments([]);
        });
      fetchTradingSessions(symbol)
        .then((s) => {
          if (!cancelled) setSessions(s);
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });
      fetchOrderBook(symbol)
        .then((book) => {
          if (!cancelled) setOrderBook(book);
        })
        .catch(() => {});
      fetchRecentTrades(symbol)
        .then((t) => {
          if (cancelled) return;
          setTrades((prev) => {
            const combined = [...t, ...(prev ?? [])];
            const seen = new Set<string>();
            const deduped = combined.filter((tr) => {
              const key = `${tr.time}-${tr.price}-${tr.size}-${tr.side}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            deduped.sort((a, b) => b.time - a.time);
            return deduped.slice(0, TRADES_LIMIT);
          });
        })
        .catch(() => {});
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [symbol, range]);

  async function applyPatch(patch: Partial<Omit<Perp, "symbol">>) {
    if (!perp) return;
    setPerp({ ...perp, ...patch });
    try {
      const updated = await updatePerpConfig(symbol, patch);
      setPerp(updated);
    } catch {
      setError("Failed to update market");
    }
  }

  function handleSamplingClick() {
    if (!perp) return;
    if (perp.samplingEnabled) {
      applyPatch({ samplingEnabled: false });
    } else {
      setDialog("sampling");
    }
  }

  const totalPnl = useMemo(() => {
    if (!positions || !stats) return null;
    return positions.reduce((sum, position) => {
      const pnl =
        ((stats.price - position.entryPrice) / position.entryPrice) *
        position.notionalUsd *
        (position.direction === "long" ? 1 : -1);
      return sum + pnl;
    }, 0);
  }, [positions, stats]);

  const tradeMarkers: TradeMarker[] = useMemo(() => {
    const openMarkers: TradeMarker[] = (positions ?? []).map((position) => ({
      time: position.openedAt,
      direction: position.direction,
      action: "open",
      price: position.entryPrice,
    }));
    const closedMarkers: TradeMarker[] = (closedTrades ?? []).flatMap(
      (trade) => [
        {
          time: trade.openedAt,
          direction: trade.direction,
          action: "open" as const,
          price: trade.entryPrice,
        },
        {
          time: trade.closedAt,
          direction: trade.direction,
          action: "close" as const,
          price: trade.exitPrice,
        },
      ],
    );
    return [...openMarkers, ...closedMarkers];
  }, [positions, closedTrades]);

  const activeSessionCount = sessions
    ? sessions.filter((s) => s.status !== "closed").length
    : null;

  const loading = !samples && !error;

  return (
    <SiteHeader>
      <main className="flex flex-col gap-4 px-6 py-8 sm:px-8 lg:px-12">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard/markets"
            className="text-sm text-ember hover:underline"
          >
            &larr; Markets
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-text">
            {symbol}
          </h1>
          {perp && (
            <div className="flex items-center gap-2">
              <StatusBadge label="Sampling" active={perp.samplingEnabled} />
              <span className="inline-flex items-center gap-1.5 rounded-full border border-surface-1 px-2.5 py-1 text-xs font-medium text-subtext-0">
                {activeSessionCount ?? "-"} active session
                {activeSessionCount === 1 ? "" : "s"}
              </span>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <Card className="flex flex-wrap items-center gap-x-8 gap-y-4 p-5">
          <HeaderStat label="Mark price" value={formatPrice(stats?.price)} />
          <HeaderStat
            label="24h change"
            value={
              stats ? (
                <span
                  className={
                    stats.changePct >= 0
                      ? "text-emerald-400"
                      : "text-destructive"
                  }
                >
                  {stats.changePct >= 0 ? "+" : ""}
                  {stats.changePct.toFixed(2)}%
                </span>
              ) : (
                "-"
              )
            }
          />
          <HeaderStat label="24h volume" value={formatVolume(stats?.volumeUsd)} />
          <HeaderStat
            label="Open interest"
            value={formatVolume(stats?.openInterestUsd)}
          />
          <HeaderStat
            label="Sampling freq"
            value={perp ? `${perp.samplingFrequencySeconds}s` : "-"}
          />
          <HeaderStat
            label="Aggregate P&amp;L"
            value={
              totalPnl === null ? (
                "-"
              ) : (
                <span
                  className={
                    totalPnl >= 0 ? "text-emerald-400" : "text-destructive"
                  }
                >
                  {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                </span>
              )
            }
          />

          {perp && (
            <div className="ml-auto flex items-center gap-2">
              <IconButton
                active={perp.samplingEnabled}
                aria-label={
                  perp.samplingEnabled ? "Disable sampling" : "Enable sampling"
                }
                title={
                  perp.samplingEnabled ? "Disable sampling" : "Enable sampling"
                }
                onClick={handleSamplingClick}
              >
                <SamplingIcon className="h-4 w-4" />
              </IconButton>
            </div>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-4 lg:col-span-2">
            {loading && (
              <Card className="p-5">
                <Skeleton className="h-80 w-full" />
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
                markers={tradeMarkers}
              />
            )}
          </div>

          <Card className="flex h-[640px] flex-col p-0">
            <div className="flex border-b border-surface-1">
              <button
                type="button"
                onClick={() => setBookTab("book")}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                  bookTab === "book"
                    ? "border-b-2 border-ember text-ember"
                    : "text-subtext-1 hover:text-text"
                }`}
              >
                Order Book
              </button>
              <button
                type="button"
                onClick={() => setBookTab("trades")}
                className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors ${
                  bookTab === "trades"
                    ? "border-b-2 border-ember text-ember"
                    : "text-subtext-1 hover:text-text"
                }`}
              >
                Trades
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {bookTab === "book" ? (
                <OrderBookPanel book={orderBook} />
              ) : (
                <TradesPanel trades={trades} />
              )}
            </div>
          </Card>
        </div>

        <Card className="flex flex-col p-0">
          <div className="flex border-b border-surface-1">
            {(
              [
                ["sessions", "Sessions"],
                ["position", "Position"],
                ["decisions", "Decision history"],
                ["funding", "Funding history"],
              ] as [DetailTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setDetailTab(key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors ${
                  detailTab === key
                    ? "border-b-2 border-ember text-ember"
                    : "text-subtext-1 hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {detailTab === "sessions" && (
            <SessionsPanel
              symbol={symbol}
              sessions={sessions}
              onNewSession={() => setDialog("new-session")}
              onChanged={refreshSessions}
            />
          )}

          {detailTab === "position" && (
            <div className="overflow-x-auto">
              {!positions ? (
                <p className="p-5 text-sm text-subtext-1">Loading...</p>
              ) : positions.length === 0 ? (
                <p className="p-5 text-sm text-subtext-1">No open positions.</p>
              ) : (
                <table className="w-full min-w-[640px] border-collapse text-left text-sm text-text">
                  <thead>
                    <tr>
                      <th className={TH}>Session</th>
                      <th className={TH}>Direction</th>
                      <th className={TH}>Entry price</th>
                      <th className={TH}>Notional</th>
                      <th className={TH}>Unrealized P&amp;L</th>
                      <th className={TH}>Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((position) => {
                      const pnl =
                        stats &&
                        ((stats.price - position.entryPrice) /
                          position.entryPrice) *
                          position.notionalUsd *
                          (position.direction === "long" ? 1 : -1);
                      return (
                        <tr key={position.sessionId} className="hover:bg-surface-0/60">
                          <td className={TD}>
                            <Link
                              href={`/dashboard/markets/${symbol}/sessions/${position.sessionId}`}
                              className="text-ember hover:underline"
                            >
                              {position.sessionId.slice(0, 8)}
                            </Link>
                          </td>
                          <td
                            className={`${TD} font-medium ${
                              position.direction === "long"
                                ? "text-emerald-400"
                                : "text-destructive"
                            }`}
                          >
                            {position.direction}
                          </td>
                          <td className={TD}>{formatPrice(position.entryPrice)}</td>
                          <td className={TD}>
                            ${position.notionalUsd.toLocaleString()}
                          </td>
                          <td
                            className={`${TD} font-medium ${
                              (pnl ?? 0) >= 0
                                ? "text-emerald-400"
                                : "text-destructive"
                            }`}
                          >
                            {pnl === null || pnl === undefined
                              ? "-"
                              : `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
                          </td>
                          <td className={TD}>
                            {new Date(position.openedAt).toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {detailTab === "decisions" && (
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
                      <th className={TH}>Session</th>
                      <th className={TH}>Direction</th>
                      <th className={TH}>Confidence</th>
                      <th className={TH}>Action</th>
                      <th className={TH}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {decisions.slice(0, 20).map((d, i) => (
                      <tr key={i} className="hover:bg-surface-0/60">
                        <td className={TD}>
                          {new Date(d.time).toLocaleString()}
                        </td>
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
          )}

          {detailTab === "funding" && (
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
          )}
        </Card>
      </main>

      {dialog === "sampling" && perp && (
        <Modal
          title={`Enable sampling — ${symbol}`}
          onClose={() => setDialog(null)}
        >
          <SamplingForm
            perp={perp}
            onCancel={() => setDialog(null)}
            onSubmit={async (values) => {
              await applyPatch({ samplingEnabled: true, ...values });
              setDialog(null);
            }}
          />
        </Modal>
      )}

      {dialog === "new-session" && (
        <Modal title={`New trading session — ${symbol}`} onClose={() => setDialog(null)}>
          <NewSessionForm
            symbol={symbol}
            onCancel={() => setDialog(null)}
            onCreated={() => {
              setDialog(null);
              refreshSessions();
            }}
          />
        </Modal>
      )}
    </SiteHeader>
  );
}

function SessionsPanel({
  symbol,
  sessions,
  onNewSession,
  onChanged,
}: {
  symbol: string;
  sessions: TradingSession[] | null;
  onNewSession: () => void;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleSoftClose(id: string) {
    setBusyId(id);
    setActionError(null);
    const result = await softCloseTradingSession(id);
    if (!result.ok) setActionError(result.error);
    setBusyId(null);
    onChanged();
  }

  async function handleHardClose(id: string) {
    setBusyId(id);
    setActionError(null);
    const result = await hardCloseTradingSession(id);
    if (!result.ok) setActionError(result.error);
    setBusyId(null);
    onChanged();
  }

  return (
    <div className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-subtext-1">
          Each session runs its own decision maker against an exclusively
          attached wallet.
        </p>
        <Button type="button" onClick={onNewSession}>
          New session
        </Button>
      </div>
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {!sessions ? (
        <p className="text-sm text-subtext-1">Loading...</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-subtext-1">No trading sessions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-sm text-text">
            <thead>
              <tr>
                <th className={TH}>Session</th>
                <th className={TH}>Status</th>
                <th className={TH}>Decision maker</th>
                <th className={TH}>Freq</th>
                <th className={TH}>Leverage</th>
                <th className={TH}>Size</th>
                <th className={TH}>Wallet</th>
                <th className={TH}></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id} className="hover:bg-surface-0/60">
                  <td className={TD}>
                    <Link
                      href={`/dashboard/markets/${symbol}/sessions/${session.id}`}
                      className="text-ember hover:underline"
                    >
                      {session.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className={TD}>
                    <SessionStatusBadge status={session.status} />
                  </td>
                  <td className={TD}>{session.decisionMaker}</td>
                  <td className={TD}>{session.decisionFrequencySeconds}s</td>
                  <td className={TD}>{session.leverage}x</td>
                  <td className={TD}>
                    ${session.positionSizeUsd.toLocaleString()}
                  </td>
                  <td className={TD}>
                    {session.walletId ? session.walletId.slice(0, 8) : "-"}
                  </td>
                  <td className={TD}>
                    {session.status === "active" && (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busyId === session.id}
                          onClick={() => handleSoftClose(session.id)}
                        >
                          Soft close
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busyId === session.id}
                          onClick={() => handleHardClose(session.id)}
                        >
                          Hard close
                        </Button>
                      </div>
                    )}
                    {session.status === "soft_closing" && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={busyId === session.id}
                        onClick={() => handleHardClose(session.id)}
                      >
                        Force close now
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const DECISION_MAKERS: DecisionMaker[] = ["random", "typesafe", "openrouter"];

function NewSessionForm({
  symbol,
  onCancel,
  onCreated,
}: {
  symbol: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const router = useRouter();
  const [sessionType, setSessionType] = useState<"live" | "backtest">("live");
  const [decisionMaker, setDecisionMaker] = useState<DecisionMaker>("random");
  const [decisionFrequencySeconds, setDecisionFrequencySeconds] = useState("300");
  const [leverage, setLeverage] = useState("1");
  const [positionSizeUsd, setPositionSizeUsd] = useState("100");
  const [historyWindowSamples, setHistoryWindowSamples] = useState("1000");
  const [historyFormat, setHistoryFormat] = useState<HistoryFormat>("summary");
  const [storeDecisionPayloads, setStoreDecisionPayloads] = useState(false);
  const [stopLossPct, setStopLossPct] = useState("");
  const [walletId, setWalletId] = useState("");
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [initialBalanceUsd, setInitialBalanceUsd] = useState("10000");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const size = Number(positionSizeUsd);
    if (!Number.isFinite(size) || size <= 0) {
      setWallets([]);
      return;
    }
    let cancelled = false;
    fetchSelectableWallets(symbol, size)
      .then((w) => {
        if (!cancelled) setWallets(w);
      })
      .catch(() => {
        if (!cancelled) setWallets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, positionSizeUsd]);

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
        const history = Number(historyWindowSamples);
        const stopLoss = stopLossPct.trim() === "" ? null : Number(stopLossPct) / 100;
        if (
          !Number.isFinite(decision) ||
          decision <= 0 ||
          !Number.isFinite(lev) ||
          lev <= 0 ||
          !Number.isFinite(size) ||
          size <= 0 ||
          !Number.isInteger(history) ||
          history < 1 ||
          history > 1000 ||
          (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss <= 0 || stopLoss > 1))
        ) {
          return;
        }

        if (sessionType === "backtest") {
          const balance = Number(initialBalanceUsd);
          if (
            !startTime ||
            !endTime ||
            !Number.isFinite(balance) ||
            balance <= 0
          ) {
            return;
          }
          setSubmitting(true);
          setError(null);
          const result = await createBacktest(symbol, {
            decisionMaker,
            decisionFrequencySeconds: decision,
            leverage: lev,
            positionSizeUsd: size,
            historyWindowSamples: history,
            historyFormat,
            storeDecisionPayloads,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            initialBalanceUsd: balance,
          });
          setSubmitting(false);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          router.push(`/dashboard/markets/${symbol}/backtests/${result.backtest.id}`);
          return;
        }

        setSubmitting(true);
        setError(null);
        const result = await createTradingSession(symbol, {
          decisionMaker,
          decisionFrequencySeconds: decision,
          leverage: lev,
          positionSizeUsd: size,
          historyWindowSamples: history,
          historyFormat,
          storeDecisionPayloads,
          stopLossPct: stopLoss,
          walletId: walletId || null,
        });
        setSubmitting(false);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        if (walletId) {
          await attachSessionWallet(result.session.id, walletId);
        }
        onCreated();
      }}
    >
      {error && <p className="text-sm text-destructive">{error}</p>}
      <label className="flex flex-col gap-1">
        <Label>Session type</Label>
        <Select
          value={sessionType}
          onChange={(e) => setSessionType(e.target.value as "live" | "backtest")}
        >
          <option value="live">Live (paper/real trading)</option>
          <option value="backtest">Backtest (replay historical data)</option>
        </Select>
      </label>
      <label className="flex flex-col gap-1">
        <Label>Decision maker</Label>
        <Select
          value={decisionMaker}
          onChange={(e) => setDecisionMaker(e.target.value as DecisionMaker)}
        >
          {DECISION_MAKERS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
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
        <Label>Price history window (samples)</Label>
        <Input
          type="number"
          min={1}
          max={1000}
          value={historyWindowSamples}
          onChange={(e) => setHistoryWindowSamples(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <Label>Price history format</Label>
        <Select
          value={historyFormat}
          onChange={(e) => setHistoryFormat(e.target.value as HistoryFormat)}
        >
          <option value="summary">summary (averaged)</option>
          <option value="raw">raw (every sample)</option>
        </Select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={storeDecisionPayloads}
          onChange={(e) => setStoreDecisionPayloads(e.target.checked)}
        />
        <span className="text-sm">
          Store raw Jev request/response for every decision
        </span>
      </label>
      {sessionType === "live" ? (
        <label className="flex flex-col gap-1">
          <Label>Stop loss (% of notional, optional)</Label>
          <Input
            type="number"
            min={0}
            max={100}
            step="any"
            placeholder="No stop loss"
            value={stopLossPct}
            onChange={(e) => setStopLossPct(e.target.value)}
          />
        </label>
      ) : null}
      {sessionType === "live" ? (
        <label className="flex flex-col gap-1">
          <Label>Wallet (optional — can attach later)</Label>
          <Select value={walletId} onChange={(e) => setWalletId(e.target.value)}>
            <option value="">No wallet</option>
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
      ) : (
        <>
          <label className="flex flex-col gap-1">
            <Label>Start</Label>
            <Input
              type="datetime-local"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <Label>End</Label>
            <Input
              type="datetime-local"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <Label>Initial balance (USD)</Label>
            <Input
              type="number"
              min={1}
              value={initialBalanceUsd}
              onChange={(e) => setInitialBalanceUsd(e.target.value)}
            />
          </label>
        </>
      )}
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? "Creating..."
            : sessionType === "backtest"
              ? "Run backtest"
              : "Create session"}
        </Button>
      </div>
    </form>
  );
}

function OrderBookRow({
  price,
  size,
  maxSize,
  side,
}: {
  price: number;
  size: number;
  maxSize: number;
  side: "ask" | "bid";
}) {
  const pct = Math.min((size / maxSize) * 100, 100);
  return (
    <div className="relative grid grid-cols-3 items-center gap-2 overflow-hidden rounded px-2 hover:bg-surface-0/60">
      <div
        className="pointer-events-none absolute inset-y-0 left-0"
        style={{
          width: `${pct}%`,
          backgroundColor:
            side === "ask" ? "rgba(255, 107, 107, 0.16)" : "rgba(74, 222, 128, 0.16)",
        }}
      />
      <span
        className={`relative z-10 ${side === "ask" ? "text-destructive" : "text-emerald-400"}`}
      >
        {formatPrice(price)}
      </span>
      <span className="relative z-10 text-right text-subtext-1">
        {size.toFixed(4)}
      </span>
      <span className="relative z-10 text-right text-subtext-1">
        {(size * price).toLocaleString(undefined, { maximumFractionDigits: 2 })}
      </span>
    </div>
  );
}

function OrderBookPanel({ book }: { book: OrderBook | null }) {
  if (!book) {
    return <p className="p-5 text-sm text-subtext-1">Loading...</p>;
  }
  if (book.bids.length === 0 && book.asks.length === 0) {
    return <p className="p-5 text-sm text-subtext-1">No order book data.</p>;
  }

  const depth = 10;
  const asks = book.asks.slice(0, depth).slice().reverse();
  const bids = book.bids.slice(0, depth);
  const bestBid = book.bids[0]?.price;
  const bestAsk = book.asks[0]?.price;
  const spread =
    bestBid !== undefined && bestAsk !== undefined ? bestAsk - bestBid : null;
  const maxSize = Math.max(
    ...asks.map((l) => l.size),
    ...bids.map((l) => l.size),
    1,
  );

  return (
    <div className="flex h-full flex-col px-3 pb-3 text-xs">
      <div className="grid grid-cols-3 gap-2 px-2 pb-1 pt-2 text-[11px] uppercase tracking-wide text-subtext-0">
        <span>Price</span>
        <span className="text-right">Size (Base)</span>
        <span className="text-right">Size (Quote)</span>
      </div>
      <div className="flex flex-1 flex-col justify-between">
        {asks.map((level) => (
          <OrderBookRow
            key={`ask-${level.price}`}
            price={level.price}
            size={level.size}
            maxSize={maxSize}
            side="ask"
          />
        ))}
      </div>
      <div className="flex justify-between border-y border-surface-1 px-2 py-1.5 font-medium text-text">
        <span>Spread</span>
        <span>{spread === null ? "-" : spread.toFixed(2)}</span>
      </div>
      <div className="flex flex-1 flex-col justify-between">
        {bids.map((level) => (
          <OrderBookRow
            key={`bid-${level.price}`}
            price={level.price}
            size={level.size}
            maxSize={maxSize}
            side="bid"
          />
        ))}
      </div>
    </div>
  );
}

function TradesPanel({ trades }: { trades: Trade[] | null }) {
  if (!trades) {
    return <p className="p-5 text-sm text-subtext-1">Loading...</p>;
  }
  if (trades.length === 0) {
    return <p className="p-5 text-sm text-subtext-1">No recent trades.</p>;
  }

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto p-3 text-xs">
      <div className="flex justify-between px-2 pb-1 text-[11px] uppercase tracking-wide text-subtext-0">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      {trades.slice(0, TRADES_LIMIT).map((t, i) => (
        <div
          key={`${t.time}-${i}`}
          className="flex justify-between rounded px-2 py-1 hover:bg-surface-0/60"
        >
          <span className={t.side === "buy" ? "text-emerald-400" : "text-destructive"}>
            {formatPrice(t.price)}
          </span>
          <span className="text-subtext-1">{t.size.toFixed(4)}</span>
          <span className="text-subtext-0">
            {new Date(t.time).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
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
