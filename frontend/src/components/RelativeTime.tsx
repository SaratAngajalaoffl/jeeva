"use client";

import { useEffect, useState } from "react";
import { formatCountdown, formatDuration, timeAgo } from "@/lib/format";

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

/** How long a session has run: live while it is open, frozen once it closes. */
export function Uptime({
  since,
  until,
  className = "",
}: {
  since: string;
  until: string | null;
  className?: string;
}) {
  const now = useTick(1000);
  const end = until ? new Date(until).getTime() : now;
  return (
    <span
      className={className}
      title={`Started ${new Date(since).toLocaleString()}${
        until ? ` · closed ${new Date(until).toLocaleString()}` : ""
      }`}
    >
      {formatDuration(end - new Date(since).getTime())}
    </span>
  );
}
