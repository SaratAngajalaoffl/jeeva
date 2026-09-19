"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchPerps, updatePerpConfig, type Perp } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Card } from "@/components/ui";

type NumericField =
  | "decisionFrequencySeconds"
  | "samplingFrequencySeconds"
  | "leverage"
  | "positionSizeUsd";

const NUMERIC_INPUT =
  "w-24 rounded-md border border-surface-1 bg-mantle px-2 py-1 text-sm text-text outline-none focus:border-ember/70 focus:ring-1 focus:ring-ember/50";
const TH = "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

export default function MarketsPage() {
  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPerps()
      .then(setPerps)
      .catch(() => setError("Failed to load markets"));
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

  function handleNumericBlur(
    symbol: string,
    field: NumericField,
    rawValue: string,
  ) {
    const value = Number(rawValue);
    if (Number.isFinite(value) && value > 0) {
      applyPatch(symbol, { [field]: value });
    }
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl font-semibold tracking-tight text-text">
          Markets
        </h1>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {!perps ? (
          <p className="text-sm text-subtext-1">Loading markets...</p>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm text-text">
              <thead>
                <tr>
                  <th className={TH}>Symbol</th>
                  <th className={TH}>Trading</th>
                  <th className={TH}>Sampling</th>
                  <th className={TH}>Decision freq (s)</th>
                  <th className={TH}>Sampling freq (s)</th>
                  <th className={TH}>Leverage</th>
                  <th className={TH}>Position size (USD)</th>
                  <th className={TH}>Chart</th>
                </tr>
              </thead>
              <tbody>
                {perps.map((perp) => (
                  <tr key={perp.symbol} className="hover:bg-surface-0/60">
                    <td className={`${TD} font-medium`}>{perp.symbol}</td>
                    <td className={TD}>
                      <input
                        type="checkbox"
                        aria-label={`${perp.symbol} trading enabled`}
                        checked={perp.tradingEnabled}
                        onChange={(e) =>
                          applyPatch(perp.symbol, {
                            tradingEnabled: e.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-ember"
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="checkbox"
                        aria-label={`${perp.symbol} sampling enabled`}
                        checked={perp.samplingEnabled}
                        onChange={(e) =>
                          applyPatch(perp.symbol, {
                            samplingEnabled: e.target.checked,
                          })
                        }
                        className="h-4 w-4 accent-ember"
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="number"
                        min={1}
                        className={NUMERIC_INPUT}
                        aria-label={`${perp.symbol} decision frequency seconds`}
                        defaultValue={perp.decisionFrequencySeconds}
                        onBlur={(e) =>
                          handleNumericBlur(
                            perp.symbol,
                            "decisionFrequencySeconds",
                            e.target.value,
                          )
                        }
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="number"
                        min={1}
                        className={NUMERIC_INPUT}
                        aria-label={`${perp.symbol} sampling frequency seconds`}
                        defaultValue={perp.samplingFrequencySeconds}
                        onBlur={(e) =>
                          handleNumericBlur(
                            perp.symbol,
                            "samplingFrequencySeconds",
                            e.target.value,
                          )
                        }
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="number"
                        min={1}
                        className={`${NUMERIC_INPUT} w-20`}
                        aria-label={`${perp.symbol} leverage`}
                        defaultValue={perp.leverage}
                        onBlur={(e) =>
                          handleNumericBlur(perp.symbol, "leverage", e.target.value)
                        }
                      />
                    </td>
                    <td className={TD}>
                      <input
                        type="number"
                        min={1}
                        className={`${NUMERIC_INPUT} w-28`}
                        aria-label={`${perp.symbol} position size usd`}
                        defaultValue={perp.positionSizeUsd}
                        onBlur={(e) =>
                          handleNumericBlur(
                            perp.symbol,
                            "positionSizeUsd",
                            e.target.value,
                          )
                        }
                      />
                    </td>
                    <td className={TD}>
                      <Link
                        href={`/dashboard/markets/${perp.symbol}`}
                        className="text-ember hover:underline"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </main>
    </div>
  );
}
