use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use super::client::MarketDataClient;
use super::writer::MarketDataWriter;
use crate::config::{ConfigStore, PerpConfig};

/// The set of symbols that should currently be sampled, each mapped to
/// its configured sampling frequency (in seconds).
pub fn desired_state(configs: &HashMap<String, PerpConfig>) -> HashMap<String, f64> {
    configs
        .iter()
        .filter(|(_, c)| c.sampling_enabled)
        .map(|(symbol, c)| (symbol.clone(), c.sampling_frequency_seconds))
        .collect()
}

#[derive(Debug, Default, PartialEq)]
pub struct ReconcileActions {
    /// Symbols that need a (re)started task: new symbols, and symbols
    /// whose frequency changed since they were last started.
    pub to_start: Vec<(String, f64)>,
    /// Symbols whose task should be stopped: no longer sampling-enabled
    /// (or removed from config entirely).
    pub to_stop: Vec<String>,
}

/// Pure diff between what's currently running and what should be
/// running, given the latest config snapshot. Kept free of async/tokio
/// so it can be unit-tested directly.
pub fn reconcile(
    running: &HashMap<String, f64>,
    desired: &HashMap<String, f64>,
) -> ReconcileActions {
    let mut actions = ReconcileActions::default();

    for (symbol, frequency) in desired {
        match running.get(symbol) {
            None => actions.to_start.push((symbol.clone(), *frequency)),
            Some(running_frequency) if running_frequency != frequency => {
                actions.to_start.push((symbol.clone(), *frequency));
            }
            _ => {}
        }
    }

    for symbol in running.keys() {
        if !desired.contains_key(symbol) {
            actions.to_stop.push(symbol.clone());
        }
    }

    actions
}

fn spawn_task(
    symbol: String,
    frequency_seconds: f64,
    client: Arc<dyn MarketDataClient>,
    writer: Arc<dyn MarketDataWriter>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match client.fetch_sample(&symbol).await {
                Ok(sample) => {
                    if let Err(error) = writer.write(&sample).await {
                        tracing::error!(symbol = %symbol, %error, "failed to write market data sample");
                    }
                }
                Err(error) => {
                    tracing::error!(symbol = %symbol, %error, "failed to fetch market data sample");
                }
            }
            tokio::time::sleep(Duration::from_secs_f64(frequency_seconds.max(0.001))).await;
        }
    })
}

/// Runs forever, polling the config store on `poll_interval` and
/// starting/stopping/restarting one sampling task per PERP so the
/// running tasks always match `sampling_enabled` + `sampling_frequency`
/// from config — without ever restarting the engine itself.
pub async fn run(
    store: ConfigStore,
    client: Arc<dyn MarketDataClient>,
    writer: Arc<dyn MarketDataWriter>,
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
                tracing::info!(symbol = %symbol, "stopped market-data sampling");
            }
        }

        for (symbol, frequency) in actions.to_start {
            if let Some((_, handle)) = running.remove(&symbol) {
                handle.abort();
            }
            tracing::info!(symbol = %symbol, frequency_seconds = frequency, "starting market-data sampling");
            let handle = spawn_task(symbol.clone(), frequency, client.clone(), writer.clone());
            running.insert(symbol, (frequency, handle));
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_a_newly_desired_symbol() {
        let running = HashMap::new();
        let desired = HashMap::from([("BTC".to_string(), 60.0)]);

        let actions = reconcile(&running, &desired);
        assert_eq!(actions.to_start, vec![("BTC".to_string(), 60.0)]);
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn stops_a_symbol_no_longer_desired() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::new();

        let actions = reconcile(&running, &desired);
        assert!(actions.to_start.is_empty());
        assert_eq!(actions.to_stop, vec!["BTC".to_string()]);
    }

    #[test]
    fn restarts_a_symbol_whose_frequency_changed() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::from([("BTC".to_string(), 30.0)]);

        let actions = reconcile(&running, &desired);
        assert_eq!(actions.to_start, vec![("BTC".to_string(), 30.0)]);
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn leaves_an_unchanged_symbol_alone() {
        let running = HashMap::from([("BTC".to_string(), 60.0)]);
        let desired = HashMap::from([("BTC".to_string(), 60.0)]);

        let actions = reconcile(&running, &desired);
        assert!(actions.to_start.is_empty());
        assert!(actions.to_stop.is_empty());
    }

    #[test]
    fn handles_multiple_symbols_independently() {
        let running = HashMap::from([("BTC".to_string(), 60.0), ("ETH".to_string(), 30.0)]);
        let desired = HashMap::from([("BTC".to_string(), 60.0), ("SOL".to_string(), 15.0)]);

        let mut actions = reconcile(&running, &desired);
        actions.to_start.sort_by(|a, b| a.0.cmp(&b.0));
        actions.to_stop.sort();

        assert_eq!(actions.to_start, vec![("SOL".to_string(), 15.0)]);
        assert_eq!(actions.to_stop, vec!["ETH".to_string()]);
    }

    fn sample_config(symbol: &str, sampling_enabled: bool, frequency: f64) -> PerpConfig {
        PerpConfig {
            symbol: symbol.to_string(),
            trading_enabled: false,
            sampling_enabled,
            decision_frequency_seconds: 300.0,
            sampling_frequency_seconds: frequency,
            leverage: 1.0,
            position_size_usd: 100.0,
        }
    }

    #[test]
    fn desired_state_excludes_sampling_disabled_perps() {
        let configs = HashMap::from([
            ("BTC".to_string(), sample_config("BTC", true, 60.0)),
            ("ETH".to_string(), sample_config("ETH", false, 30.0)),
        ]);

        let desired = desired_state(&configs);
        assert_eq!(desired.get("BTC"), Some(&60.0));
        assert_eq!(desired.get("ETH"), None);
    }
}
