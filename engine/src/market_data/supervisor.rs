use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;
use tokio::time::{interval_at, Instant, MissedTickBehavior};

use super::client::MarketDataClient;
use super::writer::MarketDataWriter;
use crate::config::{ConfigStore, PerpConfig};
use crate::scheduler::{delay_until_next_boundary, reconcile};

/// The set of symbols that should currently be sampled, each mapped to
/// its configured sampling frequency (in seconds).
pub fn desired_state(configs: &HashMap<String, PerpConfig>) -> HashMap<String, f64> {
    configs
        .iter()
        .filter(|(_, c)| c.sampling_enabled)
        .map(|(symbol, c)| (symbol.clone(), c.sampling_frequency_seconds))
        .collect()
}

fn spawn_task(
    symbol: String,
    frequency_seconds: f64,
    client: Arc<dyn MarketDataClient>,
    writer: Arc<dyn MarketDataWriter>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let period = Duration::from_secs_f64(frequency_seconds.max(0.001));
        let start = Instant::now() + delay_until_next_boundary(frequency_seconds);
        let mut ticker = interval_at(start, period);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
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
