"use client";

import { useEffect, useState } from "react";
import { formatCountdown, timeAgo } from "@/lib/format";

/**
 * Self-ticking clocks. They keep their own interval so a second-by-second
 * readout never re-renders the charts around them.
 */
function useTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function TimeAgo({
  iso,
  className = "",
}: {
  iso: string | null;
  className?: string;
}) {
  const now = useTick(1000);
  if (!iso) return <span className={className}>never</span>;
  return (
    <span className={className} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso, now)}
    </span>
  );
}

export function Countdown({
  iso,
  className = "",
}: {
  iso: string | null;
  className?: string;
}) {
  const now = useTick(1000);
  if (!iso) return <span className={className}>-</span>;
  const remaining = new Date(iso).getTime() - now;
  return (
    <span
      className={className}
      title={`Next decision around ${new Date(iso).toLocaleTimeString()}`}
    >
      {formatCountdown(remaining)}
    </span>
  );
}
