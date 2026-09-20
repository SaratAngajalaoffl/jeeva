"use client";

import { CHART } from "@/lib/viz";

export interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Shown in the legend and the hover title instead of the raw number. */
  display?: string;
}

/**
 * A part-to-whole meter: one row of stacked segments plus a legend.
 *
 * Segments are separated by a 2px gap in the surface colour rather than a
 * stroke, so neighbouring fills stay distinct without adding ink that
 * isn't data. Every segment is also named and valued in the legend, so
 * the bar never relies on colour alone.
 */
export default function SegmentedBar({
  segments,
  height = 10,
  emptyLabel = "Nothing to show yet.",
}: {
  segments: Segment[];
  height?: number;
  emptyLabel?: string;
}) {
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, s) => sum + s.value, 0);

  if (total <= 0) {
    return <p className="text-sm text-subtext-1">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div
        className="flex w-full overflow-hidden rounded-full"
        style={{ height, backgroundColor: CHART.grid, gap: 2 }}
        role="img"
        aria-label={visible
          .map((s) => `${s.label}: ${s.display ?? s.value}`)
          .join(", ")}
      >
        {visible.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${s.display ?? s.value}`}
            className="h-full first:rounded-l-full last:rounded-r-full transition-[width] duration-500"
            style={{
              width: `${(s.value / total) * 100}%`,
              backgroundColor: s.color,
            }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-subtext-0">{s.label}</span>
            <span className="font-medium text-text tabular-nums">
              {s.display ?? s.value.toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
