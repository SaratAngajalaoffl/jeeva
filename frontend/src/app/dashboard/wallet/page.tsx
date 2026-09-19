"use client";

import { useEffect, useState } from "react";
import {
  createWallet,
  deleteWallet,
  fetchFundingPayments,
  fetchWallets,
  type CreateWalletInput,
  type FundingPayment,
  type Wallet,
  type WalletKind,
} from "@/lib/api";
import { EngineModeSwitch } from "@/components/EngineModeSwitch";
import { SiteHeader } from "@/components/SiteHeader";
import { Button, Card, Input, Label, Select } from "@/components/ui";

const TH = "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-2 pr-4";

export default function WalletPage() {
  const [wallets, setWallets] = useState<Wallet[] | undefined>(undefined);
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [kind, setKind] = useState<WalletKind>("mock");
  const [label, setLabel] = useState("");
  const [initialBalance, setInitialBalance] = useState("10000");
  const [publicAddress, setPublicAddress] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function loadWallets() {
    fetchWallets()
      .then(setWallets)
      .catch(() => setError("Failed to load wallets"));
  }

  useEffect(() => {
    loadWallets();
    fetchFundingPayments()
      .then(setFundingPayments)
      .catch(() => setError("Failed to load funding payments"));
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!label.trim()) {
      setError("Enter a wallet label");
      return;
    }

    let input: CreateWalletInput;
    if (kind === "mock") {
      const value = Number(initialBalance);
      if (!Number.isFinite(value) || value <= 0) {
        setError("Enter a positive initial balance");
        return;
      }
      input = { kind: "mock", label, initialBalanceUsd: value };
    } else {
      if (!publicAddress.trim() || !privateKey.trim()) {
        setError("Enter both the public address and private key");
        return;
      }
      input = { kind: "live", label, publicAddress, privateKey };
    }

    setSubmitting(true);
    const result = await createWallet(input);
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setLabel("");
    setPublicAddress("");
    setPrivateKey("");
    setWallets((prev) => (prev ? [...prev, result.wallet] : [result.wallet]));
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this wallet? This cannot be undone.")) {
      return;
    }
    const result = await deleteWallet(id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setWallets((prev) => prev?.filter((w) => w.id !== id) ?? prev);
  }

  return (
    <SiteHeader>
      <main className="flex flex-col gap-8 px-6 py-8 sm:px-8 lg:px-12">
        <section>
          <h1 className="mb-3 text-xl font-semibold tracking-tight text-text">
            Engine mode
          </h1>
          <EngineModeSwitch />
        </section>

        <section>
          <h1 className="mb-3 text-xl font-semibold tracking-tight text-text">
            Wallets
          </h1>
          {error && <p className="mb-2 text-sm text-destructive">{error}</p>}

          {wallets === undefined ? (
            <p className="text-sm text-subtext-1">Loading...</p>
          ) : (
            <Card className="mb-4 max-w-2xl overflow-x-auto p-0">
              {wallets.length === 0 ? (
                <p className="p-4 text-sm text-subtext-1">
                  No wallets yet — create one below.
                </p>
              ) : (
                <table className="w-full border-collapse text-left text-sm text-text">
                  <thead>
                    <tr>
                      <th className={TH}>Label</th>
                      <th className={TH}>Kind</th>
                      <th className={TH}>Balance</th>
                      <th className={TH}>Address</th>
                      <th className={TH}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallets.map((w) => (
                      <tr key={w.id} className="hover:bg-surface-0/60">
                        <td className={TD}>{w.label}</td>
                        <td className={TD}>{w.kind}</td>
                        <td className={TD}>
                          {w.currentBalanceUsd !== null
                            ? `$${w.currentBalanceUsd.toLocaleString()}`
                            : "—"}
                        </td>
                        <td className={`${TD} font-mono text-xs`}>
                          {w.publicAddress ?? "—"}
                        </td>
                        <td className={TD}>
                          <Button
                            variant="ghost"
                            onClick={() => handleDelete(w.id)}
                          >
                            Delete
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          )}

          <Card className="max-w-sm">
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <Label>Kind</Label>
                <Select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as WalletKind)}
                >
                  <option value="mock">Mock</option>
                  <option value="live">Live</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1">
                <Label>Label</Label>
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                />
              </label>
              {kind === "mock" ? (
                <label className="flex flex-col gap-1">
                  <Label>Initial balance (USD)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={initialBalance}
                    onChange={(e) => setInitialBalance(e.target.value)}
                  />
                </label>
              ) : (
                <>
                  <label className="flex flex-col gap-1">
                    <Label>Public address</Label>
                    <Input
                      value={publicAddress}
                      onChange={(e) => setPublicAddress(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <Label>Private key</Label>
                    <Input
                      type="password"
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                    />
                  </label>
                </>
              )}
              <Button type="submit" disabled={submitting}>
                {submitting ? "Creating..." : "Create wallet"}
              </Button>
            </form>
          </Card>
        </section>

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
      </main>
    </SiteHeader>
  );
}
