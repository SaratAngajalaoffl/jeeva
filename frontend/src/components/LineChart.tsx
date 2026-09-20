"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, TOOLTIP_STYLE } from "@/lib/viz";

interface Point {
  x: string;
  y: number;
}

interface LineChartProps {
  /** Names the series — a single-series chart needs no legend. */
  label: string;
  unit?: string;
  points: Point[];
  color?: string;
  /** Draws a rule at y=0, for series that can cross into the negative. */
  zeroLine?: boolean;
  height?: number;
  emptyLabel?: string;
}

export default function LineChart({
  label,
  unit,
  points,
  color = CHART.accent,
  zeroLine = false,
  height = 200,
  emptyLabel = "No data yet.",
}: LineChartProps) {
  const gradientId = useId();

  if (points.length === 0) {
    return <p className="text-sm text-subtext-1">{emptyLabel}</p>;
  }

  return (
    <div
      role="img"
      aria-label={`${label} over time`}
      className="w-full"
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="x" hide />
          <YAxis
            domain={["auto", "auto"]}
            width={56}
            tick={{ fill: CHART.mutedText, fontSize: 10 }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => value.toLocaleString()}
          />
          {zeroLine && <ReferenceLine y={0} stroke={CHART.grid} strokeWidth={1} />}
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={{ color: CHART.mutedText }}
            labelFormatter={(value) => new Date(String(value)).toLocaleString()}
            formatter={(value) => [
              `${Number(value).toLocaleString()}${unit ? ` ${unit}` : ""}`,
              label,
            ]}
          />
          <Area
            type="monotone"
            dataKey="y"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, fill: color, stroke: CHART.surface, strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
