"use client";

import { useMemo, useState } from "react";

interface Point {
  x: string;
  y: number;
}

interface LineChartProps {
  title: string;
  unit?: string;
  points: Point[];
}

const WIDTH = 640;
const HEIGHT = 200;
const PADDING = 32;

// Single-series chart: one hue (categorical slot 1, blue) is enough —
// a legend would be redundant since the title already names the series.
const SERIES_COLOR = "#2a78d6";
const GRIDLINE_COLOR = "#e1e0d9";
const AXIS_COLOR = "#c3c2b7";
const MUTED_TEXT = "#898781";
const PRIMARY_TEXT = "#0b0b0b";

export default function LineChart({ title, unit, points }: LineChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { path, coords, minY, maxY } = useMemo(() => {
    if (points.length === 0) {
      return { path: "", coords: [] as [number, number][], minY: 0, maxY: 0 };
    }
    const values = points.map((p) => p.y);
    const minY = Math.min(...values);
    const maxY = Math.max(...values);
    const range = maxY - minY || 1;
    const innerWidth = WIDTH - PADDING * 2;
    const innerHeight = HEIGHT - PADDING * 2;

    const coords: [number, number][] = points.map((p, i) => {
      const x =
        PADDING +
        (points.length === 1 ? 0 : (i / (points.length - 1)) * innerWidth);
      const y = PADDING + innerHeight - ((p.y - minY) / range) * innerHeight;
      return [x, y];
    });

    const path = coords
      .map(
        ([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`,
      )
      .join(" ");

    return { path, coords, minY, maxY };
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="rounded border p-4">
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

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoveredCoord = hoverIndex !== null ? coords[hoverIndex] : null;

  return (
    <div className="rounded border p-4">
      <h3 className="mb-2 text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
        {title}
      </h3>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${title} over time`}
        className="w-full"
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const svg = e.currentTarget;
          const rect = svg.getBoundingClientRect();
          const relativeX = ((e.clientX - rect.left) / rect.width) * WIDTH;
          let closest = 0;
          let closestDist = Infinity;
          coords.forEach(([x], i) => {
            const dist = Math.abs(x - relativeX);
            if (dist < closestDist) {
              closestDist = dist;
              closest = i;
            }
          });
          setHoverIndex(closest);
        }}
      >
        {/* recessive gridlines */}
        {[0, 0.5, 1].map((t) => {
          const y = PADDING + t * (HEIGHT - PADDING * 2);
          return (
            <line
              key={t}
              x1={PADDING}
              x2={WIDTH - PADDING}
              y1={y}
              y2={y}
              stroke={GRIDLINE_COLOR}
              strokeWidth={1}
            />
          );
        })}
        <line
          x1={PADDING}
          x2={WIDTH - PADDING}
          y1={HEIGHT - PADDING}
          y2={HEIGHT - PADDING}
          stroke={AXIS_COLOR}
          strokeWidth={1}
        />

        <path
          d={path}
          fill="none"
          stroke={SERIES_COLOR}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {hoveredCoord && (
          <>
            <line
              x1={hoveredCoord[0]}
              x2={hoveredCoord[0]}
              y1={PADDING}
              y2={HEIGHT - PADDING}
              stroke={AXIS_COLOR}
              strokeWidth={1}
              strokeDasharray="2,2"
            />
            <circle
              cx={hoveredCoord[0]}
              cy={hoveredCoord[1]}
              r={4}
              fill={SERIES_COLOR}
              stroke="#fcfcfb"
              strokeWidth={2}
            />
          </>
        )}

        <text x={PADDING} y={PADDING - 8} fontSize={10} fill={MUTED_TEXT}>
          {maxY.toLocaleString()}
        </text>
        <text
          x={PADDING}
          y={HEIGHT - PADDING + 14}
          fontSize={10}
          fill={MUTED_TEXT}
        >
          {minY.toLocaleString()}
        </text>
      </svg>
      {hovered && (
        <p className="mt-1 text-xs" style={{ color: MUTED_TEXT }}>
          {new Date(hovered.x).toLocaleString()}:{" "}
          <span style={{ color: PRIMARY_TEXT }}>
            {hovered.y.toLocaleString()}
            {unit ? ` ${unit}` : ""}
          </span>
        </p>
      )}
    </div>
  );
}
