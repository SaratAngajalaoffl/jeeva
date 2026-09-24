use std::sync::Arc;
use std::time::Duration;

use crate::decision::ExecutionAdapter;
use crate::wallets::WalletRegistry;

use super::payment::calculate_funding_payment;
use super::rate::FundingRateSource;
use super::writer::FundingPaymentWriter;

/// Applies one funding payment to every currently open mock position:
/// fetches each PERP's real funding rate, computes the payment,
/// credits/debits the wallet, and records the payment distinctly from
/// decision-driven position P&L. A failure on one position (rate fetch
/// or wallet update) is logged and skipped, not fatal to the sweep.
pub async fn run_funding_cycle(
    execution: &dyn ExecutionAdapter,
    rate_source: &dyn FundingRateSource,
    payment_writer: &dyn FundingPaymentWriter,
) {
    let positions = match execution.list_open_positions().await {
        Ok(positions) => positions,
        Err(error) => {
            tracing::error!(%error, "failed to list open positions for funding sweep");
            return;
        }
    };

    for (session_id, symbol, position) in positions {
        let funding_rate = match rate_source.funding_rate(&symbol).await {
            Ok(rate) => rate,
            Err(error) => {
                tracing::error!(symbol = %symbol, %error, "failed to fetch funding rate");
                continue;
            }
        };

        let amount_usd =
            calculate_funding_payment(position.direction, position.notional_usd, funding_rate);

        if let Err(error) = execution.apply_funding(&symbol, amount_usd).await {
            tracing::error!(symbol = %symbol, %error, "failed to apply funding payment");
            continue;
        }

        if let Err(error) = payment_writer
            .write(
                &session_id,
                &symbol,
                position.direction,
                funding_rate,
                position.notional_usd,
                amount_usd,
            )
            .await
        {
            tracing::error!(symbol = %symbol, %error, "failed to record funding payment");
        }
    }
}

/// Runs the funding sweep forever on `interval` (Hyperliquid's real
/// funding interval is hourly), applying one cycle per wallet currently
/// known to `wallets` — since positions now live against a specific
/// wallet rather than one engine-wide mock/live pair. Applies
/// immediately on startup so any already-open positions aren't left
/// waiting a full interval for their first payment.
pub async fn run(
    wallets: Arc<WalletRegistry>,
    rate_source: Arc<dyn FundingRateSource>,
    payment_writer: Arc<dyn FundingPaymentWriter>,
    interval: Duration,
) -> ! {
    loop {
        for (_wallet_id, _kind, execution) in wallets.snapshot() {
            run_funding_cycle(
                execution.as_ref(),
                rate_source.as_ref(),
                payment_writer.as_ref(),
            )
            .await;
        }
        tokio::time::sleep(interval).await;
    }
}
