"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CHART, TOOLTIP_STYLE } from "@/lib/viz";

interface Slice {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  slices: Slice[];
  /** Sits in the hole, under the total. */
  totalLabel?: string;
  emptyLabel?: string;
}

/**
 * Part-to-whole at a glance. Slice order is the caller's, because it is
 * what keeps two poles of a diverging scale from sitting next to each
 * other; every slice is also named and counted in the legend.
 */
export default function DonutChart({
  slices,
  totalLabel = "total",
  emptyLabel = "No data yet.",
}: DonutChartProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  if (total === 0) {
    return <p className="text-sm text-subtext-1">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-1 items-center gap-5">
      <div role="img" aria-label={totalLabel} className="relative h-56 w-56 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              innerRadius="66%"
              outerRadius="100%"
              paddingAngle={2}
              stroke="none"
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.label} fill={s.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={TOOLTIP_STYLE}
              formatter={(value, name) => [
                `${value} (${((Number(value) / total) * 100).toFixed(0)}%)`,
                String(name),
              ]}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tracking-tight text-text">
            {total.toLocaleString()}
          </span>
          <span className="text-[10px]" style={{ color: CHART.mutedText }}>
            {totalLabel}
          </span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span
              aria-hidden
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-subtext-0">{s.label}</span>
            <span className="ml-auto font-medium tabular-nums text-text">
              {s.value.toLocaleString()}
            </span>
            <span className="w-10 text-right tabular-nums text-subtext-0">
              {((s.value / total) * 100).toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
