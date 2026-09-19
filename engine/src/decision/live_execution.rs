use async_trait::async_trait;
use chrono::Utc;
use serde::Deserialize;

use super::execution::{ExecutionAdapter, ExecutionError, OpenPosition};
use super::hyperliquid_signing::{
    market_order_price, sign_order_action, KeyError, OrderAction, OrderRequest, OrderType,
    PrivateKey,
};
use super::model::Direction;

const DEFAULT_MARKET_SLIPPAGE: f64 = 0.05;

impl From<KeyError> for ExecutionError {
    fn from(error: KeyError) -> Self {
        ExecutionError(error.0)
    }
}

#[derive(Debug, Deserialize)]
struct Universe {
    name: String,
}

#[derive(Debug, Deserialize)]
struct MetaResponse {
    universe: Vec<Universe>,
}

#[derive(Debug, Deserialize)]
struct AssetPositionEntry {
    position: RawPosition,
}

#[derive(Debug, Deserialize)]
struct RawPosition {
    coin: String,
    szi: String,
    #[serde(rename = "entryPx")]
    entry_px: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClearinghouseState {
    #[serde(rename = "assetPositions")]
    asset_positions: Vec<AssetPositionEntry>,
}

#[derive(Debug, Deserialize)]
struct ExchangeResponse {
    status: String,
    #[serde(default)]
    response: Option<serde_json::Value>,
}

fn parse_position(raw: &RawPosition) -> Result<Option<OpenPosition>, ExecutionError> {
    let size: f64 = raw
        .szi
        .parse()
        .map_err(|_| ExecutionError(format!("could not parse position size: {}", raw.szi)))?;
    if size == 0.0 {
        return Ok(None);
    }
    let entry_price: f64 = raw
        .entry_px
        .as_deref()
        .unwrap_or("0")
        .parse()
        .map_err(|_| ExecutionError("could not parse position entry price".to_string()))?;

    let direction = if size > 0.0 {
        Direction::Long
    } else {
        Direction::Short
    };

    Ok(Some(OpenPosition {
        direction,
        entry_price,
        // Hyperliquid's clearinghouseState does not report when a
        // position was opened; live positions are tracked by the
        // exchange itself, so "opened_at" is best-effort (observation
        // time) rather than authoritative, unlike the mock adapter
        // where the engine owns the ledger.
        notional_usd: size.abs() * entry_price,
        opened_at: Utc::now(),
    }))
}

/// Places and closes real market orders on Hyperliquid, signed with a
/// private key decrypted from a `wallets` row by `WalletRegistry`. The
/// key never leaves this module:
/// it is held only inside the `PrivateKey` wrapper (which refuses to
/// `Debug`/`Display` its contents), used solely to produce a
/// `Signature` for each signed request, and is never placed in any
/// struct returned from this adapter's `ExecutionAdapter` methods —
/// those only ever return `OpenPosition`/`()`, which have no key field.
pub struct LiveExecutionAdapter {
    base_url: String,
    http: reqwest::Client,
    key: PrivateKey,
    is_mainnet: bool,
    slippage: f64,
}

impl LiveExecutionAdapter {
    pub fn new(base_url: impl Into<String>, key: PrivateKey, is_mainnet: bool) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
            key,
            is_mainnet,
            slippage: DEFAULT_MARKET_SLIPPAGE,
        }
    }

    /// The wallet's public address, safe to expose read-only to
    /// Express for dashboard display.
    pub fn public_address(&self) -> String {
        self.key.public_address()
    }

    async fn asset_index(&self, symbol: &str) -> Result<u32, ExecutionError> {
        let meta: MetaResponse = self
            .http
            .post(format!("{}/info", self.base_url))
            .json(&serde_json::json!({ "type": "meta" }))
            .send()
            .await
            .map_err(|e| ExecutionError(format!("meta request failed: {e}")))?
            .json()
            .await
            .map_err(|e| ExecutionError(format!("meta response invalid: {e}")))?;

        meta.universe
            .iter()
            .position(|u| u.name == symbol)
            .map(|i| i as u32)
            .ok_or_else(|| ExecutionError(format!("unknown symbol: {symbol}")))
    }

    async fn fetch_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        let state: ClearinghouseState = self
            .http
            .post(format!("{}/info", self.base_url))
            .json(&serde_json::json!({
                "type": "clearinghouseState",
                "user": self.public_address(),
            }))
            .send()
            .await
            .map_err(|e| ExecutionError(format!("clearinghouseState request failed: {e}")))?
            .json()
            .await
            .map_err(|e| ExecutionError(format!("clearinghouseState response invalid: {e}")))?;

        let entry = state
            .asset_positions
            .iter()
            .find(|entry| entry.position.coin == symbol);

        match entry {
            Some(entry) => parse_position(&entry.position),
            None => Ok(None),
        }
    }

    async fn place_order(
        &self,
        symbol: &str,
        is_buy: bool,
        size: f64,
        mid_price: f64,
        reduce_only: bool,
    ) -> Result<(), ExecutionError> {
        let asset = self.asset_index(symbol).await?;
        let price = market_order_price(mid_price, is_buy, self.slippage);

        let order = OrderRequest {
            asset,
            is_buy,
            price: format!("{price}"),
            size: format!("{size}"),
            reduce_only,
            order_type: OrderType::ioc(),
        };
        let action = OrderAction::single(order);
        let nonce_ms = Utc::now().timestamp_millis() as u64;
        let signature = sign_order_action(&self.key, &action, nonce_ms, self.is_mainnet)?;

        let body = serde_json::json!({
            "action": action,
            "nonce": nonce_ms,
            "signature": {
                "r": signature.r_hex(),
                "s": signature.s_hex(),
                "v": signature.v,
            },
        });

        let response: ExchangeResponse = self
            .http
            .post(format!("{}/exchange", self.base_url))
            .json(&body)
            .send()
            .await
            .map_err(|e| ExecutionError(format!("exchange request failed: {e}")))?
            .json()
            .await
            .map_err(|e| ExecutionError(format!("exchange response invalid: {e}")))?;

        if response.status != "ok" {
            return Err(ExecutionError(format!(
                "exchange rejected order: {:?}",
                response.response
            )));
        }

        Ok(())
    }
}

