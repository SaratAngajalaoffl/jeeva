import { Reveal } from "./Reveal";

/**
 * What actually crosses the wire: the compact text state the engine builds,
 * and the structured answer that comes back. Jev never sees a database row.
 */

const LINES: Array<Array<{ text: string; tone?: "key" | "num" | "dir" | "dim" }>> =
  [
    [
      { text: "BTC", tone: "key" },
      { text: ": price=" },
      { text: "64213.50", tone: "num" },
      { text: " (change over last 1000 samples: " },
      { text: "+1.84%", tone: "num" },
      { text: ")," },
    ],
    [
      { text: "open_interest=" },
      { text: "182340.00", tone: "num" },
      { text: " (min=178000.00, max=185200.00)," },
    ],
    [
      { text: "volume=" },
      { text: "942310.00", tone: "num" },
      { text: ", spread=" },
      { text: "0.0120", tone: "num" },
      { text: ", mid_price=" },
      { text: "64214.00", tone: "num" },
      { text: ";" },
    ],
    [
      { text: "position=" },
      { text: "long", tone: "dir" },
      { text: " (held_for_minutes=42.0, entry_price=63800.00," },
    ],
    [
      { text: "unrealized_pnl_usd=" },
      { text: "+6.48", tone: "num" },
      { text: ");" },
    ],
    [
      { text: "funding_rate=" },
      { text: "0.000031", tone: "num" },
      { text: " (as_of=2026-09-19T18:00:00Z)", tone: "dim" },
    ],
  ];

const TONE_CLASS = {
  key: "text-peach",
  num: "text-emerald-400",
  dir: "text-ember",
  dim: "text-overlay-1",
} as const;

const PROBABILITIES = [
  { label: "long", value: 61, bar: "bg-emerald-400" },
  { label: "flat", value: 21, bar: "bg-overlay-2" },
  { label: "short", value: 18, bar: "bg-ember" },
];

export function StateBlock() {
  return (
    <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Reveal from="left" className="min-w-0">
        <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-surface-1 bg-crust/80 shadow-xl shadow-black/40 backdrop-blur">
          <div className="flex items-center gap-2 border-b border-surface-1 px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-surface-2" />
            <span className="h-2.5 w-2.5 rounded-full bg-surface-2" />
            <span className="h-2.5 w-2.5 rounded-full bg-surface-2" />
            <span className="ml-2 text-[11px] font-medium uppercase tracking-wider text-subtext-0">
              state → systemOne
            </span>
          </div>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[11px] leading-relaxed text-subtext-1 sm:text-xs">
            <code>
              {LINES.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  className="jv-line"
                  style={{ transitionDelay: `${0.15 + lineIndex * 0.09}s` }}
                >
                  {line.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className={token.tone ? TONE_CLASS[token.tone] : undefined}
                    >
                      {token.text}
                    </span>
                  ))}
                  {lineIndex === LINES.length - 1 && (
                    <span className="jv-caret text-ember">▍</span>
                  )}
                </span>
              ))}
            </code>
          </pre>

          <div className="mt-auto border-t border-surface-1 px-4 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-subtext-0">
              The question
            </div>
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-subtext-1 sm:text-xs">
              <span className="text-peach">Choice</span>
              {" — should this market be "}
              <span className="text-emerald-400">long</span>
              {", "}
              <span className="text-ember">short</span>
              {" or "}
              <span className="text-overlay-2">flat</span>?
            </p>
            <p className="mt-2 text-xs leading-relaxed text-subtext-0">
              One evaluation call. No chat history, no tool loop, no retries on
              a different prompt.
            </p>
          </div>
        </div>
      </Reveal>

      <Reveal from="right" delay={0.15} className="min-w-0">
        <div className="flex h-full flex-col gap-5 rounded-2xl border border-surface-1 bg-surface-0/50 p-6 backdrop-blur">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-subtext-0">
              Target direction
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight text-emerald-400">
                long
              </span>
              <span className="text-sm text-subtext-0">conf. 0.72</span>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {PROBABILITIES.map((probability, index) => (
              <div key={probability.label}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-subtext-1">{probability.label}</span>
                  <span className="font-mono text-subtext-0">
                    0.{probability.value}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-1">
                  <div
                    className={`jv-bar h-full rounded-full ${probability.bar}`}
                    style={{
                      width: `${probability.value}%`,
                      animationDelay: `${0.35 + index * 0.12}s`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <p className="mt-auto border-t border-surface-1 pt-4 text-xs leading-relaxed text-subtext-0">
            Choice, confidence and per-outcome probability all land in the
            decision log — so every position on the dashboard traces back to the
            exact state that produced it.
          </p>
        </div>
      </Reveal>
    </div>
  );
}
