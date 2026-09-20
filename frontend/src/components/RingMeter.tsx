"use client";

/**
 * A single ratio against its limit, drawn as a ring.
 *
 * The track is a dimmed step of the fill's own colour so the whole ring
 * reads as one scale, and the value is printed in the middle — the colour
 * is decoration on top of a number that is always legible on its own.
 */
export default function RingMeter({
  value,
  max = 100,
  color,
  label,
  caption,
  size = 104,
  thickness = 9,
}: {
  value: number | null;
  max?: number;
  color: string;
  label: string;
  caption?: string;
  size?: number;
  thickness?: number;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = value === null ? 0 : Math.max(0, Math.min(1, value / max));

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={`${label}: ${value === null ? "no data" : `${Math.round(ratio * 100)}%`}`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeOpacity={0.18}
            strokeWidth={thickness}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
            strokeDasharray={`${circumference * ratio} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: "stroke-dasharray 600ms ease-out" }}
          />
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tracking-tight text-text">
            {value === null ? "-" : `${Math.round(ratio * 100)}%`}
          </span>
          {caption && (
            <span className="text-[10px] text-subtext-0">{caption}</span>
          )}
        </div>
      </div>
      <span className="text-center text-xs text-subtext-1">{label}</span>
    </div>
  );
}
