"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, TOOLTIP_STYLE } from "@/lib/viz";

interface StackedBarChartProps {
  /** Fixed, ordered series keys — colour is assigned by identity, not by value. */
  series: { key: string; label: string; color: string }[];
  /** One row per x-axis category; values keyed by series key. */
  data: { label: string; [seriesKey: string]: number | string }[];
  height?: number;
  emptyLabel?: string;
}

/**
 * Stacked counts over time. Segments are separated by a 2px stroke in the
 * surface colour — the gap, not a contrasting outline, is what keeps
 * neighbouring fills readable.
 */
export default function StackedBarChart({
  series,
  data,
  height = 240,
  emptyLabel = "No data yet.",
}: StackedBarChartProps) {
  const hasData = data.some((row) =>
    series.some((s) => Number(row[s.key] ?? 0) > 0),
  );

  if (!hasData) {
    return <p className="text-sm text-subtext-1">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {series.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-subtext-0">{s.label}</span>
          </li>
        ))}
      </ul>
      <div role="img" aria-label="Stacked counts over time" style={{ height }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={CHART.grid} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: CHART.mutedText, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              minTickGap={16}
            />
            <YAxis
              width={32}
              tick={{ fill: CHART.mutedText, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(255, 59, 59, 0.06)" }}
              contentStyle={TOOLTIP_STYLE}
              labelStyle={{ color: CHART.mutedText }}
              formatter={(value, key) => {
                const s = series.find((entry) => entry.key === key);
                return [String(value), s?.label ?? String(key)];
              }}
            />
            {series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.key}
                stackId="stack"
                fill={s.color}
                stroke={CHART.surface}
                strokeWidth={2}
                maxBarSize={24}
                isAnimationActive={false}
                radius={i === series.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
