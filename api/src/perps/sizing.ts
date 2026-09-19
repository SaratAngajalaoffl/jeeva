export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 50;

export const MIN_POSITION_SIZE_USD = 1;
export const MAX_POSITION_SIZE_USD = 1_000_000;

export function isValidLeverage(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_LEVERAGE &&
    value <= MAX_LEVERAGE
  );
}

export function isValidPositionSizeUsd(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_POSITION_SIZE_USD &&
    value <= MAX_POSITION_SIZE_USD
  );
}
