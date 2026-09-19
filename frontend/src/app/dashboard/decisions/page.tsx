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

type PositionState = "flat" | "long" | "short";

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

  if (error) {
    return <p className="p-8 text-red-600">{error}</p>;
  }

  return (
    <main className="flex flex-col gap-8 p-8">
      <section>
        <h1 className="mb-2 text-xl font-semibold">Positions</h1>
        {!perps || !positions ? (
          <p>Loading...</p>
        ) : (
          <table className="w-full max-w-2xl border-collapse text-left">
            <thead>
              <tr>
                <th className="border-b py-2">Symbol</th>
                <th className="border-b py-2">Position state</th>
                <th className="border-b py-2">Entry price</th>
                <th className="border-b py-2">Notional (USD)</th>
              </tr>
            </thead>
            <tbody>
              {perps
                .filter((p) => p.tradingEnabled)
                .map((perp) => {
                  const position = positions.find(
                    (p) => p.symbol === perp.symbol,
                  );
                  return (
                    <tr key={perp.symbol}>
                      <td className="border-b py-2">{perp.symbol}</td>
                      <td className="border-b py-2">
                        {positionStateFor(perp.symbol)}
                      </td>
                      <td className="border-b py-2">
                        {position ? position.entryPrice.toLocaleString() : "-"}
                      </td>
                      <td className="border-b py-2">
                        {position ? position.notionalUsd.toLocaleString() : "-"}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-center gap-3">
          <h2 className="text-xl font-semibold">Decision history</h2>
          <label className="flex items-center gap-2 text-sm">
            <span>Filter by symbol</span>
            <select
              className="rounded border px-2 py-1"
              value={symbolFilter}
              onChange={(e) => setSymbolFilter(e.target.value)}
            >
              <option value="">All</option>
              {perps?.map((p) => (
                <option key={p.symbol} value={p.symbol}>
                  {p.symbol}
                </option>
              ))}
            </select>
          </label>
        </div>

        {!decisions ? (
          <p>Loading...</p>
        ) : decisions.length === 0 ? (
          <p>No decisions yet.</p>
        ) : (
          <table className="w-full max-w-4xl border-collapse text-left text-sm">
            <thead>
              <tr>
                <th className="border-b py-2">Time</th>
                <th className="border-b py-2">Symbol</th>
                <th className="border-b py-2">Target direction</th>
                <th className="border-b py-2">Confidence</th>
                <th className="border-b py-2">Action</th>
                <th className="border-b py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {decisions.map((d, i) => (
                <tr key={i}>
                  <td className="border-b py-2">
                    {new Date(d.time).toLocaleString()}
                  </td>
                  <td className="border-b py-2">{d.symbol}</td>
                  <td className="border-b py-2">{d.targetDirection ?? "-"}</td>
                  <td className="border-b py-2">
                    {d.confidence !== null ? d.confidence.toFixed(2) : "-"}
                  </td>
                  <td className="border-b py-2">{d.positionAction ?? "-"}</td>
                  <td className="border-b py-2">
                    {d.success ? "ok" : `error: ${d.error}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
