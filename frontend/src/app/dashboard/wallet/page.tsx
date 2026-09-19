"use client";

import { useEffect, useState } from "react";
import {
  createMockWallet,
  fetchFundingPayments,
  fetchMockWallet,
  type FundingPayment,
  type MockWallet,
} from "@/lib/api";
import { SiteHeader } from "@/components/SiteHeader";
import { Button, Card, Input, Label } from "@/components/ui";

const TH = "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

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

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <section>
          <h1 className="mb-3 text-xl font-semibold tracking-tight text-text">
            Mock wallet
          </h1>
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

          {wallet === undefined && !error ? (
            <p className="text-sm text-subtext-1">Loading...</p>
          ) : wallet ? (
            <Card className="max-w-sm">
              <dl className="grid grid-cols-2 gap-y-3 text-sm">
                <dt className="text-subtext-0">Initial balance</dt>
                <dd className="text-right text-text">{`$${wallet.initialBalanceUsd.toLocaleString()}`}</dd>
                <dt className="text-subtext-0">Current balance</dt>
                <dd className="text-right text-text">{`$${wallet.currentBalanceUsd.toLocaleString()}`}</dd>
                <dt className="text-subtext-0">All-time P&amp;L</dt>
                <dd
                  className={`text-right font-medium ${
                    wallet.allTimePnlUsd >= 0 ? "text-emerald-400" : "text-destructive"
                  }`}
                >{`$${wallet.allTimePnlUsd.toLocaleString()}`}</dd>
              </dl>
            </Card>
          ) : (
            <Card className="max-w-sm">
              <form onSubmit={handleCreate} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1">
                  <Label>Initial balance (USD)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={initialBalance}
                    onChange={(e) => setInitialBalance(e.target.value)}
                  />
                </label>
                <Button type="submit" disabled={submitting}>
                  {submitting ? "Creating..." : "Create wallet"}
                </Button>
              </form>
            </Card>
          )}
        </section>

        {wallet && (
          <section>
            <h2 className="mb-3 text-lg font-semibold tracking-tight text-text">
              Recent funding payments
            </h2>
            {!fundingPayments ? (
              <p className="text-sm text-subtext-1">Loading...</p>
            ) : fundingPayments.length === 0 ? (
              <p className="text-sm text-subtext-1">No funding payments yet.</p>
            ) : (
              <Card className="max-w-2xl overflow-x-auto p-0">
                <table className="w-full border-collapse text-left text-sm text-text">
                  <thead>
                    <tr>
                      <th className={TH}>Time</th>
                      <th className={TH}>Symbol</th>
                      <th className={TH}>Direction</th>
                      <th className={TH}>Rate</th>
                      <th className={TH}>Amount (USD)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fundingPayments.map((p, i) => (
                      <tr key={i} className="hover:bg-surface-0/60">
                        <td className={TD}>
                          {new Date(p.time).toLocaleString()}
                        </td>
                        <td className={TD}>{p.symbol}</td>
                        <td className={TD}>{p.direction}</td>
                        <td className={TD}>
                          {(p.fundingRate * 100).toFixed(4)}%
                        </td>
                        <td className={TD}>{p.amountUsd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
