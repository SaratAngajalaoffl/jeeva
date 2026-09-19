"use client";

import { useEffect, useState } from "react";
import { fetchPerps, updatePerpConfig, type Perp } from "@/lib/api";

type NumericField =
  | "decisionFrequencySeconds"
  | "samplingFrequencySeconds"
  | "leverage"
  | "positionSizeUsd";

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

  if (error) {
    return <p className="p-8 text-red-600">{error}</p>;
  }

  if (!perps) {
    return <p className="p-8">Loading markets...</p>;
  }

  return (
    <main className="flex flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Markets</h1>
      <table className="w-full max-w-6xl border-collapse text-left">
        <thead>
          <tr>
            <th className="border-b py-2">Symbol</th>
            <th className="border-b py-2">Trading enabled</th>
            <th className="border-b py-2">Sampling enabled</th>
            <th className="border-b py-2">Decision frequency (s)</th>
            <th className="border-b py-2">Sampling frequency (s)</th>
            <th className="border-b py-2">Leverage</th>
            <th className="border-b py-2">Position size (USD)</th>
          </tr>
        </thead>
        <tbody>
          {perps.map((perp) => (
            <tr key={perp.symbol}>
              <td className="border-b py-2">{perp.symbol}</td>
              <td className="border-b py-2">
                <input
                  type="checkbox"
                  aria-label={`${perp.symbol} trading enabled`}
                  checked={perp.tradingEnabled}
                  onChange={(e) =>
                    applyPatch(perp.symbol, {
                      tradingEnabled: e.target.checked,
                    })
                  }
                />
              </td>
              <td className="border-b py-2">
                <input
                  type="checkbox"
                  aria-label={`${perp.symbol} sampling enabled`}
                  checked={perp.samplingEnabled}
                  onChange={(e) =>
                    applyPatch(perp.symbol, {
                      samplingEnabled: e.target.checked,
                    })
                  }
                />
              </td>
              <td className="border-b py-2">
                <input
                  type="number"
                  min={1}
                  className="w-24 rounded border px-2 py-1"
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
              <td className="border-b py-2">
                <input
                  type="number"
                  min={1}
                  className="w-24 rounded border px-2 py-1"
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
              <td className="border-b py-2">
                <input
                  type="number"
                  min={1}
                  className="w-20 rounded border px-2 py-1"
                  aria-label={`${perp.symbol} leverage`}
                  defaultValue={perp.leverage}
                  onBlur={(e) =>
                    handleNumericBlur(perp.symbol, "leverage", e.target.value)
                  }
                />
              </td>
              <td className="border-b py-2">
                <input
                  type="number"
                  min={1}
                  className="w-28 rounded border px-2 py-1"
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
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
