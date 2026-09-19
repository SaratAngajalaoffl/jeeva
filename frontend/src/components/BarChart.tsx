"use client";

import {
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Bar {
  label: string;
  value: number;
}

interface BarChartProps {
  title: string;
  unit?: string;
  bars: Bar[];
}

const BAR_COLOR = "#ff3b3b";
const GRIDLINE_COLOR = "#33191d";
const MUTED_TEXT = "#c29a9d";
const PRIMARY_TEXT = "#f6e9ea";

export default function BarChart({ title, unit, bars }: BarChartProps) {
  if (bars.length === 0) {
    return (
      <div className="rounded-xl border border-surface-1 bg-surface-0/60 p-4">
        <h3 className="mb-2 text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
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
      <div role="img" aria-label={title} className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart
            data={bars}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <CartesianGrid stroke={GRIDLINE_COLOR} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: MUTED_TEXT, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              width={40}
              tick={{ fill: MUTED_TEXT, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: "rgba(255, 59, 59, 0.08)" }}
              contentStyle={{
                background: "#150d0f",
                border: "1px solid #452127",
                borderRadius: 8,
                color: PRIMARY_TEXT,
                fontSize: 12,
              }}
              labelStyle={{ color: MUTED_TEXT }}
              formatter={(value) => [
                `${Number(value).toLocaleString()}${unit ?? ""}`,
                title,
              ]}
            />
            <Bar dataKey="value" fill={BAR_COLOR} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
