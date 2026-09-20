"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, TOOLTIP_STYLE } from "@/lib/viz";

export interface PerformanceSeriesSpec {
  key: string;
  label: string;
  color: string;
}

interface Row {
  t: number;
  [symbol: string]: number | undefined;
}

/**
 * Several markets on one axis, each rebased to 100 at the start of the
 * window. Markets priced in the tens and in the tens of thousands can
 * then share a scale honestly — the alternative, a second y-axis, invents
 * a relationship between the two scales that isn't in the data.
 *
 * Each series' current value rides the legend rather than the line end,
 * so identity never depends on matching a colour and labels can't collide
 * where lines converge.
 */
export default function PerformanceChart({
  series,
  rows,
  height = 260,
}: {
  series: PerformanceSeriesSpec[];
  rows: Row[];
  height?: number;
}) {
  if (series.length === 0 || rows.length === 0) {
    return (
      <p className="text-sm text-subtext-1">
        No sampled market history in this window yet.
      </p>
    );
  }

  const last = rows[rows.length - 1];
  const formatTime = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
        {series.map((s) => {
          const value = last[s.key];
          const changePct = value === undefined ? null : value - 100;
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <span className="font-medium text-text">{s.label}</span>
              <span
                className={`tabular-nums ${
                  changePct === null
                    ? "text-subtext-0"
                    : changePct >= 0
                      ? "text-emerald-400"
                      : "text-destructive"
                }`}
              >
                {changePct === null
                  ? "-"
                  : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}
              </span>
            </li>
          );
        })}
      </ul>

      <div
        role="img"
        aria-label="Sampled market performance, indexed to 100 at the start of the window"
        style={{ height }}
        className="w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: CHART.mutedText, fontSize: 10 }}
              tickFormatter={formatTime}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={["auto", "auto"]}
              width={46}
              tick={{ fill: CHART.mutedText, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v: number) => v.toFixed(1)}
            />
            <ReferenceLine
              y={100}
              stroke={CHART.grid}
              strokeWidth={1}
              label={{
                value: "base",
                position: "insideTopLeft",
                fill: CHART.mutedText,
                fontSize: 10,
              }}
            />
            <Tooltip
              cursor={{ stroke: CHART.tooltipBorder, strokeWidth: 1 }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: CHART.mutedText }}
              labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
              formatter={(value, key) => [
                `${Number(value).toFixed(2)} (${
                  Number(value) >= 100 ? "+" : ""
                }${(Number(value) - 100).toFixed(2)}%)`,
                String(key),
              ]}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                dot={false}
                connectNulls
                activeDot={{
                  r: 4,
                  fill: s.color,
                  stroke: CHART.surface,
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
