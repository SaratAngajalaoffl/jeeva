use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;

use crate::decision::Direction;
use crate::funding::{
    FundingHistoryError, FundingHistoryReader, FundingPaymentWriter, FundingRateError,
    FundingRateSource, FundingRecord, FundingWriteError,
};

use super::clock::SimClock;

#[derive(Debug)]
pub struct HistoricalFundingError(pub String);

impl fmt::Display for HistoricalFundingError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for HistoricalFundingError {}

#[derive(Debug, Deserialize)]
struct FundingHistoryEntry {
    #[serde(rename = "fundingRate")]
    funding_rate: String,
    time: i64,
}

/// Fetches Hyperliquid's real historical funding rates for a symbol
/// over a time range, via its public `fundingHistory` info endpoint —
/// distinct from `FundingRateSource`, which only exposes the *current*
/// rate.
pub struct HyperliquidHistoricalFundingRateSource {
    base_url: String,
    http: reqwest::Client,
}

impl HyperliquidHistoricalFundingRateSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }
}

impl Default for HyperliquidHistoricalFundingRateSource {
    fn default() -> Self {
        Self::new("https://api.hyperliquid.xyz")
    }
}

impl HyperliquidHistoricalFundingRateSource {
    /// Returns `(time, rate)` pairs covering `[start, end]`, sorted
    /// oldest first.
    pub async fn fetch(
        &self,
        symbol: &str,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    ) -> Result<Vec<(DateTime<Utc>, f64)>, HistoricalFundingError> {
        let url = format!("{}/info", self.base_url);

        let entries: Vec<FundingHistoryEntry> = self
            .http
            .post(&url)
            .json(&serde_json::json!({
                "type": "fundingHistory",
                "coin": symbol,
                "startTime": start.timestamp_millis(),
                "endTime": end.timestamp_millis(),
            }))
            .send()
            .await
            .map_err(|e| HistoricalFundingError(format!("fundingHistory request failed: {e}")))?
            .json()
            .await
            .map_err(|e| HistoricalFundingError(format!("fundingHistory response invalid: {e}")))?;

        let mut series = entries
            .into_iter()
            .map(|entry| {
                let rate = entry.funding_rate.parse::<f64>().map_err(|_| {
                    HistoricalFundingError(format!(
                        "could not parse historical funding rate: {}",
                        entry.funding_rate
                    ))
                })?;
                let time = DateTime::from_timestamp_millis(entry.time).ok_or_else(|| {
                    HistoricalFundingError(format!(
                        "invalid funding history timestamp: {}",
                        entry.time
                    ))
                })?;
                Ok((time, rate))
            })
            .collect::<Result<Vec<_>, HistoricalFundingError>>()?;

        series.sort_by_key(|(time, _)| *time);
        Ok(series)
    }
}

/// The rate in effect at `as_of`: the latest entry at or before it, or
/// (if `as_of` predates the whole series) the earliest entry available.
fn rate_at(series: &[(DateTime<Utc>, f64)], as_of: DateTime<Utc>) -> Option<f64> {
    series
        .iter()
        .rev()
        .find(|(time, _)| *time <= as_of)
        .or_else(|| series.first())
        .map(|(_, rate)| *rate)
}

/// Feeds a backtest's decision context the historical funding rate in
/// effect at the replay's simulated time, mirroring what
/// `PostgresFundingHistoryReader` does with the *real* latest rate for
/// a live session.
pub struct ReplayFundingHistoryReader {
    series: Vec<(DateTime<Utc>, f64)>,
    clock: Arc<SimClock>,
}

impl ReplayFundingHistoryReader {
    pub fn new(series: Vec<(DateTime<Utc>, f64)>, clock: Arc<SimClock>) -> Self {
        Self { series, clock }
    }
}

#[async_trait]
impl FundingHistoryReader for ReplayFundingHistoryReader {
    async fn latest(&self, _symbol: &str) -> Result<Option<FundingRecord>, FundingHistoryError> {
        let as_of = self.clock.get();
        Ok(rate_at(&self.series, as_of).map(|rate| FundingRecord { rate, time: as_of }))
    }
}

/// Feeds the reused `run_funding_cycle` sweep the historical rate in
/// effect at the replay's simulated time, so the same funding-payment
/// math the live engine uses (`calculate_funding_payment`) applies
/// during a backtest too.
pub struct ReplayFundingRateSource {
    series: Vec<(DateTime<Utc>, f64)>,
    clock: Arc<SimClock>,
}

impl ReplayFundingRateSource {
    pub fn new(series: Vec<(DateTime<Utc>, f64)>, clock: Arc<SimClock>) -> Self {
        Self { series, clock }
    }
}

#[async_trait]
impl FundingRateSource for ReplayFundingRateSource {
    async fn funding_rate(&self, _symbol: &str) -> Result<f64, FundingRateError> {
        rate_at(&self.series, self.clock.get())
            .ok_or_else(|| FundingRateError("no historical funding rate available".to_string()))
    }
}

/// Records funding payments applied during a backtest to
/// `backtest_funding_payments`, stamped with simulated time.
pub struct BacktestFundingPaymentWriter {
    pool: PgPool,
    backtest_run_id: String,
    clock: Arc<SimClock>,
}

impl BacktestFundingPaymentWriter {
    pub fn new(pool: PgPool, backtest_run_id: String, clock: Arc<SimClock>) -> Self {
        Self {
            pool,
            backtest_run_id,
            clock,
        }
    }
}

#[async_trait]
impl FundingPaymentWriter for BacktestFundingPaymentWriter {
    async fn write(
        &self,
        _session_id: &str,
        symbol: &str,
        direction: Direction,
        funding_rate: f64,
        notional_usd: f64,
        amount_usd: f64,
    ) -> Result<(), FundingWriteError> {
        sqlx::query(
            r#"
            INSERT INTO backtest_funding_payments
                (backtest_run_id, sim_time, symbol, direction, funding_rate, notional_usd, amount_usd)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
            "#,
        )
        .bind(&self.backtest_run_id)
        .bind(self.clock.get())
        .bind(symbol)
        .bind(direction.as_str())
        .bind(funding_rate)
        .bind(notional_usd)
        .bind(amount_usd)
        .execute(&self.pool)
        .await
        .map_err(|e| FundingWriteError(format!("failed to record backtest funding payment: {e}")))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(hour: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, hour, 0, 0).unwrap()
    }

    #[test]
    fn rate_at_uses_the_latest_entry_at_or_before_as_of() {
        let series = vec![(t(0), 0.0001), (t(8), 0.0002), (t(16), 0.0003)];
        assert_eq!(rate_at(&series, t(10)), Some(0.0002));
        assert_eq!(rate_at(&series, t(16)), Some(0.0003));
        assert_eq!(rate_at(&series, t(23)), Some(0.0003));
    }

    #[test]
    fn rate_at_falls_back_to_the_earliest_entry_when_as_of_predates_the_series() {
        let series = vec![(t(8), 0.0002), (t(16), 0.0003)];
        assert_eq!(rate_at(&series, t(0)), Some(0.0002));
    }

    #[test]
    fn rate_at_is_none_for_an_empty_series() {
        assert_eq!(rate_at(&[], t(0)), None);
    }
}
