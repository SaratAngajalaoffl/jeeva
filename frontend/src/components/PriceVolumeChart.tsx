"use client";

import { ChartCandlestick, X } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { useId, useMemo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  ReferenceArea,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatSelectionBound(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function RangeHeader({
  title,
  range,
  onRangeChange,
  oldestSampleTime,
  selection,
  onClearSelection,
}: {
  title: string;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  oldestSampleTime?: string | null;
  selection?: ChartSelection | null;
  onClearSelection?: () => void;
}) {
  // A period is unusable if even its most recent possible window would
  // still reach back before the first recorded sample. "All" never is.
  const oldestMs = oldestSampleTime ? Date.parse(oldestSampleTime) : null;
  const available = (r: (typeof CHART_RANGES)[number]) =>
    r.value === "all" || oldestMs === null || Date.now() - r.ms >= oldestMs;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
          {title}
        </h3>
        {selection && onClearSelection && (
          <button
            type="button"
            onClick={onClearSelection}
            title="Clear selection"
            className="inline-flex items-center gap-1 rounded-full border border-ember/40 bg-ember/10 px-2 py-0.5 text-xs text-ember transition-colors hover:bg-ember/20"
          >
            {formatSelectionBound(selection.from)} –{" "}
            {formatSelectionBound(selection.to)}
            <X className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>
      <div
        role="group"
        aria-label="Time period"
        className="flex items-center gap-0.5 rounded-md border border-surface-1 p-0.5"
      >
        {CHART_RANGES.map((r) => {
          // Never disable the selected option, so the UI can't end up
          // with an unselectable active pill.
          const enabled = range === r.value || available(r);
          return (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              disabled={!enabled}
              title={enabled ? undefined : `Not enough ${title.toLowerCase()} history`}
              onClick={() => onRangeChange(r.value)}
              style={{ color: MUTED_TEXT }}
              className={`rounded px-2 py-0.5 text-xs transition-colors ${
                enabled ? "hover:text-white" : "cursor-not-allowed opacity-40"
              } ${range === r.value ? "bg-surface-2 text-white" : ""}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface Point {
  x: string;
  y: number;
}

/** A long/short entry or exit to plot on the price line. */
export interface TradeMarker {
  time: string;
  direction: "long" | "short";
  action: "open" | "close";
  /** Marker price; falls back to the nearest price sample when omitted. */
  price?: number;
}

export type ChartRange = "1h" | "1d" | "1w" | "1m" | "3m" | "all";

/** A sub-window of the plotted samples, picked by dragging across the chart. */
export interface ChartSelection {
  from: string;
  to: string;
}

const CHART_RANGES: { value: ChartRange; label: string; ms: number }[] = [
  { value: "1h", label: "1H", ms: 60 * 60 * 1000 },
  { value: "1d", label: "1D", ms: 24 * 60 * 60 * 1000 },
  { value: "1w", label: "1W", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "1m", label: "1M", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "3m", label: "3M", ms: 90 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All", ms: Infinity },
];

/** Start of the window a range covers, ending now; the epoch for "all". */
export function chartRangeFrom(range: ChartRange): Date {
  const ms = CHART_RANGES.find((r) => r.value === range)?.ms ?? 0;
  return Number.isFinite(ms) ? new Date(Date.now() - ms) : new Date(0);
}

interface PriceVolumeChartProps {
  title: string;
  pricePoints: Point[];
  /** Cumulative volume samples; the chart derives the per-interval delta. */
  volumePoints: Point[];
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  /** Earliest recorded sample; periods reaching back before it are disabled. */
  oldestSampleTime?: string | null;
  /** Long/short entries and exits to mark on the price line. */
  markers?: TradeMarker[];
  /** Zooms the chart to this window; null shows the whole range. */
  selection?: ChartSelection | null;
  /** Enables drag-to-select; called with null when the selection is cleared. */
  onSelectionChange?: (selection: ChartSelection | null) => void;
}

const PRICE_COLOR = "#ff3b3b";
const VOLUME_UP_COLOR = "#4ade80";
const VOLUME_DOWN_COLOR = "#ff6b6b";
const GRIDLINE_COLOR = "#33191d";
const MUTED_TEXT = "#c29a9d";
const PRIMARY_TEXT = "#f6e9ea";
const BUY_COLOR = "#4ade80";
const SELL_COLOR = "#ff6b6b";

/** Opening a long or closing a short both amount to a market buy, and vice versa. */
function isBuy(marker: TradeMarker): boolean {
  return (
    (marker.action === "open" && marker.direction === "long") ||
    (marker.action === "close" && marker.direction === "short")
  );
}

function MarkerShape({ cx, cy, buy }: { cx?: number; cy?: number; buy: boolean }) {
  if (cx === undefined || cy === undefined) return null;
  const color = buy ? BUY_COLOR : SELL_COLOR;
  const size = 6;
  const points = buy
    ? `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`
    : `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
  return (
    <polygon
      points={points}
      fill={color}
      stroke="#150d0f"
      strokeWidth={1}
    />
  );
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Picks tick labels from how much time the plotted samples actually span:
 * clock time within a day, date plus time over a few days, dates beyond.
 */
function axisTickFormatter(spanMs: number) {
  return (value: string) => {
    const date = new Date(value);
    if (spanMs <= 36 * HOUR_MS) {
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (spanMs <= 7 * 24 * HOUR_MS) {
      return date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  };
}
// Volume bars are drawn on their own y-axis with a domain several times
// taller than the tallest bar, so they only occupy a thin band at the
// bottom of the shared pane instead of the full chart height.
const VOLUME_DOMAIN_MULTIPLIER = 4.5;

export default function PriceVolumeChart({
  title,
  pricePoints,
  volumePoints,
  range,
  onRangeChange,
  oldestSampleTime = null,
  markers = [],
  selection = null,
  onSelectionChange,
}: PriceVolumeChartProps) {
  const gradientId = useId();
  const [drag, setDrag] = useState<{ start: string; end: string } | null>(
    null,
  );

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

  // Volume deltas are derived over the full series above, so zooming in
  // never turns the first visible sample into a zero-volume bar.
  const visibleData = useMemo(() => {
    if (!selection) return data;
    const fromMs = Date.parse(selection.from);
    const toMs = Date.parse(selection.to);
    return data.filter((d) => {
      const ms = Date.parse(d.x);
      return ms >= fromMs && ms <= toMs;
    });
  }, [data, selection]);

  const maxVolume = Math.max(...visibleData.map((d) => d.volume), 1);
  const spanMs =
    visibleData.length > 1
      ? Date.parse(visibleData[visibleData.length - 1].x) -
        Date.parse(visibleData[0].x)
      : 0;

  // Snap each marker onto the nearest plotted sample so it lands on the line
  // even when its own timestamp doesn't exactly match a sample.
  const plottedMarkers = useMemo(() => {
    if (markers.length === 0 || visibleData.length === 0) return [];
    const firstMs = Date.parse(visibleData[0].x);
    const lastMs = Date.parse(visibleData[visibleData.length - 1].x);
    // Markers outside the visible window would otherwise snap onto its edges.
    const inView = selection
      ? markers.filter((m) => {
          const ms = Date.parse(m.time);
          return ms >= firstMs && ms <= lastMs;
        })
      : markers;
    return inView.map((marker) => {
      const markerMs = Date.parse(marker.time);
      let nearest = visibleData[0];
      let nearestDiff = Math.abs(Date.parse(nearest.x) - markerMs);
      for (const point of visibleData) {
        const diff = Math.abs(Date.parse(point.x) - markerMs);
        if (diff < nearestDiff) {
          nearest = point;
          nearestDiff = diff;
        }
      }
      return { marker, x: nearest.x, y: marker.price ?? nearest.price };
    });
  }, [markers, visibleData, selection]);

  function finishDrag() {
    if (drag && drag.start !== drag.end && onSelectionChange) {
      const [from, to] =
        Date.parse(drag.start) <= Date.parse(drag.end)
          ? [drag.start, drag.end]
          : [drag.end, drag.start];
      onSelectionChange({ from, to });
    }
    setDrag(null);
  }

  const header = (
    <RangeHeader
      title={title}
      range={range}
      onRangeChange={onRangeChange}
      oldestSampleTime={oldestSampleTime}
      selection={selection}
      onClearSelection={
        onSelectionChange ? () => onSelectionChange(null) : undefined
      }
    />
  );

  if (visibleData.length === 0) {
    return (
      <div className="flex h-full flex-col rounded-xl border border-surface-1 bg-surface-0/60 p-4">
        {header}
        <EmptyState
          icon={ChartCandlestick}
          title="No data in the selected period."
          description="Try a wider range, or check back once the market has been sampled."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-surface-1 bg-surface-0/60 p-4">
      {header}
      <div
        className={`min-h-0 flex-1 ${onSelectionChange ? "cursor-crosshair select-none" : ""}`}
        role="img"
        aria-label={title}
        title={
          onSelectionChange && !selection
            ? "Drag across the chart to zoom into a period"
            : undefined
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={visibleData}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
            onMouseDown={(state) => {
              const label = state?.activeLabel;
              if (onSelectionChange && label !== undefined) {
                setDrag({ start: String(label), end: String(label) });
              }
            }}
            onMouseMove={(state) => {
              const label = state?.activeLabel;
              if (drag && label !== undefined) {
                setDrag({ ...drag, end: String(label) });
              }
            }}
            onMouseUp={finishDrag}
            onMouseLeave={() => setDrag(null)}
          >
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
              tickFormatter={axisTickFormatter(spanMs)}
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
              itemStyle={{ color: PRIMARY_TEXT }}
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
              {visibleData.map((d) => (
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
            {plottedMarkers.map(({ marker, x, y }, i) => (
              <ReferenceDot
                key={`${marker.time}-${i}`}
                yAxisId="price"
                x={x}
                y={y}
                r={6}
                shape={(props: { cx?: number; cy?: number }) => (
                  <MarkerShape cx={props.cx} cy={props.cy} buy={isBuy(marker)} />
                )}
                ifOverflow="visible"
              />
            ))}
            {drag && drag.start !== drag.end && (
              <ReferenceArea
                yAxisId="price"
                x1={drag.start}
                x2={drag.end}
                fill={PRICE_COLOR}
                fillOpacity={0.12}
                stroke={PRICE_COLOR}
                strokeOpacity={0.4}
                ifOverflow="visible"
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
