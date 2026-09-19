"use client";

import { useEffect, useState } from "react";
import {
  fetchEngineMode,
  setEngineMode,
  type EngineMode,
  type EngineModeStatus,
} from "@/lib/api";
import { Button, Card } from "@/components/ui";

/**
 * The engine-wide mock/live switch. Deliberately unambiguous about
 * which mode is active (a colored badge, not just button state) since
 * live mode trades real funds with a real private key — see issue #14.
 * Switching applies engine-wide immediately, never per-PERP.
 */
export function EngineModeSwitch() {
  const [status, setStatus] = useState<EngineModeStatus | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    fetchEngineMode()
      .then(setStatus)
      .catch(() => setError("Failed to load engine mode"));
  }, []);

  async function handleSwitch(target: EngineMode) {
    if (!status || status.mode === target) {
      return;
    }
    if (
      target === "live" &&
      !window.confirm(
        "Switch the engine to LIVE mode? This trades real funds on Hyperliquid using the configured wallet, engine-wide, for every PERP.",
      )
    ) {
      return;
    }

    setError(null);
    setSwitching(true);
    const result = await setEngineMode(target);
    setSwitching(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStatus((prev) => (prev ? { ...prev, mode: result.mode } : prev));
  }

  if (status === undefined && !error) {
    return <p className="text-sm text-subtext-1">Loading engine mode...</p>;
  }
  if (!status) {
    return (
      <p className="text-sm text-destructive">
        {error ?? "Failed to load engine mode"}
      </p>
    );
  }

  const isLive = status.mode === "live";

  return (
    <Card className="max-w-sm">
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-subtext-0">Engine mode</span>
          <span
            data-testid="engine-mode-badge"
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
              isLive
                ? "bg-destructive/20 text-destructive"
                : "bg-emerald-400/15 text-emerald-400"
            }`}
          >
            {isLive ? "Live" : "Mock"}
          </span>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button
            variant={isLive ? "ghost" : "primary"}
            disabled={switching || !isLive}
            onClick={() => handleSwitch("mock")}
          >
            Mock
          </Button>
          <Button
            variant={isLive ? "primary" : "ghost"}
            disabled={switching || isLive}
            onClick={() => handleSwitch("live")}
          >
            Live
          </Button>
        </div>

      </div>
    </Card>
  );
}
