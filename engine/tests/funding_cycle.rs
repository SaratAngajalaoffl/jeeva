use std::sync::Mutex;

use async_trait::async_trait;
use engine::decision::{Direction, ExecutionAdapter, ExecutionError, OpenPosition};
use engine::funding::{
    run_funding_cycle, FundingPaymentWriter, FundingRateError, FundingRateSource, FundingWriteError,
};

struct FakeRateSource {
    rate: f64,
}

#[async_trait]
impl FundingRateSource for FakeRateSource {
    async fn funding_rate(&self, _symbol: &str) -> Result<f64, FundingRateError> {
        Ok(self.rate)
    }
}

struct FailingRateSource;

#[async_trait]
impl FundingRateSource for FailingRateSource {
    async fn funding_rate(&self, symbol: &str) -> Result<f64, FundingRateError> {
        Err(FundingRateError(format!("no rate for {symbol}")))
    }
}

#[derive(Default)]
struct FakeExecution {
    positions: Mutex<Vec<(String, OpenPosition)>>,
    balance: Mutex<f64>,
    funding_calls: Mutex<Vec<(String, f64)>>,
}

impl FakeExecution {
    fn with_positions(positions: Vec<(String, OpenPosition)>) -> Self {
        Self {
            positions: Mutex::new(positions),
            balance: Mutex::new(10_000.0),
            funding_calls: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ExecutionAdapter for FakeExecution {
    async fn get_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        Ok(self
            .positions
            .lock()
            .unwrap()
            .iter()
            .find(|(s, _)| s == symbol)
            .map(|(_, p)| *p))
    }

    async fn open(
        &self,
        _symbol: &str,
        _direction: Direction,
        _position_size_usd: f64,
        _leverage: f64,
        _mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        unimplemented!("not exercised by funding cycle tests")
    }

    async fn close(&self, _symbol: &str, _mid_price: f64) -> Result<(), ExecutionError> {
        unimplemented!("not exercised by funding cycle tests")
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        Ok(self.positions.lock().unwrap().clone())
    }

    async fn apply_funding(&self, symbol: &str, amount_usd: f64) -> Result<(), ExecutionError> {
        *self.balance.lock().unwrap() += amount_usd;
        self.funding_calls
            .lock()
            .unwrap()
            .push((symbol.to_string(), amount_usd));
        Ok(())
    }
}

struct PaymentEntry {
    symbol: String,
    direction: Direction,
    funding_rate: f64,
    notional_usd: f64,
    amount_usd: f64,
}

#[derive(Default)]
struct FakePaymentWriter {
    entries: Mutex<Vec<PaymentEntry>>,
}

#[async_trait]
impl FundingPaymentWriter for FakePaymentWriter {
    async fn write(
        &self,
        symbol: &str,
        direction: Direction,
        funding_rate: f64,
        notional_usd: f64,
        amount_usd: f64,
    ) -> Result<(), FundingWriteError> {
        self.entries.lock().unwrap().push(PaymentEntry {
            symbol: symbol.to_string(),
            direction,
            funding_rate,
            notional_usd,
            amount_usd,
        });
        Ok(())
    }
}

fn position(direction: Direction, notional_usd: f64) -> OpenPosition {
    OpenPosition {
        direction,
        entry_price: 100.0,
        notional_usd,
        opened_at: chrono::Utc::now(),
    }
}

#[tokio::test]
async fn debits_the_wallet_for_a_long_when_funding_rate_is_positive() {
    let execution =
        FakeExecution::with_positions(vec![("BTC".to_string(), position(Direction::Long, 1000.0))]);
    let rate_source = FakeRateSource { rate: 0.0001 };
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    assert_eq!(*execution.balance.lock().unwrap(), 9_999.9);
    let calls = execution.funding_calls.lock().unwrap();
    assert_eq!(calls[0], ("BTC".to_string(), -0.1));
}

#[tokio::test]
async fn credits_the_wallet_for_a_short_when_funding_rate_is_positive() {
    let execution = FakeExecution::with_positions(vec![(
        "BTC".to_string(),
        position(Direction::Short, 1000.0),
    )]);
    let rate_source = FakeRateSource { rate: 0.0001 };
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    assert_eq!(*execution.balance.lock().unwrap(), 10_000.1);
}

#[tokio::test]
async fn applies_funding_independently_to_multiple_open_positions() {
    let execution = FakeExecution::with_positions(vec![
        ("BTC".to_string(), position(Direction::Long, 1000.0)),
        ("ETH".to_string(), position(Direction::Short, 500.0)),
    ]);
    let rate_source = FakeRateSource { rate: 0.0002 };
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    let calls = execution.funding_calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls.contains(&("BTC".to_string(), -0.2)));
    assert!(calls.contains(&("ETH".to_string(), 0.1)));
}

#[tokio::test]
async fn records_a_payment_entry_distinct_per_position() {
    let execution =
        FakeExecution::with_positions(vec![("BTC".to_string(), position(Direction::Long, 1000.0))]);
    let rate_source = FakeRateSource { rate: 0.0001 };
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    let entries = writer.entries.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].symbol, "BTC");
    assert_eq!(entries[0].direction, Direction::Long);
    assert_eq!(entries[0].funding_rate, 0.0001);
    assert_eq!(entries[0].notional_usd, 1000.0);
    assert_eq!(entries[0].amount_usd, -0.1);
}

#[tokio::test]
async fn does_nothing_when_there_are_no_open_positions() {
    let execution = FakeExecution::with_positions(vec![]);
    let rate_source = FakeRateSource { rate: 0.0001 };
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    assert_eq!(*execution.balance.lock().unwrap(), 10_000.0);
    assert!(writer.entries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_rate_fetch_failure_for_one_symbol_does_not_block_the_others() {
    let execution =
        FakeExecution::with_positions(vec![("BTC".to_string(), position(Direction::Long, 1000.0))]);
    let rate_source = FailingRateSource;
    let writer = FakePaymentWriter::default();

    run_funding_cycle(&execution, &rate_source, &writer).await;

    // Balance untouched, no payment recorded - the failure was skipped.
    assert_eq!(*execution.balance.lock().unwrap(), 10_000.0);
    assert!(writer.entries.lock().unwrap().is_empty());
}
