"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

interface Slice {
  label: string;
  value: number;
  color: string;
}

interface DonutChartProps {
  title: string;
  slices: Slice[];
}

const MUTED_TEXT = "#c29a9d";
const PRIMARY_TEXT = "#f6e9ea";

export default function DonutChart({ title, slices }: DonutChartProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="rounded-xl border border-surface-1 bg-surface-0/60 p-4">
      <h3 className="mb-2 text-sm font-medium" style={{ color: PRIMARY_TEXT }}>
        {title}
      </h3>
      {total === 0 ? (
        <p className="text-sm" style={{ color: MUTED_TEXT }}>
          No data yet.
        </p>
      ) : (
        <div className="flex items-center gap-4">
          <div
            role="img"
            aria-label={title}
            className="relative h-40 w-40 shrink-0"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  innerRadius="65%"
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
                  contentStyle={{
                    background: "#150d0f",
                    border: "1px solid #452127",
                    borderRadius: 8,
                    color: PRIMARY_TEXT,
                    fontSize: 12,
                  }}
                  formatter={(value, name) => [String(value), String(name)]}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-semibold" style={{ color: PRIMARY_TEXT }}>
                {total}
              </span>
              <span className="text-[9px]" style={{ color: MUTED_TEXT }}>
                total
              </span>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5 text-xs">
            {slices.map((s) => (
              <li key={s.label} className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span style={{ color: MUTED_TEXT }}>{s.label}</span>
                <span className="ml-auto font-medium" style={{ color: PRIMARY_TEXT }}>
                  {s.value}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
