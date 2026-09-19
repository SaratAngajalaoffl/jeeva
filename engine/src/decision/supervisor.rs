use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant, MissedTickBehavior};

use super::execution::ExecutionAdapter;
use super::history::{build_context_summary, MarketDataHistoryReader};
use super::jev::JevDecisionSource;
use super::log::{DecisionLogEntry, DecisionLogWriter};
use super::model::decide_action;
use crate::config::{ConfigStore, PerpConfig};
use crate::funding::FundingHistoryReader;
use crate::scheduler::{delay_until_next_boundary, reconcile};

const HISTORY_WINDOW: u32 = 1000;

/// The set of symbols that should currently be evaluated, each mapped
/// to its configured decision frequency (in seconds).
pub fn desired_state(configs: &HashMap<String, PerpConfig>) -> HashMap<String, f64> {
    configs
        .iter()
        .filter(|(_, c)| c.trading_enabled)
        .map(|(symbol, c)| (symbol.clone(), c.decision_frequency_seconds))
        .collect()
}

/// Runs a single decision cycle for one PERP: builds context from
/// recent market history, asks Jev for a Target Direction, compares it
/// to the current Position State, applies the resulting action, and
/// always writes a decision-log row — including when there's no market
/// data yet or Jev/execution fails, so the log is a complete audit
/// trail. Free of any scheduling concerns, so it's directly testable.
#[allow(clippy::too_many_arguments)]
pub async fn run_decision_cycle(
    symbol: &str,
    config: &PerpConfig,
    history: &dyn MarketDataHistoryReader,
    jev: &dyn JevDecisionSource,
    execution: &dyn ExecutionAdapter,
    funding: &dyn FundingHistoryReader,
    decision_log: &dyn DecisionLogWriter,
) {
    let samples = match history.recent_samples(symbol, HISTORY_WINDOW).await {
        Ok(samples) => samples,
        Err(error) => {
            tracing::error!(symbol, %error, "failed to read market data history");
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: "",
                    decision: None,
                    position_action: None,
                    error: Some(&error.to_string()),
                })
                .await;
            return;
        }
    };

    if samples.is_empty() {
        let context_summary = build_context_summary(symbol, &samples, None, None);
        tracing::warn!(
            symbol,
            "no market data available yet; skipping decision cycle"
        );
        let _ = decision_log
            .write(DecisionLogEntry {
                symbol,
                context_summary: &context_summary,
                decision: None,
                position_action: None,
                error: Some("no market data available yet"),
            })
            .await;
        return;
    }

    let current_position = match execution.get_position(symbol).await {
        Ok(position) => position,
        Err(error) => {
            tracing::error!(symbol, %error, "failed to read current position");
            let context_summary = build_context_summary(symbol, &samples, None, None);
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: &context_summary,
                    decision: None,
                    position_action: None,
                    error: Some(&error.to_string()),
                })
                .await;
            return;
        }
    };

    let latest_funding = match funding.latest(symbol).await {
        Ok(funding) => funding,
        Err(error) => {
            tracing::warn!(symbol, %error, "failed to read latest funding rate; continuing without it");
            None
        }
    };

    let context_summary =
        build_context_summary(symbol, &samples, current_position.as_ref(), latest_funding.as_ref());
    let latest_mid_price = samples.last().unwrap().mid_price;

    let decision = match jev.decide(symbol, &context_summary).await {
        Ok(decision) => decision,
        Err(error) => {
            tracing::error!(symbol, %error, "jev decision failed");
            let _ = decision_log
                .write(DecisionLogEntry {
                    symbol,
                    context_summary: &context_summary,
                    decision: None,
                    position_action: None,
                    error: Some(&error.to_string()),
                })
                .await;
            return;
        }
    };

    let current_direction = current_position.map(|p| p.direction);

    let action = decide_action(current_direction, decision.direction);

    let execution_result = apply_action(
        execution,
        symbol,
        action,
        config.position_size_usd,
        config.leverage,
        latest_mid_price,
    )
    .await;

    let error = execution_result.err();
    if let Some(error) = &error {
        tracing::error!(symbol, %error, "failed to apply position action");
    } else {
        tracing::info!(
            symbol,
            target_direction = decision.direction.as_str(),
            action = ?action,
            "decision cycle complete"
        );
    }

    let _ = decision_log
        .write(DecisionLogEntry {
            symbol,
            context_summary: &context_summary,
            decision: Some(&decision),
            position_action: Some(action),
            error: error.as_deref(),
        })
        .await;
}

