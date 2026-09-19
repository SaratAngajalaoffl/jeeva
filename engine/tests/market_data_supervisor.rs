use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use engine::config::{ConfigStore, PerpConfig};
use engine::market_data::{
    self, MarketDataClient, MarketDataError, MarketDataSample, MarketDataWriter,
};
use tokio::time::sleep;

struct FakeClient {
    calls: AtomicUsize,
}

#[async_trait]
impl MarketDataClient for FakeClient {
    async fn fetch_sample(&self, symbol: &str) -> Result<MarketDataSample, MarketDataError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(MarketDataSample {
            symbol: symbol.to_string(),
            price: 100.0,
            open_interest: 10.0,
            volume: 1000.0,
            spread: 0.5,
            mid_price: 100.25,
        })
    }
}

struct FakeWriter {
    samples: Mutex<Vec<MarketDataSample>>,
}

impl FakeWriter {
    fn new() -> Self {
        Self {
            samples: Mutex::new(Vec::new()),
        }
    }

    fn samples_for(&self, symbol: &str) -> usize {
        self.samples
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.symbol == symbol)
            .count()
    }
}

#[async_trait]
impl MarketDataWriter for FakeWriter {
    async fn write(&self, sample: &MarketDataSample) -> Result<(), MarketDataError> {
        self.samples.lock().unwrap().push(sample.clone());
        Ok(())
    }
}

fn config(symbol: &str, sampling_enabled: bool, frequency_seconds: f64) -> PerpConfig {
    PerpConfig {
        symbol: symbol.to_string(),
        trading_enabled: false,
        sampling_enabled,
        decision_frequency_seconds: 300.0,
        sampling_frequency_seconds: frequency_seconds,
        leverage: 1.0,
        position_size_usd: 100.0,
    }
}

const POLL_INTERVAL: Duration = Duration::from_millis(20);
const SAMPLE_FREQUENCY_SECONDS: f64 = 0.02;

#[tokio::test]
async fn samples_a_perp_once_sampling_is_enabled() {
    let store = ConfigStore::new();
    let writer = Arc::new(FakeWriter::new());
    let client: Arc<dyn MarketDataClient> = Arc::new(FakeClient {
        calls: AtomicUsize::new(0),
    });
    let writer_dyn: Arc<dyn MarketDataWriter> = writer.clone();

    tokio::spawn(market_data::run(
        store.clone(),
        client,
        writer_dyn,
        POLL_INTERVAL,
    ));

    // Nothing sampled while disabled.
    store.upsert(config("BTC", false, SAMPLE_FREQUENCY_SECONDS));
    sleep(Duration::from_millis(100)).await;
    assert_eq!(writer.samples_for("BTC"), 0);

    // Enabling sampling should start producing writes without a restart.
    store.upsert(config("BTC", true, SAMPLE_FREQUENCY_SECONDS));
    sleep(Duration::from_millis(200)).await;
    assert!(
        writer.samples_for("BTC") >= 2,
        "expected multiple samples once enabled, got {}",
        writer.samples_for("BTC")
    );
}

#[tokio::test]
async fn stops_sampling_a_perp_once_disabled() {
    let store = ConfigStore::new();
    let writer = Arc::new(FakeWriter::new());
    let client: Arc<dyn MarketDataClient> = Arc::new(FakeClient {
        calls: AtomicUsize::new(0),
    });
    let writer_dyn: Arc<dyn MarketDataWriter> = writer.clone();

    store.upsert(config("ETH", true, SAMPLE_FREQUENCY_SECONDS));
    tokio::spawn(market_data::run(
        store.clone(),
        client,
        writer_dyn,
        POLL_INTERVAL,
    ));

    sleep(Duration::from_millis(150)).await;
    let count_while_enabled = writer.samples_for("ETH");
    assert!(
        count_while_enabled > 0,
        "expected some samples while enabled"
    );

    store.upsert(config("ETH", false, SAMPLE_FREQUENCY_SECONDS));
    // Give the supervisor a chance to notice and stop the task.
    sleep(Duration::from_millis(100)).await;
    let count_at_stop = writer.samples_for("ETH");

    sleep(Duration::from_millis(150)).await;
    let count_after_wait = writer.samples_for("ETH");

    assert_eq!(
        count_at_stop, count_after_wait,
        "no further samples should be written after disabling"
    );
}

#[tokio::test]
async fn samples_multiple_perps_independently() {
    let store = ConfigStore::new();
    let writer = Arc::new(FakeWriter::new());
    let client: Arc<dyn MarketDataClient> = Arc::new(FakeClient {
        calls: AtomicUsize::new(0),
    });
    let writer_dyn: Arc<dyn MarketDataWriter> = writer.clone();

    store.upsert(config("BTC", true, SAMPLE_FREQUENCY_SECONDS));
    store.upsert(config("ETH", false, SAMPLE_FREQUENCY_SECONDS));

    tokio::spawn(market_data::run(
        store.clone(),
        client,
        writer_dyn,
        POLL_INTERVAL,
    ));

    sleep(Duration::from_millis(200)).await;

    assert!(writer.samples_for("BTC") > 0);
    assert_eq!(writer.samples_for("ETH"), 0);
}
