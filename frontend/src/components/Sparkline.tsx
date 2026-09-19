"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip } from "recharts";

interface SparklineProps {
  points: number[];
  color?: string;
  height?: number;
}

export default function Sparkline({
  points,
  color = "#ff3b3b",
  height = 48,
}: SparklineProps) {
  const gradientId = useId();

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-subtext-0"
        style={{ height }}
      >
        No chart data
      </div>
    );
  }

  const data = points.map((value, i) => ({ i, value }));

  return (
    <div
      role="img"
      aria-label="Price sparkline"
      className="w-full"
      style={{ height }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Tooltip
            contentStyle={{
              background: "#150d0f",
              border: "1px solid #452127",
              borderRadius: 8,
              color: "#f6e9ea",
              fontSize: 12,
              padding: "4px 8px",
            }}
            labelFormatter={() => ""}
            formatter={(value) => [
              `$${Number(value).toLocaleString(undefined, {
                maximumFractionDigits: Number(value) < 1 ? 6 : 2,
              })}`,
              "Price",
            ]}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            fill={`url(#${gradientId})`}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 3, fill: color, stroke: "#150d0f", strokeWidth: 1.5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
