import type { MigrationBuilder } from "node-pg-migrate";

// A live wallet can trade a Hyperliquid sub-account. Sub-accounts have no
// private key of their own: orders are signed by the master account (or
// an API wallet the master approved) and name the sub-account as the
// `vaultAddress`. When set, this is the account the engine trades and
// reads balances/positions from; the stored key only signs.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("wallets", {
    sub_account_address: { type: "text" },
  });
  pgm.addConstraint(
    "wallets",
    "wallets_sub_account_address_check",
    "CHECK (sub_account_address IS NULL OR (kind = 'live' AND sub_account_address ~ '^0x[0-9a-f]{40}$'))",
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint("wallets", "wallets_sub_account_address_check");
  pgm.dropColumn("wallets", "sub_account_address");
}
