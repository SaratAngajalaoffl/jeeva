const SYMBOLS = [
  "BTC",
  "ETH",
  "SOL",
  "HYPE",
  "ARB",
  "AVAX",
  "DOGE",
  "LINK",
  "SUI",
  "OP",
  "TIA",
  "INJ",
  "APT",
  "NEAR",
];

/**
 * A continuous strip of PERP symbols. The row is rendered twice and shifted by
 * exactly half its width, so the loop has no seam.
 */
export function TickerTape() {
  return (
    <div
      className="relative overflow-hidden border-y border-surface-1 bg-mantle/40 py-4"
      style={{
        maskImage:
          "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
        WebkitMaskImage:
          "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)",
      }}
    >
      <div className="jv-marquee flex w-max items-center gap-10" aria-hidden>
        {[0, 1].map((copy) => (
          <div key={copy} className="flex items-center gap-10">
            {SYMBOLS.map((symbol) => (
              <span
                key={symbol}
                className="flex shrink-0 items-center gap-2 text-sm font-medium tracking-tight text-subtext-0 transition-colors hover:text-text"
              >
                <span className="h-1 w-1 rounded-full bg-ember/50" />
                {symbol}
                <span className="text-overlay-0">-PERP</span>
              </span>
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">
        Jeeva works with any Hyperliquid perpetual futures market.
      </span>
    </div>
  );
}
