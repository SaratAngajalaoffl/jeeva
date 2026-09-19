"use client";

import { useEffect, useState } from "react";
import {
  createMockWallet,
  fetchFundingPayments,
  fetchMockWallet,
  type FundingPayment,
  type MockWallet,
} from "@/lib/api";

export default function WalletPage() {
  const [wallet, setWallet] = useState<MockWallet | null | undefined>(
    undefined,
  );
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [initialBalance, setInitialBalance] = useState("10000");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchMockWallet()
      .then(setWallet)
      .catch(() => setError("Failed to load mock wallet"));
    fetchFundingPayments()
      .then(setFundingPayments)
      .catch(() => setError("Failed to load funding payments"));
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
    <main className="flex flex-col gap-8 p-8">
      <section>
        <h1 className="mb-2 text-xl font-semibold">Mock wallet</h1>
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
      </section>

      {wallet && (
        <section>
          <h2 className="mb-2 text-lg font-semibold">
            Recent funding payments
          </h2>
          {!fundingPayments ? (
            <p>Loading...</p>
          ) : fundingPayments.length === 0 ? (
            <p>No funding payments yet.</p>
          ) : (
            <table className="w-full max-w-2xl border-collapse text-left text-sm">
              <thead>
                <tr>
                  <th className="border-b py-2">Time</th>
                  <th className="border-b py-2">Symbol</th>
                  <th className="border-b py-2">Direction</th>
                  <th className="border-b py-2">Rate</th>
                  <th className="border-b py-2">Amount (USD)</th>
                </tr>
              </thead>
              <tbody>
                {fundingPayments.map((p, i) => (
                  <tr key={i}>
                    <td className="border-b py-2">
                      {new Date(p.time).toLocaleString()}
                    </td>
                    <td className="border-b py-2">{p.symbol}</td>
                    <td className="border-b py-2">{p.direction}</td>
                    <td className="border-b py-2">
                      {(p.fundingRate * 100).toFixed(4)}%
                    </td>
                    <td className="border-b py-2">{p.amountUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
