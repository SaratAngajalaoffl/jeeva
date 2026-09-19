"use client";

import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Point {
  x: string;
  y: number;
}

interface LineChartProps {
  title: string;
  unit?: string;
  points: Point[];
}

// Single-series chart: one hue (categorical slot 1, ember) is enough —
// a legend would be redundant since the title already names the series.
const SERIES_COLOR = "#ff3b3b";
const GRIDLINE_COLOR = "#33191d";
const MUTED_TEXT = "#c29a9d";
const PRIMARY_TEXT = "#f6e9ea";

export default function LineChart({ title, unit, points }: LineChartProps) {
  const gradientId = useId();

  if (points.length === 0) {
    return (
      <div className="rounded-xl border border-surface-1 bg-surface-0/60 p-4">
        <h3
          className="mb-2 text-sm font-medium"
          style={{ color: PRIMARY_TEXT }}
        >
          {title}
        </h3>
        <p className="text-sm" style={{ color: MUTED_TEXT }}>
          No data yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-surface-1 bg-surface-0/60 p-4">
      <h3 className="mb-2 text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
        {title}
      </h3>
      <div
        role="img"
        aria-label={`${title} over time`}
        className="h-[200px] w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={points}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={SERIES_COLOR} stopOpacity={0.35} />
                <stop offset="100%" stopColor={SERIES_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRIDLINE_COLOR} vertical={false} />
            <XAxis dataKey="x" hide />
            <YAxis
              domain={["auto", "auto"]}
              width={52}
              tick={{ fill: MUTED_TEXT, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => value.toLocaleString()}
            />
            <Tooltip
              contentStyle={{
                background: "#150d0f",
                border: "1px solid #452127",
                borderRadius: 8,
                color: PRIMARY_TEXT,
                fontSize: 12,
              }}
              labelStyle={{ color: MUTED_TEXT }}
              labelFormatter={(value) => new Date(String(value)).toLocaleString()}
              formatter={(value) => [
                `${Number(value).toLocaleString()}${unit ? ` ${unit}` : ""}`,
                title,
              ]}
            />
            <Area
              type="monotone"
              dataKey="y"
              stroke={SERIES_COLOR}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 4, fill: SERIES_COLOR, stroke: "#150d0f", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
