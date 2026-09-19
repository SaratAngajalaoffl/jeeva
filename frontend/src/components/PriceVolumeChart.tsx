"use client";

import { useId, useMemo } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Point {
  x: string;
  y: number;
}

interface PriceVolumeChartProps {
  title: string;
  pricePoints: Point[];
  /** Cumulative volume samples; the chart derives the per-interval delta. */
  volumePoints: Point[];
}

const PRICE_COLOR = "#ff3b3b";
const VOLUME_UP_COLOR = "#4ade80";
const VOLUME_DOWN_COLOR = "#ff6b6b";
const GRIDLINE_COLOR = "#33191d";
const MUTED_TEXT = "#c29a9d";
const PRIMARY_TEXT = "#f6e9ea";

// Volume bars are drawn on their own y-axis with a domain several times
// taller than the tallest bar, so they only occupy a thin band at the
// bottom of the shared pane instead of the full chart height.
const VOLUME_DOMAIN_MULTIPLIER = 4.5;

export default function PriceVolumeChart({
  title,
  pricePoints,
  volumePoints,
}: PriceVolumeChartProps) {
  const gradientId = useId();

  const data = useMemo(() => {
    const volumeByX = new Map(volumePoints.map((p) => [p.x, p.y]));
    let previousCumulative: number | null = null;
    let previousPrice: number | null = null;
    return pricePoints.map((p) => {
      const cumulative = volumeByX.get(p.x) ?? null;
      const intervalVolume =
        cumulative === null || previousCumulative === null
          ? 0
          : Math.max(cumulative - previousCumulative, 0);
      if (cumulative !== null) previousCumulative = cumulative;
      const up = previousPrice === null ? true : p.y >= previousPrice;
      previousPrice = p.y;
      return { x: p.x, price: p.y, volume: intervalVolume, up };
    });
  }, [pricePoints, volumePoints]);

  const maxVolume = Math.max(...data.map((d) => d.volume), 1);

  if (data.length === 0) {
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
    <div className="flex h-full flex-col rounded-xl border border-surface-1 bg-surface-0/60 p-4">
      <h3 className="mb-4 text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
        {title}
      </h3>
      <div className="min-h-0 flex-1" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={PRICE_COLOR} stopOpacity={0.3} />
                <stop offset="100%" stopColor={PRICE_COLOR} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={GRIDLINE_COLOR} vertical={false} />
            <XAxis
              dataKey="x"
              tick={{ fill: MUTED_TEXT, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: string) =>
                new Date(value).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              }
              minTickGap={40}
            />
            <YAxis
              yAxisId="price"
              domain={([min, max]: readonly [number, number]) => {
                const padding = (max - min) * 0.3 || max * 0.01 || 1;
                return [min - padding, max + padding];
              }}
              width={64}
              tick={{ fill: MUTED_TEXT, fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => value.toLocaleString()}
            />
            <YAxis
              yAxisId="volume"
              hide
              domain={[0, maxVolume * VOLUME_DOMAIN_MULTIPLIER]}
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
              formatter={(value, key) =>
                key === "volume"
                  ? [Number(value).toLocaleString(), "Volume"]
                  : [`$${Number(value).toLocaleString()}`, "Price"]
              }
            />
            <Bar
              yAxisId="volume"
              dataKey="volume"
              fillOpacity={0.7}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell
                  key={d.x}
                  fill={d.up ? VOLUME_UP_COLOR : VOLUME_DOWN_COLOR}
                />
              ))}
            </Bar>
            <Area
              yAxisId="price"
              type="monotone"
              dataKey="price"
              stroke={PRICE_COLOR}
              strokeWidth={2}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={false}
              activeDot={{ r: 4, fill: PRICE_COLOR, stroke: "#150d0f", strokeWidth: 2 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
