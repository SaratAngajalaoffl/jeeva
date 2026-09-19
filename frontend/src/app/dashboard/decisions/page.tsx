"use client";

import { useEffect, useState } from "react";
import {
  fetchDecisions,
  fetchPerps,
  fetchPositions,
  type DecisionLogEntry,
  type Perp,
  type Position,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Card, Label, Select } from "@/components/ui";

type PositionState = "flat" | "long" | "short";

const TH = "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

const STATE_COLOR: Record<PositionState, string> = {
  flat: "text-subtext-0",
  long: "text-emerald-400",
  short: "text-destructive",
};

export default function DecisionsPage() {
  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
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
  }, []);

  useEffect(() => {
    fetchDecisions(symbolFilter || undefined)
      .then(setDecisions)
      .catch(() => setError("Failed to load decision history"));
  }, [symbolFilter]);

  function positionStateFor(symbol: string): PositionState {
    const position = positions?.find((p) => p.symbol === symbol);
    return position?.direction ?? "flat";
  }

  return (
    <SiteHeader>
      <main className="flex flex-col gap-8 px-6 py-8 sm:px-8 lg:px-12">
        {error && <p className="text-sm text-destructive">{error}</p>}

        <section>
          <h1 className="mb-3 text-xl font-semibold tracking-tight text-text">
            Positions
          </h1>
          {!perps || !positions ? (
            <p className="text-sm text-subtext-1">Loading...</p>
          ) : (
            <Card className="max-w-2xl overflow-x-auto p-0">
              <table className="w-full border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Symbol</th>
                    <th className={TH}>State</th>
                    <th className={TH}>Entry price</th>
                    <th className={TH}>Notional (USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {perps
                    .filter((p) => p.tradingEnabled)
                    .map((perp) => {
                      const position = positions.find(
                        (p) => p.symbol === perp.symbol,
                      );
                      const state = positionStateFor(perp.symbol);
                      return (
                        <tr key={perp.symbol} className="hover:bg-surface-0/60">
                          <td className={`${TD} font-medium`}>{perp.symbol}</td>
                          <td className={`${TD} ${STATE_COLOR[state]}`}>
                            {state}
                          </td>
                          <td className={TD}>
                            {position ? position.entryPrice.toLocaleString() : "-"}
                          </td>
                          <td className={TD}>
                            {position ? position.notionalUsd.toLocaleString() : "-"}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </Card>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight text-text">
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
            <p className="text-sm text-subtext-1">Loading...</p>
          ) : decisions.length === 0 ? (
            <p className="text-sm text-subtext-1">No decisions yet.</p>
          ) : (
            <Card className="max-w-4xl overflow-x-auto p-0">
              <table className="w-full border-collapse text-left text-sm text-text">
                <thead>
                  <tr>
                    <th className={TH}>Time</th>
                    <th className={TH}>Symbol</th>
                    <th className={TH}>Target direction</th>
                    <th className={TH}>Confidence</th>
                    <th className={TH}>Action</th>
                    <th className={TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {decisions.map((d, i) => (
                    <tr key={i} className="hover:bg-surface-0/60">
                      <td className={TD}>
                        {new Date(d.time).toLocaleString()}
                      </td>
                      <td className={TD}>{d.symbol}</td>
                      <td className={TD}>{d.targetDirection ?? "-"}</td>
                      <td className={TD}>
                        {d.confidence !== null ? d.confidence.toFixed(2) : "-"}
                      </td>
                      <td className={TD}>{d.positionAction ?? "-"}</td>
                      <td className={TD}>
                        {d.success ? (
                          <span className="text-emerald-400">ok</span>
                        ) : (
                          <span className="text-destructive">{`error: ${d.error}`}</span>
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
