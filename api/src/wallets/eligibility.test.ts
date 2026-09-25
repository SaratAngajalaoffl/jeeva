import { describe, expect, it, vi } from "vitest";

import type { HyperliquidClient } from "../hyperliquid/client.js";
import { getWalletBalanceUsd } from "./eligibility.js";
import type { Wallet } from "./repository.js";

const liveWallet: Wallet = {
  id: "00000000-0000-0000-0000-000000000001",
  label: "live wallet",
  kind: "live",
  publicAddress: "0x0000000000000000000000000000000000000001",
  initialBalanceUsd: null,
  currentBalanceUsd: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function clientWithBalances(): HyperliquidClient {
  return {
    async listPerps() {
      return [];
    },
    async listPerpStats() {
      return [];
    },
    async getOrderBook() {
      return { bids: [], asks: [] };
    },
    async getRecentTrades() {
      return [];
    },
    async getClearinghouseState(_address, dex) {
      return dex === "xyz"
        ? { accountValueUsd: 500, withdrawableUsd: 400 }
        : { accountValueUsd: 100, withdrawableUsd: 90 };
    },
  };
}

describe("live wallet balance eligibility", () => {
  it("checks the default DEX for a default symbol", async () => {
    const client = clientWithBalances();
    const getState = vi.spyOn(client, "getClearinghouseState");

    await expect(
      getWalletBalanceUsd(liveWallet, client, "BTC"),
    ).resolves.toBe(90);
    expect(getState).toHaveBeenCalledWith(liveWallet.publicAddress, undefined);
  });

  it("checks the selected HIP-3 DEX for a namespaced symbol", async () => {
    const client = clientWithBalances();
    const getState = vi.spyOn(client, "getClearinghouseState");

    await expect(
      getWalletBalanceUsd(liveWallet, client, "xyz:AAOI"),
    ).resolves.toBe(400);
    expect(getState).toHaveBeenCalledWith(liveWallet.publicAddress, "xyz");
  });
});
