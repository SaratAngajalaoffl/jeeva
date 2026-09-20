"use client";

import * as React from "react";

/**
 * The two independent axes — which DecisionMaker answers, and where the order
 * goes — as a grid you can hover. Lighting the row and column headers from the
 * hovered cell is the whole point: it shows that the axes are separate
 * choices, not one "mode" dropdown.
 */

const DECISION_MAKERS = [
  { name: "Fake", note: "Synthetic decisions, no network calls." },
  { name: "TypeSafe Jev", note: "Jev's systemOne API, called directly." },
  { name: "OpenRouter Jev", note: "The same Jev, routed via OpenRouter." },
];

const EXECUTION = [
  { name: "Mock", note: "Simulated fills against a virtual wallet." },
  { name: "Live", note: "Signed orders on a real Hyperliquid wallet." },
];

const CELLS: Array<Array<{ text: string; tone: "safe" | "live"; tag?: string }>> =
  [
    [
      {
        text: "Safe out of the box — no credentials, no funds, no surprises.",
        tone: "safe",
        tag: "Default",
      },
      {
        text: "Smoke-test the order path with throwaway decisions.",
        tone: "live",
      },
    ],
    [
      {
        text: "Paper-trading with real intelligence.",
        tone: "safe",
        tag: "Sweet spot",
      },
      { text: "Jev's calls, signed and sent to Hyperliquid.", tone: "live" },
    ],
    [
      {
        text: "The same decisions through a second provider, still risk-free.",
        tone: "safe",
      },
      { text: "OpenRouter-routed Jev, trading real size.", tone: "live" },
    ],
  ];

export function AxisMatrix() {
  const [hovered, setHovered] = React.useState<[number, number] | null>(null);
  const [row, column] = hovered ?? [-1, -1];

  return (
    <div className="overflow-x-auto">
      <div className="grid min-w-[560px] grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3">
        {/* Column headers. */}
        <div className="flex items-end pb-1 text-xs font-medium uppercase tracking-wider text-subtext-0">
          Decision ↓ / Execution →
        </div>
        {EXECUTION.map((execution, columnIndex) => (
          <div
            key={execution.name}
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
              {execution.name}
            </div>
            <div className="mt-0.5 text-xs text-subtext-0">
              {execution.note}
            </div>
          </div>
        ))}

        {/* Rows. */}
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