#[async_trait]
impl ExecutionAdapter for LiveExecutionAdapter {
    async fn get_position(&self, symbol: &str) -> Result<Option<OpenPosition>, ExecutionError> {
        self.fetch_position(symbol).await
    }

    async fn open(
        &self,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        let notional_usd = position_size_usd * leverage;
        let size = notional_usd / mid_price;
        let is_buy = matches!(direction, Direction::Long);

        self.place_order(symbol, is_buy, size, mid_price, false)
            .await?;

        tracing::info!(
            symbol,
            direction = direction.as_str(),
            notional_usd,
            "submitted live order to open position"
        );

        self.fetch_position(symbol).await?.ok_or_else(|| {
            ExecutionError("order submitted but no position found after open".to_string())
        })
    }

    async fn close(&self, symbol: &str, mid_price: f64) -> Result<(), ExecutionError> {
        let Some(position) = self.fetch_position(symbol).await? else {
            return Ok(());
        };

        // Closing sells a long (is_buy = false) and buys back a short
        // (is_buy = true).
        let is_buy = matches!(position.direction, Direction::Short);
        let size = position.notional_usd / position.entry_price.max(f64::EPSILON);

        self.place_order(symbol, is_buy, size, mid_price, true)
            .await?;

        tracing::info!(symbol, "submitted live order to close position");

        Ok(())
    }

    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        let state: ClearinghouseState = self
            .http
            .post(format!("{}/info", self.base_url))
            .json(&serde_json::json!({
                "type": "clearinghouseState",
                "user": self.public_address(),
            }))
            .send()
            .await
            .map_err(|e| ExecutionError(format!("clearinghouseState request failed: {e}")))?
            .json()
            .await
            .map_err(|e| ExecutionError(format!("clearinghouseState response invalid: {e}")))?;

        let mut positions = Vec::new();
        for entry in &state.asset_positions {
            if let Some(position) = parse_position(&entry.position)? {
                positions.push((entry.position.coin.clone(), position));
            }
        }
        Ok(positions)
    }

    /// Live funding is applied by Hyperliquid itself directly against
    /// the account's on-chain balance; there is nothing for the engine
    /// to simulate or record here (unlike `MockExecutionAdapter`, which
    /// owns the entire mock wallet ledger).
    async fn apply_funding(&self, _symbol: &str, _amount_usd: f64) -> Result<(), ExecutionError> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const TEST_KEY_HEX: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    fn adapter_against(server: &MockServer) -> LiveExecutionAdapter {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        LiveExecutionAdapter::new(server.uri(), key, true)
    }

    #[tokio::test]
    async fn get_position_returns_none_when_the_symbol_has_no_open_position() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "assetPositions": [] })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        assert_eq!(adapter.get_position("BTC").await.unwrap(), None);
    }

    #[tokio::test]
    async fn get_position_parses_a_long_position() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "assetPositions": [
                    { "position": { "coin": "BTC", "szi": "0.5", "entryPx": "50000" } }
                ]
            })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        let position = adapter.get_position("BTC").await.unwrap().unwrap();
        assert_eq!(position.direction, Direction::Long);
        assert_eq!(position.entry_price, 50000.0);
        assert_eq!(position.notional_usd, 25000.0);
    }

    #[tokio::test]
    async fn get_position_parses_a_short_position() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "assetPositions": [
                    { "position": { "coin": "ETH", "szi": "-2", "entryPx": "3000" } }
                ]
            })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        let position = adapter.get_position("ETH").await.unwrap().unwrap();
        assert_eq!(position.direction, Direction::Short);
        assert_eq!(position.notional_usd, 6000.0);
    }

    #[tokio::test]
    async fn open_submits_a_signed_order_and_returns_the_resulting_position() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }]
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/exchange"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "ok", "response": {} })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "assetPositions": [
                    { "position": { "coin": "BTC", "szi": "0.02", "entryPx": "50000" } }
                ]
            })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        let position = adapter
            .open("BTC", Direction::Long, 1000.0, 1.0, 50000.0)
            .await
            .unwrap();
        assert_eq!(position.direction, Direction::Long);
    }

    #[tokio::test]
    async fn open_fails_when_the_exchange_rejects_the_order() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/exchange"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "err",
                "response": "insufficient margin"
            })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        let error = adapter
            .open("BTC", Direction::Long, 1000.0, 1.0, 50000.0)
            .await
            .unwrap_err();
        assert!(error.0.contains("rejected"));
    }

    #[tokio::test]
    async fn close_is_a_no_op_when_there_is_no_open_position() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "assetPositions": [] })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server);
        adapter.close("BTC", 50000.0).await.unwrap();
    }

    #[tokio::test]
    async fn apply_funding_is_a_no_op_for_live_positions() {
        let server = MockServer::start().await;
        let adapter = adapter_against(&server);
        adapter.apply_funding("BTC", 12.5).await.unwrap();
    }

    #[test]
    fn public_address_is_derived_from_the_configured_key() {
        let server_url = "https://example.invalid";
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let adapter = LiveExecutionAdapter::new(server_url, key, true);
        assert!(adapter.public_address().starts_with("0x"));
        assert_eq!(adapter.public_address().len(), 42);
    }
}
