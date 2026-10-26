"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

/**
 * Confirms turning sampling off for a market that still has open trading
 * sessions: no market may be traded without fresh price history, so the
 * API hard-closes (force-flattens) every one of them.
 */
export function DisableSamplingConfirm({
  symbol,
  openSessionCount,
  onCancel,
  onConfirm,
}: {
  symbol: string;
  openSessionCount: number;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const sessions =
    openSessionCount === 1 ? "1 open session" : `${openSessionCount} open sessions`;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-subtext-1">
        {symbol} has {sessions}. A market can&apos;t be traded without
        sampling, so disabling it will hard-close{" "}
        {openSessionCount === 1 ? "that session" : "every one of them"},
        flattening any open position immediately.
      </p>
      <div className="mt-1 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          loading={submitting}
          onClick={async () => {
            setSubmitting(true);
            try {
              await onConfirm();
            } finally {
              setSubmitting(false);
            }
          }}
        >
          Disable and close sessions
        </Button>
      </div>
    </div>
  );
}
