export const MIN_INITIAL_BALANCE_USD = 1;
export const MAX_INITIAL_BALANCE_USD = 100_000_000;

export function isValidInitialBalanceUsd(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_INITIAL_BALANCE_USD &&
    value <= MAX_INITIAL_BALANCE_USD
  );
}
