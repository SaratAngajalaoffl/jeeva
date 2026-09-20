"use client";

import * as React from "react";

/**
 * The two interfaces as a grid you can hover. Lighting the row and column
 * headers from the hovered cell is the whole point: strategy and venue are
 * separate choices, so every combination is reachable — including the ones
 * nothing ships with yet.
 */

const DECISION_MAKERS = [
  { name: "Jev", note: "The decision model included in the box." },
  {
    name: "Your rules",
    note: "Indicators, thresholds, anything deterministic.",
  },
  { name: "Your model", note: "A service you call, or code you run yourself." },
];

const WALLETS = [
  { name: "Paper wallet", note: "Simulated fills. No funds involved." },
  { name: "Hyperliquid", note: "Real orders on a connected wallet." },
  {
    name: "Your exchange",
    note: "An adapter you write against the same interface.",
  },
];

const CELLS: Array<
  Array<{ text: string; tone: "safe" | "live"; tag?: string }>
> = [
  [
    {
      text: "Try the bundled model with nothing at stake.",
      tone: "safe",
      tag: "Start here",
    },
    { text: "The setup Jeeva ships with, running live.", tone: "live" },
    { text: "The same decisions, on a venue you add.", tone: "live" },
  ],
  [
    {
      text: "Prove your rules out on live market data, risk-free.",
      tone: "safe",
    },
    { text: "Your logic, placing real orders.", tone: "live" },
    { text: "Your logic, your venue.", tone: "live" },
  ],
  [
    {
      text: "Benchmark something new against the decision log.",
      tone: "safe",
    },
    { text: "Promote it to live with one setting.", tone: "live" },
    {
      text: "Every part replaced — the loop around them is unchanged.",
      tone: "live",
    },
  ],
];

export function AxisMatrix() {
  const [hovered, setHovered] = React.useState<[number, number] | null>(null);
  const [row, column] = hovered ?? [-1, -1];

  return (
    <div className="overflow-x-auto pb-2">
      <div className="grid min-w-[760px] grid-cols-[minmax(0,0.9fr)_repeat(3,minmax(0,1fr))] gap-3">
        <div className="flex items-end pb-1 text-xs font-medium uppercase tracking-wider text-subtext-0">
          Decides ↓ / Executes →
        </div>
        {WALLETS.map((wallet, columnIndex) => (
          <div
            key={wallet.name}
            className={`rounded-xl border px-4 py-3 transition-all duration-300 ${
              column === columnIndex
                ? "border-peach/50 bg-peach/10"
                : "border-surface-1 bg-surface-0/40"
            }`}
          >
            <div
              className={`text-sm font-semibold tracking-tight transition-colors duration-300 ${
                column === columnIndex ? "text-peach" : "text-text"
              }`}
            >
              {wallet.name}
            </div>
            <div className="mt-0.5 text-xs text-subtext-0">{wallet.note}</div>
          </div>
        ))}

        {DECISION_MAKERS.map((maker, rowIndex) => (
          <React.Fragment key={maker.name}>
            <div
              className={`rounded-xl border px-4 py-3 transition-all duration-300 ${
                row === rowIndex
                  ? "border-ember/50 bg-ember/10"
                  : "border-surface-1 bg-surface-0/40"
              }`}
            >
              <div
                className={`text-sm font-semibold tracking-tight transition-colors duration-300 ${
                  row === rowIndex ? "text-ember" : "text-text"
                }`}
              >
                {maker.name}
              </div>
              <div className="mt-0.5 text-xs text-subtext-0">{maker.note}</div>
            </div>

            {CELLS[rowIndex].map((cell, columnIndex) => {
              const active = row === rowIndex && column === columnIndex;
              const dimmed = hovered !== null && !active;
              return (
                <div
                  key={`${rowIndex}-${columnIndex}`}
                  onPointerEnter={() => setHovered([rowIndex, columnIndex])}
                  onPointerLeave={() => setHovered(null)}
                  className={`group relative cursor-default rounded-xl border p-4 transition-all duration-300 ${
                    active
                      ? "-translate-y-0.5 border-ember/50 bg-surface-0 shadow-lg shadow-ember/10"
                      : "border-surface-1 bg-surface-0/30"
                  } ${dimmed ? "opacity-50" : "opacity-100"}`}
                >
                  {cell.tag && (
                    <span className="mb-2 inline-block rounded-full border border-surface-2 bg-mantle px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-subtext-0">
                      {cell.tag}
                    </span>
                  )}
                  <p className="text-sm leading-relaxed text-subtext-1">
                    {cell.text}
                  </p>
                  <span
                    aria-hidden
                    className={`mt-3 block h-px w-full origin-left transition-transform duration-500 ${
                      cell.tone === "safe" ? "bg-emerald-400/60" : "bg-ember/60"
                    } ${active ? "scale-x-100" : "scale-x-0"}`}
                  />
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
