"use client";

import { useEffect, useState } from "react";
import { fetchPerps, updatePerpToggles, type Perp } from "@/lib/api";

export default function MarketsPage() {
  const [perps, setPerps] = useState<Perp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPerps()
      .then(setPerps)
      .catch(() => setError("Failed to load markets"));
  }, []);

  async function handleToggle(
    symbol: string,
    field: "tradingEnabled" | "samplingEnabled",
    value: boolean,
  ) {
    // Optimistic UI update; corrected by the server response, which also
    // enforces the trading/sampling dependency rule.
    setPerps(
      (prev) =>
        prev?.map((p) =>
          p.symbol === symbol ? { ...p, [field]: value } : p,
        ) ?? prev,
    );

    try {
      const updated = await updatePerpToggles(symbol, { [field]: value });
      setPerps(
        (prev) => prev?.map((p) => (p.symbol === symbol ? updated : p)) ?? prev,
      );
    } catch {
      setError("Failed to update market");
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
      <table className="w-full max-w-2xl border-collapse text-left">
        <thead>
          <tr>
            <th className="border-b py-2">Symbol</th>
            <th className="border-b py-2">Trading enabled</th>
            <th className="border-b py-2">Sampling enabled</th>
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
                    handleToggle(
                      perp.symbol,
                      "tradingEnabled",
                      e.target.checked,
                    )
                  }
                />
              </td>
              <td className="border-b py-2">
                <input
                  type="checkbox"
                  aria-label={`${perp.symbol} sampling enabled`}
                  checked={perp.samplingEnabled}
                  onChange={(e) =>
                    handleToggle(
                      perp.symbol,
                      "samplingEnabled",
                      e.target.checked,
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
