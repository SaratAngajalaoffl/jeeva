/**
 * Deployment-level kill switch for real wallets and live trading
 * (PAPER_TRADING_ONLY=true). When set, live mode is rejected engine-wide
 * and live wallet creation is disabled — the deployment can only ever
 * paper-trade. Unlike the mutable engine mode in Mongo, this cannot be
 * flipped from the dashboard; it requires changing the environment.
 */
export function isPaperTradingOnly(): boolean {
  return process.env.PAPER_TRADING_ONLY === "true";
}
