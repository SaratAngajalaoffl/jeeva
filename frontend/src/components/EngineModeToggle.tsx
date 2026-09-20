"use client";

import { useEffect, useState } from "react";
import {
  fetchEngineMode,
  setEngineMode,
  type EngineMode,
  type EngineModeStatus,
} from "@/lib/api";
import { TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui";

/**
 * Engine mode switch for the sidebar. Confirms before switching to live
 * since live mode trades real funds engine-wide — see issue #14.
 */
export function EngineModeToggle() {
  const [status, setStatus] = useState<EngineModeStatus | null | undefined>(
    undefined,
  );
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetchEngineMode()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  async function handleToggle() {
    if (!status || switching) return;
    const target: EngineMode = status.mode === "live" ? "mock" : "live";
    if (
      target === "live" &&
      !window.confirm(
        "Switch the engine to LIVE mode? This trades real funds on Hyperliquid using the configured wallet, engine-wide, for every PERP.",
      )
    ) {
      return;
    }
    setSwitching(true);
    const result = await setEngineMode(target);
    setSwitching(false);
    if (result.ok) {
      setStatus((prev) => (prev ? { ...prev, mode: result.mode } : prev));
    }
  }

  if (status === undefined) {
    return <Skeleton className="h-6 w-full" />;
  }
  if (!status) {
    return null;
  }

  if (status.paperTradingOnly) {
    return (
      <div
        role="note"
        title="This deployment runs in paper-trading mode; live trading and real wallets are disabled"
        className="flex items-center gap-2 rounded-md border border-peach/50 bg-peach/10 px-3 py-1.5 text-sm text-peach"
      >
        <TriangleAlert size={14} className="shrink-0" />
        <span>Paper trading only</span>
      </div>
    );
  }

  const isLive = status.mode === "live";

  return (
    <button
      type="button"
      onClick={handleToggle}
      disabled={switching}
      aria-pressed={isLive}
      title={isLive ? "Live trading enabled" : "Live trading disabled"}
      className="flex items-center justify-between gap-2 rounded-md border border-surface-1 px-3 py-1.5 text-sm text-subtext-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span>Live trading</span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          isLive ? "bg-destructive" : "bg-surface-2"
        }`}
      >
        <span
          className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
          style={{ transform: isLive ? "translateX(18px)" : "translateX(4px)" }}
        />
      </span>
    </button>
  );
}
