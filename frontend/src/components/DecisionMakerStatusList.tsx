"use client";

import { useEffect, useState } from "react";
import {
  fetchDecisionMakerStatuses,
  type DecisionMakerStatus,
} from "@/lib/api";
import { Card, Skeleton } from "@/components/ui";

const POLL_INTERVAL_MS = 30_000;

export function DecisionMakerStatusList() {
  const [statuses, setStatuses] = useState<DecisionMakerStatus[] | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchDecisionMakerStatuses()
        .then((s) => {
          if (!cancelled) setStatuses(s);
        })
        .catch(() => {
          if (!cancelled) setStatuses(null);
        });
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <Card className="flex flex-col gap-3 p-5">
      <h3 className="text-sm font-medium text-text">Decision makers</h3>
      {!statuses ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {statuses.map((s) => {
            const ok = s.configured && s.reachable;
            const detail = ok
              ? "Reachable"
              : s.configured
                ? "Configured, unreachable"
                : "Not configured";
            return (
              <li
                key={s.id}
                className="flex items-center justify-between gap-2 border-b border-surface-1 pb-2 last:border-0 last:pb-0"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      ok ? "bg-emerald-400" : "bg-destructive"
                    }`}
                  />
                  <span className="font-medium text-text">{s.label}</span>
                </span>
                <span
                  className={`text-xs ${ok ? "text-subtext-1" : "text-destructive"}`}
                >
                  {detail}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
