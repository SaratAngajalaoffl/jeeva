"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  Copy,
  Plus,
  Trash2,
  Wallet as WalletIcon,
} from "lucide-react";
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
import { SiteHeader } from "@/components/SiteHeader";
import Modal from "@/components/Modal";
import {
  Button,
  Card,
  Input,
  Label,
  Select,
  Skeleton,
  StatTile,
} from "@/components/ui";

const TH =
  "border-b border-surface-1 py-2 pr-4 text-left text-xs font-medium uppercase tracking-wide text-subtext-0";
const TD = "border-b border-surface-1 py-3 pr-4";

function shortenAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function KindBadge({ kind }: { kind: WalletKind }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${
        kind === "live"
          ? "bg-destructive/15 text-destructive"
          : "bg-peach/15 text-peach"
      }`}
    >
      {kind}
    </span>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy address"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="text-subtext-0 transition-colors hover:text-text"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function WalletCard({
  wallet,
  onDelete,
}: {
  wallet: Wallet;
  onDelete: (id: string) => void;
}) {
  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-text">{wallet.label}</span>
          <KindBadge kind={wallet.kind} />
        </div>
        <button
          type="button"
          title="Delete wallet"
          onClick={() => onDelete(wallet.id)}
          className="text-subtext-0 transition-colors hover:text-destructive"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div>
        <span className="text-xs uppercase tracking-wide text-subtext-0">
          Balance
        </span>
        <p className="text-2xl font-semibold tracking-tight text-text">
          {wallet.currentBalanceUsd !== null
            ? `$${wallet.currentBalanceUsd.toLocaleString()}`
            : "—"}
        </p>
      </div>

      {wallet.publicAddress && (
        <div className="flex items-center gap-2 rounded-lg border border-surface-1 bg-mantle/60 px-3 py-2">
          <span className="flex-1 truncate font-mono text-xs text-subtext-1">
            {shortenAddress(wallet.publicAddress)}
          </span>
          <CopyButton value={wallet.publicAddress} />
        </div>
      )}
    </Card>
  );
}

export default function WalletPage() {
  const [wallets, setWallets] = useState<Wallet[] | undefined>(undefined);
  const [fundingPayments, setFundingPayments] = useState<
    FundingPayment[] | null
  >(null);
  const [showCreate, setShowCreate] = useState(false);
  const [kind, setKind] = useState<WalletKind>("mock");
  const [label, setLabel] = useState("");
  const [initialBalance, setInitialBalance] = useState("10000");
  const [publicAddress, setPublicAddress] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchWallets()
      .then(setWallets)
      .catch(() => setLoadError("Failed to load wallets"));
    fetchFundingPayments()
      .then(setFundingPayments)
      .catch(() => setLoadError("Failed to load funding payments"));
  }, []);

  const totalBalanceUsd = useMemo(
    () =>
      (wallets ?? []).reduce((sum, w) => sum + (w.currentBalanceUsd ?? 0), 0),
    [wallets],
  );
  const liveWalletCount = useMemo(
    () => (wallets ?? []).filter((w) => w.kind === "live").length,
    [wallets],
  );

  function resetForm() {
    setLabel("");
    setPublicAddress("");
    setPrivateKey("");
    setInitialBalance("10000");
    setKind("mock");
    setFormError(null);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!label.trim()) {
      setFormError("Enter a wallet label");
      return;
    }

    let input: CreateWalletInput;
    if (kind === "mock") {
      const value = Number(initialBalance);
      if (!Number.isFinite(value) || value <= 0) {
        setFormError("Enter a positive initial balance");
        return;
      }
      input = { kind: "mock", label, initialBalanceUsd: value };
    } else {
      if (!publicAddress.trim() || !privateKey.trim()) {
        setFormError("Enter both the public address and private key");
        return;
      }
      input = { kind: "live", label, publicAddress, privateKey };
    }

    setSubmitting(true);
    const result = await createWallet(input);
    setSubmitting(false);

    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    resetForm();
    setShowCreate(false);
    setWallets((prev) => (prev ? [...prev, result.wallet] : [result.wallet]));
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this wallet? This cannot be undone.")) {
      return;
    }
    const result = await deleteWallet(id);
    if (!result.ok) {
      setLoadError(result.error);
      return;
    }
    setWallets((prev) => prev?.filter((w) => w.id !== id) ?? prev);
  }

  return (
    <SiteHeader>
      <main className="flex flex-col gap-8 px-6 py-8 sm:px-8 lg:px-12">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold tracking-tight text-text">
            Wallet
          </h1>
          <Button
            onClick={() => {
              resetForm();
              setShowCreate(true);
            }}
            className="gap-1.5"
          >
            <Plus size={16} />
            Add wallet
          </Button>
        </div>

        {loadError && (
          <p className="-mt-4 text-sm text-destructive">{loadError}</p>
        )}

        <section className="grid gap-4 sm:grid-cols-3">
          {wallets === undefined ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="flex flex-col gap-2 p-5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-7 w-16" />
              </Card>
            ))
          ) : (
            <>
              <StatTile
                label="Total balance"
                value={`$${totalBalanceUsd.toLocaleString()}`}
              />
              <StatTile label="Wallets" value={wallets.length} />
              <StatTile label="Live wallets" value={liveWalletCount} />
            </>
          )}
        </section>

        <section className="flex flex-col gap-3">
          {wallets === undefined ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="flex flex-col gap-4 p-5">
                  <Skeleton className="h-5 w-24" />
                  <Skeleton className="h-8 w-32" />
                  <Skeleton className="h-9 w-full" />
                </Card>
              ))}
            </div>
          ) : wallets.length === 0 ? (
            <Card className="flex flex-col items-center gap-3 p-10 text-center">
              <WalletIcon size={28} className="text-subtext-0" />
              <p className="text-sm text-subtext-1">
                No wallets yet. Add a mock wallet to start trading in
                simulation, or a live wallet once you&apos;re ready to trade
                for real.
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  resetForm();
                  setShowCreate(true);
                }}
                className="gap-1.5"
              >
                <Plus size={16} />
                Add wallet
              </Button>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {wallets.map((w) => (
                <WalletCard key={w.id} wallet={w} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-text">
            Recent funding payments
          </h2>
          {!fundingPayments ? (
            <Card className="p-0">
              <div className="flex flex-col gap-px p-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            </Card>
          ) : fundingPayments.length === 0 ? (
            <Card className="p-6 text-center">
              <p className="text-sm text-subtext-1">
                No funding payments yet.
              </p>
            </Card>
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[560px] border-collapse text-left text-sm text-text">
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
                      <td className={`${TD} text-subtext-1`}>
                        {new Date(p.time).toLocaleString()}
                      </td>
                      <td className={`${TD} font-medium`}>{p.symbol}</td>
                      <td className={TD}>
                        <span
                          className={`inline-flex items-center gap-1 ${
                            p.direction === "long"
                              ? "text-emerald-400"
                              : "text-destructive"
                          }`}
                        >
                          {p.direction === "long" ? (
                            <ArrowUpRight size={14} />
                          ) : (
                            <ArrowDownRight size={14} />
                          )}
                          {p.direction}
                        </span>
                      </td>
                      <td className={`${TD} text-subtext-1`}>
                        {(p.fundingRate * 100).toFixed(4)}%
                      </td>
                      <td
                        className={`${TD} ${
                          p.amountUsd >= 0
                            ? "text-emerald-400"
                            : "text-destructive"
                        }`}
                      >
                        {p.amountUsd >= 0 ? "+" : ""}
                        {p.amountUsd.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      </main>

      {showCreate && (
        <Modal title="Add wallet" onClose={() => setShowCreate(false)}>
          <form onSubmit={handleCreate} className="flex flex-col gap-3">
            {formError && (
              <p className="text-sm text-destructive">{formError}</p>
            )}
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
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
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
        </Modal>
      )}
    </SiteHeader>
  );
}
