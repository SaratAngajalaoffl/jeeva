"use client";

import * as React from "react";

/**
 * The hero visual: a price path that draws itself, with target-direction
 * markers landing on it in sequence — the shape of one PERP's decision log.
 *
 * The series is a fixed, illustrative sample (labelled as such in the panel),
 * not live market data, so the render is identical on server and client.
 */

const SERIES = [
  46, 41, 49, 44, 52, 47, 43, 51, 58, 54, 62, 57, 66, 61, 55, 63, 72, 68, 77,
  71, 80, 88, 83, 93,
];

const VIEW_W = 680;
const VIEW_H = 300;
const PAD_X = 18;
const TOP = 34;
const BOTTOM = 248;

const min = Math.min(...SERIES);
const max = Math.max(...SERIES);

const POINTS = SERIES.map((value, index) => ({
  x: PAD_X + (index / (SERIES.length - 1)) * (VIEW_W - PAD_X * 2),
  y: BOTTOM - ((value - min) / (max - min)) * (BOTTOM - TOP),
}));

/** Smooth the series with a bezier through horizontal midpoints. */
function smoothPath(points: typeof POINTS) {
  let d = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    const midX = ((from.x + to.x) / 2).toFixed(1);
    d += ` C ${midX} ${from.y.toFixed(1)} ${midX} ${to.y.toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
  }
  return d;
}

const LINE = smoothPath(POINTS);
const AREA = `${LINE} L ${POINTS[POINTS.length - 1].x.toFixed(1)} ${VIEW_H} L ${POINTS[0].x.toFixed(1)} ${VIEW_H} Z`;

const LAST = POINTS[POINTS.length - 1];

type Direction = "long" | "short" | "flat";

const MARKERS: Array<{ index: number; direction: Direction }> = [
  { index: 4, direction: "flat" },
  { index: 9, direction: "long" },
  { index: 14, direction: "short" },
  { index: 18, direction: "long" },
];

const DIRECTION_STYLE: Record<
  Direction,
  { fill: string; stroke: string; label: string }
> = {
  long: { fill: "#34d399", stroke: "#34d399", label: "LONG" },
  short: { fill: "#ff3b3b", stroke: "#ff3b3b", label: "SHORT" },
  flat: { fill: "#a97c80", stroke: "#a97c80", label: "FLAT" },
};

export function SignalPanel() {
  const lineRef = React.useRef<SVGPathElement>(null);

  // Replace the seeded `--len` guess with the real path length so the draw
  // starts exactly at the first pixel.
  React.useEffect(() => {
    const path = lineRef.current;
    if (!path || typeof path.getTotalLength !== "function") return;
    const length = path.getTotalLength();
    if (length > 0) path.style.setProperty("--len", String(length));
  }, []);

  return (
    <div className="jv-fade-up relative" style={{ animationDelay: "0.45s" }}>
      {/* Ember bloom behind the panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-10 -z-10 opacity-70"
        style={{
          background:
            "radial-gradient(60% 55% at 55% 40%, rgb(255 59 59 / 0.22), transparent 70%)",
          filter: "blur(30px)",
        }}
      />

      <div className="relative overflow-hidden rounded-2xl border border-surface-1 bg-mantle/80 shadow-2xl shadow-black/50 backdrop-blur">
        {/* Light sweep across the whole panel. */}
        <div
          aria-hidden
          className="jv-sweep pointer-events-none absolute inset-y-0 -left-1/3 w-1/3 bg-gradient-to-r from-transparent via-text/[0.05] to-transparent"
        />

        <header className="flex items-center justify-between gap-3 border-b border-surface-1 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
            </span>
            <span className="text-sm font-semibold tracking-tight text-text">
              BTC-PERP
            </span>
            <span className="rounded-full border border-surface-1 bg-surface-0 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-subtext-0">
              Sample
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#97FCE4]/40 bg-[#97FCE4]/10 px-2.5 py-1 text-[11px] font-medium text-[#97FCE4]">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#97FCE4]" />
              Hyperliquid
            </span>
          </div>
        </header>

        <svg
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className="block h-auto w-full"
          role="img"
          aria-label="An illustrative price chart with long, short and flat decision markers"
        >
          <defs>
            <linearGradient id="jv-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ff3b3b" stopOpacity="0.28" />
              <stop offset="55%" stopColor="#ff3b3b" stopOpacity="0.06" />
              <stop offset="100%" stopColor="#ff3b3b" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="jv-line" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#ffb84d" />
              <stop offset="100%" stopColor="#ff3b3b" />
            </linearGradient>
            <clipPath id="jv-area-clip">
              <path d={AREA} />
            </clipPath>
          </defs>

          {/* Baseline grid. */}
          {[0, 1, 2, 3].map((row) => (
            <line
              key={row}
              x1={PAD_X}
              x2={VIEW_W - PAD_X}
              y1={TOP + row * ((BOTTOM - TOP) / 3)}
              y2={TOP + row * ((BOTTOM - TOP) / 3)}
              stroke="#f6e9ea"
              strokeOpacity="0.05"
              strokeDasharray="2 6"
            />
          ))}

          {/* Fill, wiped in behind the stroke. */}
          <g clipPath="url(#jv-area-clip)">
            <rect
              x="0"
              y="0"
              width={VIEW_W}
              height={VIEW_H}
              fill="url(#jv-area)"
              className="jv-fade-up"
              style={{ animationDelay: "1.2s", animationDuration: "1.6s" }}
            />
          </g>

          <path
            ref={lineRef}
            d={LINE}
            fill="none"
            stroke="url(#jv-line)"
            strokeWidth="2.5"
            strokeLinecap="round"
            className="jv-draw"
          />

          {MARKERS.map(({ index, direction }) => {
            const point = POINTS[index];
            const style = DIRECTION_STYLE[direction];
            const above = direction !== "short";
            const labelY = above ? point.y - 22 : point.y + 30;
            return (
              <g
                key={index}
                className="jv-pop"
                style={{ animationDelay: `${0.9 + index * 0.09}s` }}
              >
                <line
                  x1={point.x}
                  x2={point.x}
                  y1={point.y}
                  y2={above ? point.y - 14 : point.y + 14}
                  stroke={style.stroke}
                  strokeOpacity="0.45"
                  strokeWidth="1"
                />
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="4.5"
                  fill="#0f0a0b"
                  stroke={style.stroke}
                  strokeWidth="2"
                />
                <text
                  x={point.x}
                  y={labelY}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  letterSpacing="0.09em"
                  fill={style.fill}
                  fillOpacity="0.9"
                >
                  {style.label}
                </text>
              </g>
            );
          })}

          {/* Leading edge — where the next decision lands. */}
          <g className="jv-pop" style={{ animationDelay: "2.5s" }}>
            <circle
              cx={LAST.x}
              cy={LAST.y}
              r="5"
              fill="none"
              stroke="#ffb84d"
              strokeWidth="1.5"
              className="jv-ripple"
            />
            <circle cx={LAST.x} cy={LAST.y} r="4.5" fill="#ffb84d" />
          </g>
        </svg>

        <footer className="grid grid-cols-3 divide-x divide-surface-1 border-t border-surface-1 text-center">
          {[
            { label: "Direction", value: "long", tone: "text-emerald-400" },
            { label: "Confidence", value: "0.72", tone: "text-text" },
            { label: "Interval", value: "5m", tone: "text-text" },
          ].map((stat) => (
            <div key={stat.label} className="px-4 py-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-subtext-0">
                {stat.label}
              </div>
              <div
                className={`mt-0.5 text-sm font-semibold tracking-tight ${stat.tone}`}
              >
                {stat.value}
              </div>
            </div>
          ))}
        </footer>
      </div>

      {/* Floating chips — the two axes, stated without words. */}
      <div
        className="jv-float absolute -left-4 top-1/3 hidden rounded-xl border border-surface-1 bg-mantle/90 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur lg:block"
        style={{ animationDelay: "0.8s" }}
      >
        <div className="text-[10px] font-medium uppercase tracking-wider text-subtext-0">
          Decision maker
        </div>
        <div className="text-xs font-semibold text-text">Jev</div>
      </div>
      <div
        className="jv-float absolute -right-4 bottom-20 hidden rounded-xl border border-surface-1 bg-mantle/90 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur lg:block"
        style={{ animationDelay: "2.4s" }}
      >
        <div className="text-[10px] font-medium uppercase tracking-wider text-subtext-0">
          Wallet adapter
        </div>
        <div className="text-xs font-semibold text-[#97FCE4]">Hyperliquid</div>
      </div>
    </div>
  );
}