async fn apply_action(
    execution: &dyn ExecutionAdapter,
    symbol: &str,
    action: super::model::PositionAction,
    position_size_usd: f64,
    leverage: f64,
    mid_price: f64,
) -> Result<(), String> {
    use super::model::PositionAction;

    match action {
        PositionAction::NoOp => Ok(()),
        PositionAction::Open(direction) => execution
            .open(symbol, direction, position_size_usd, leverage, mid_price)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string()),
        PositionAction::Close => execution
            .close(symbol, mid_price)
            .await
            .map_err(|e| e.to_string()),
        PositionAction::CloseThenOpen(direction) => {
            execution
                .close(symbol, mid_price)
                .await
                .map_err(|e| e.to_string())?;
            execution
                .open(symbol, direction, position_size_usd, leverage, mid_price)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_task(
    symbol: String,
    frequency_seconds: f64,
    store: ConfigStore,
    history: Arc<dyn MarketDataHistoryReader>,
    jev: Arc<dyn JevDecisionSource>,
    execution: Arc<dyn ExecutionAdapter>,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs_f64(frequency_seconds.max(0.001));
        let start = Instant::now() + delay_until_next_boundary(frequency_seconds);
        let mut ticker = interval_at(start, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            if let Some(config) = store.get(&symbol) {
                run_decision_cycle(
                    &symbol,
                    &config,
                    history.as_ref(),
                    jev.as_ref(),
                    execution.as_ref(),
                    funding.as_ref(),
                    decision_log.as_ref(),
                )
                .await;
            }
        }
    })
}

/// Runs forever, polling the config store on `poll_interval` and
/// starting/stopping/restarting one decision task per trading-enabled
/// PERP so the running tasks always match `trading_enabled` +
/// `decision_frequency_seconds` from config — without ever restarting
/// the engine itself.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    store: ConfigStore,
    history: Arc<dyn MarketDataHistoryReader>,
    jev: Arc<dyn JevDecisionSource>,
    execution: Arc<dyn ExecutionAdapter>,
    funding: Arc<dyn FundingHistoryReader>,
    decision_log: Arc<dyn DecisionLogWriter>,
    poll_interval: Duration,
) -> ! {
    let mut running: HashMap<String, (f64, JoinHandle<()>)> = HashMap::new();

    loop {
        let configs = store.snapshot();
        let desired = desired_state(&configs);
        let running_frequencies: HashMap<String, f64> =
            running.iter().map(|(k, (f, _))| (k.clone(), *f)).collect();
        let actions = reconcile(&running_frequencies, &desired);

        for symbol in actions.to_stop {
            if let Some((_, handle)) = running.remove(&symbol) {
                handle.abort();
                tracing::info!(symbol = %symbol, "stopped decision loop");
            }
        }

        for (symbol, frequency) in actions.to_start {
            if let Some((_, handle)) = running.remove(&symbol) {
                handle.abort();
            }
            tracing::info!(symbol = %symbol, frequency_seconds = frequency, "starting decision loop");
            let handle = spawn_task(
                symbol.clone(),
                frequency,
                store.clone(),
                history.clone(),
                jev.clone(),
                execution.clone(),
                funding.clone(),
                decision_log.clone(),
            );
            running.insert(symbol, (frequency, handle));
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config(symbol: &str, trading_enabled: bool, frequency: f64) -> PerpConfig {
        PerpConfig {
            symbol: symbol.to_string(),
            trading_enabled,
            sampling_enabled: trading_enabled,
            decision_frequency_seconds: frequency,
            sampling_frequency_seconds: 60.0,
            leverage: 1.0,
            position_size_usd: 100.0,
        }
    }

    #[test]
    fn desired_state_excludes_trading_disabled_perps() {
        let configs = HashMap::from([
            ("BTC".to_string(), sample_config("BTC", true, 30.0)),
            ("ETH".to_string(), sample_config("ETH", false, 15.0)),
        ]);

        let desired = desired_state(&configs);
        assert_eq!(desired.get("BTC"), Some(&30.0));
        assert_eq!(desired.get("ETH"), None);
    }
}
