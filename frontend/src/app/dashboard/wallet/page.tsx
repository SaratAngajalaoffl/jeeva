"use client";

import { useEffect, useState } from "react";
import { createMockWallet, fetchMockWallet, type MockWallet } from "@/lib/api";

export default function WalletPage() {
  const [wallet, setWallet] = useState<MockWallet | null | undefined>(
    undefined,
  );
  const [initialBalance, setInitialBalance] = useState("10000");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchMockWallet()
      .then(setWallet)
      .catch(() => setError("Failed to load mock wallet"));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = Number(initialBalance);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter a positive initial balance");
      return;
    }

    setSubmitting(true);
    const result = await createMockWallet(value);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWallet(result.wallet);
  }

  if (wallet === undefined && !error) {
    return <p className="p-8">Loading...</p>;
  }

  return (
    <main className="flex flex-col gap-4 p-8">
      <h1 className="text-xl font-semibold">Mock wallet</h1>
      {error && <p className="text-red-600">{error}</p>}

      {wallet ? (
        <dl className="grid max-w-sm grid-cols-2 gap-2">
          <dt className="text-sm text-gray-500">Initial balance</dt>
          <dd>{`$${wallet.initialBalanceUsd.toLocaleString()}`}</dd>
          <dt className="text-sm text-gray-500">Current balance</dt>
          <dd>{`$${wallet.currentBalanceUsd.toLocaleString()}`}</dd>
          <dt className="text-sm text-gray-500">All-time P&amp;L</dt>
          <dd>{`$${wallet.allTimePnlUsd.toLocaleString()}`}</dd>
        </dl>
      ) : (
        <form
          onSubmit={handleCreate}
          className="flex max-w-sm flex-col gap-3 rounded border p-4"
        >
          <label className="flex flex-col gap-1">
            <span className="text-sm">Initial balance (USD)</span>
            <input
              type="number"
              min={1}
              className="rounded border px-3 py-2"
              value={initialBalance}
              onChange={(e) => setInitialBalance(e.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
          >
            {submitting ? "Creating..." : "Create wallet"}
          </button>
        </form>
      )}
    </main>
  );
}
