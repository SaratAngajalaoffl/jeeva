"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import LineChart from "@/components/LineChart";
import { fetchMarketData, type MarketDataPoint } from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";

export default function MarketDataPage() {
  const params = useParams<{ symbol: string }>();
  const symbol = params.symbol;
  const [samples, setSamples] = useState<MarketDataPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMarketData(symbol)
      .then(setSamples)
      .catch(() => setError("Failed to load market data"));
  }, [symbol]);

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard/markets"
            className="text-sm text-ember hover:underline"
          >
            &larr; Markets
          </Link>
          <h1 className="text-xl font-semibold tracking-tight text-text">
            {symbol} market data
          </h1>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        {!error && !samples && (
          <p className="text-sm text-subtext-1">Loading...</p>
        )}

        {samples && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <LineChart
              title="Price"
              unit="USD"
              points={samples.map((s) => ({ x: s.time, y: s.price }))}
            />
            <LineChart
              title="Open interest"
              points={samples.map((s) => ({ x: s.time, y: s.openInterest }))}
            />
            <LineChart
              title="Volume"
              points={samples.map((s) => ({ x: s.time, y: s.volume }))}
            />
            <LineChart
              title="Spread"
              unit="USD"
              points={samples.map((s) => ({ x: s.time, y: s.spread }))}
            />
          </div>
        )}
      </main>
    </div>
  );
}
