use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;

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
    #[serde(rename = "withdrawable", default)]
    withdrawable: String,
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
    pool: PgPool,
    wallet_id: String,
}

impl LiveExecutionAdapter {
    /// `pool`/`wallet_id` back this adapter's persisted virtual position
    /// state (the `live_positions` table) — the engine's own record of
    /// what it believes is open, read on every decision cycle instead of
    /// calling Hyperliquid each time. `wallet_id` identifies the row in
    /// the `wallets` table this adapter is scoped to, mirroring
    /// `MockExecutionAdapter`.
    pub fn new(
        base_url: impl Into<String>,
        key: PrivateKey,
        is_mainnet: bool,
        pool: PgPool,
        wallet_id: String,
    ) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
            key,
            is_mainnet,
            slippage: DEFAULT_MARKET_SLIPPAGE,
            pool,
            wallet_id,
        }
    }

    /// The wallet's public address, safe to expose read-only to
    /// Express for dashboard display.
    pub fn public_address(&self) -> String {
        self.key.public_address()
    }

    /// The account's on-chain withdrawable USD balance, as reported by
    /// Hyperliquid's `clearinghouseState`. Used to cap position sizes so
    /// an order is never submitted for more than the account can cover.
    async fn account_withdrawable_usd(&self) -> Result<f64, ExecutionError> {
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

        state.withdrawable.parse().map_err(|_| {
            ExecutionError(format!(
                "could not parse withdrawable balance: {}",
                state.withdrawable
            ))
        })
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

    /// Reads the real position straight from Hyperliquid's
    /// `clearinghouseState` — the exchange's own truth, as opposed to
    /// `read_virtual_position`'s engine-owned record. Used here only to
    /// confirm a fill immediately after placing an order; the reconcile
    /// loop (a later slice) is what calls this on a schedule to detect
    /// drift between the two.
    async fn fetch_exchange_position(
        &self,
        symbol: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError> {
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

    /// Reads this session's virtual position — the engine's own record
    /// of what it believes is open, written by `open`/`close` — rather
    /// than calling Hyperliquid.
    async fn read_virtual_position(
        &self,
        session_id: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError> {
        let row = sqlx::query_as::<_, (String, f64, f64, DateTime<Utc>)>(
            "SELECT direction, entry_price, notional_usd, opened_at FROM live_positions WHERE session_id = $1::uuid",
        )
        .bind(session_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read virtual position: {e}")))?;

        Ok(row.map(
            |(direction, entry_price, notional_usd, opened_at)| OpenPosition {
                direction: if direction == "long" {
                    Direction::Long
                } else {
                    Direction::Short
                },
                entry_price,
                notional_usd,
                opened_at,
            },
        ))
    }

    /// Upserts this session's virtual position after a confirmed open.
    async fn write_virtual_position(
        &self,
        session_id: &str,
        symbol: &str,
        position: OpenPosition,
    ) -> Result<(), ExecutionError> {
        sqlx::query(
            r#"
            INSERT INTO live_positions (session_id, symbol, direction, entry_price, notional_usd, opened_at, wallet_id)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid)
            ON CONFLICT (session_id) DO UPDATE SET
                symbol = EXCLUDED.symbol,
                direction = EXCLUDED.direction,
                entry_price = EXCLUDED.entry_price,
                notional_usd = EXCLUDED.notional_usd,
                opened_at = EXCLUDED.opened_at,
                wallet_id = EXCLUDED.wallet_id
            "#,
        )
        .bind(session_id)
        .bind(symbol)
        .bind(position.direction.as_str())
        .bind(position.entry_price)
        .bind(position.notional_usd)
        .bind(position.opened_at)
        .bind(&self.wallet_id)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to write virtual position: {e}")))?;

        Ok(())
    }

    /// Clears this session's virtual position after a confirmed close.
    async fn delete_virtual_position(&self, session_id: &str) -> Result<(), ExecutionError> {
        sqlx::query("DELETE FROM live_positions WHERE session_id = $1::uuid")
            .bind(session_id)
            .execute(&self.pool)
            .await
            .map_err(|e| ExecutionError(format!("failed to clear virtual position: {e}")))?;

        Ok(())
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
    /// Hyperliquid itself has no session concept — it nets to one
    /// position per wallet+symbol regardless of which session is driving
    /// it (wallet exclusivity guarantees at most one non-closed session
    /// drives a given live wallet at a time) — but the engine's own
    /// virtual state is still keyed by `session_id`, mirroring
    /// `MockExecutionAdapter`, so this reads that record rather than
    /// calling Hyperliquid on every decision cycle.
    async fn get_position(
        &self,
        session_id: &str,
        _symbol: &str,
    ) -> Result<Option<OpenPosition>, ExecutionError> {
        self.read_virtual_position(session_id).await
    }

    async fn open(
        &self,
        session_id: &str,
        symbol: &str,
        direction: Direction,
        position_size_usd: f64,
        leverage: f64,
        mid_price: f64,
    ) -> Result<OpenPosition, ExecutionError> {
        // A fixed session size may exceed what the account can actually
        // trade after earlier losses; clamp to the withdrawable balance
        // instead of sending an order the exchange will reject.
        let available_usd: f64 = self.account_withdrawable_usd().await?;
        let position_size_usd =
            super::execution::clamp_position_size_usd(position_size_usd, available_usd)
                .map_err(ExecutionError)?;
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

        let position = self.fetch_exchange_position(symbol).await?.ok_or_else(|| {
            ExecutionError("order submitted but no position found after open".to_string())
        })?;

        self.write_virtual_position(session_id, symbol, position)
            .await?;

        Ok(position)
    }

    async fn close(
        &self,
        session_id: &str,
        symbol: &str,
        mid_price: f64,
    ) -> Result<(), ExecutionError> {
        let Some(position) = self.read_virtual_position(session_id).await? else {
            return Ok(());
        };

        // Closing sells a long (is_buy = false) and buys back a short
        // (is_buy = true).
        let is_buy = matches!(position.direction, Direction::Short);
        let size = position.notional_usd / position.entry_price.max(f64::EPSILON);

        self.place_order(symbol, is_buy, size, mid_price, true)
            .await?;

        self.delete_virtual_position(session_id).await?;

        tracing::info!(symbol, "submitted live order to close position");

        Ok(())
    }

    /// Reads this wallet's open virtual positions, mirroring
    /// `MockExecutionAdapter::list_open_positions` — used by the funding
    /// sweep, which needs the engine's own record rather than an extra
    /// Hyperliquid round-trip per wallet.
    async fn list_open_positions(&self) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
        let rows = sqlx::query_as::<_, (String, String, f64, f64, DateTime<Utc>)>(
            "SELECT symbol, direction, entry_price, notional_usd, opened_at FROM live_positions WHERE wallet_id = $1::uuid",
        )
        .bind(&self.wallet_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to list virtual positions: {e}")))?;

        Ok(rows
            .into_iter()
            .map(
                |(symbol, direction, entry_price, notional_usd, opened_at)| {
                    let position = OpenPosition {
                        direction: if direction == "long" {
                            Direction::Long
                        } else {
                            Direction::Short
                        },
                        entry_price,
                        notional_usd,
                        opened_at,
                    };
                    (symbol, position)
                },
            )
            .collect())
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
    use sqlx::postgres::PgPoolOptions;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const TEST_KEY_HEX: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    fn test_database_url() -> String {
        std::env::var("TEST_DATABASE_URL")
            .unwrap_or_else(|_| "postgres://jeeva:jeeva@localhost:5432/jeeva_test".to_string())
    }

    async fn pool() -> PgPool {
        PgPoolOptions::new()
            .connect(&test_database_url())
            .await
            .expect("failed to connect to TimescaleDB")
    }

    /// Inserts (or replaces) a `live` wallet row for `wallet_id` and
    /// clears any virtual position rows for `session_id`, so each test
    /// starts from a clean slate regardless of run order.
    async fn reset_wallet_and_position(pool: &PgPool, wallet_id: &str, session_id: &str) {
        sqlx::query("DELETE FROM live_positions WHERE session_id = $1::uuid")
            .bind(session_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM wallets WHERE id = $1::uuid")
            .bind(wallet_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO wallets (id, label, kind) VALUES ($1::uuid, $2, 'live')")
            .bind(wallet_id)
            .bind(format!("live-execution-test-wallet-{wallet_id}"))
            .execute(pool)
            .await
            .unwrap();
    }

    async fn adapter_against(server: &MockServer, pool: PgPool, wallet_id: &str) -> LiveExecutionAdapter {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        LiveExecutionAdapter::new(server.uri(), key, true, pool, wallet_id.to_string())
    }

    #[test]
    fn parse_position_returns_none_for_a_flat_position() {
        let raw = RawPosition {
            coin: "BTC".to_string(),
            szi: "0".to_string(),
            entry_px: Some("50000".to_string()),
        };
        assert_eq!(parse_position(&raw).unwrap(), None);
    }

    #[test]
    fn parse_position_parses_a_long_position() {
        let raw = RawPosition {
            coin: "BTC".to_string(),
            szi: "0.5".to_string(),
            entry_px: Some("50000".to_string()),
        };
        let position = parse_position(&raw).unwrap().unwrap();
        assert_eq!(position.direction, Direction::Long);
        assert_eq!(position.entry_price, 50000.0);
        assert_eq!(position.notional_usd, 25000.0);
    }

    #[test]
    fn parse_position_parses_a_short_position() {
        let raw = RawPosition {
            coin: "ETH".to_string(),
            szi: "-2".to_string(),
            entry_px: Some("3000".to_string()),
        };
        let position = parse_position(&raw).unwrap().unwrap();
        assert_eq!(position.direction, Direction::Short);
        assert_eq!(position.notional_usd, 6000.0);
    }

    #[tokio::test]
    async fn get_position_returns_none_when_no_virtual_position_is_recorded() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000f1";
        let session_id = "00000000-0000-0000-0000-0000000000f2";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        let adapter = adapter_against(&server, pool, wallet_id).await;
        assert_eq!(adapter.get_position(session_id, "BTC").await.unwrap(), None);
    }

    #[tokio::test]
    async fn open_submits_a_signed_order_and_persists_virtual_state() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000f3";
        let session_id = "00000000-0000-0000-0000-0000000000f4";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        // First /info call: balance read (withdrawable) before the order.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "assetPositions": []
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        // Second /info call: asset index lookup for the order.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }],
                "assetPositions": []
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
        // Remaining /info calls: the post-order position fetch used to
        // confirm the fill before persisting virtual state.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "assetPositions": [
                    { "position": { "coin": "BTC", "szi": "0.02", "entryPx": "50000" } }
                ]
            })))
            .mount(&server)
            .await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id).await;
        let position = adapter
            .open(session_id, "BTC", Direction::Long, 1000.0, 1.0, 50000.0)
            .await
            .unwrap();
        assert_eq!(position.direction, Direction::Long);

        // Reconstructing the adapter against the same pool still finds
        // the persisted virtual position — it survives an engine restart.
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let restarted = LiveExecutionAdapter::new(server.uri(), key, true, pool, wallet_id.to_string());
        let fetched = restarted
            .get_position(session_id, "BTC")
            .await
            .unwrap()
            .unwrap();
        // Postgres truncates timestamptz to microsecond precision, so
        // compare fields individually rather than deriving equality on
        // the whole struct against the pre-round-trip value.
        assert_eq!(fetched.direction, position.direction);
        assert_eq!(fetched.entry_price, position.entry_price);
        assert_eq!(fetched.notional_usd, position.notional_usd);
    }

    #[tokio::test]
    async fn open_fails_when_the_exchange_rejects_the_order() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000f5";
        let session_id = "00000000-0000-0000-0000-0000000000f6";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "assetPositions": [],
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

        let adapter = adapter_against(&server, pool.clone(), wallet_id).await;
        let error = adapter
            .open(session_id, "BTC", Direction::Long, 1000.0, 1.0, 50000.0)
            .await
            .unwrap_err();
        assert!(error.0.contains("rejected"));
        assert_eq!(adapter.get_position(session_id, "BTC").await.unwrap(), None);
    }

    #[tokio::test]
    async fn close_is_a_no_op_when_there_is_no_virtual_position() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000f7";
        let session_id = "00000000-0000-0000-0000-0000000000f8";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        let adapter = adapter_against(&server, pool, wallet_id).await;
        // No mocks mounted: close() must not hit the exchange at all when
        // there's no virtual position to close.
        adapter.close(session_id, "BTC", 50000.0).await.unwrap();
    }

    #[tokio::test]
    async fn close_places_an_order_and_clears_virtual_state() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000f9";
        let session_id = "00000000-0000-0000-0000-0000000000fa";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        // asset_index lookup for the closing order.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }]
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/exchange"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "ok", "response": {} })),
            )
            .mount(&server)
            .await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id).await;
        // Seed virtual state directly rather than going through open(),
        // to keep this test focused on close()'s own behavior.
        adapter
            .write_virtual_position(
                session_id,
                "BTC",
                OpenPosition {
                    direction: Direction::Long,
                    entry_price: 50000.0,
                    notional_usd: 1000.0,
                    opened_at: Utc::now(),
                },
            )
            .await
            .unwrap();

        adapter.close(session_id, "BTC", 51000.0).await.unwrap();

        assert_eq!(adapter.get_position(session_id, "BTC").await.unwrap(), None);
    }

    #[tokio::test]
    async fn apply_funding_is_a_no_op_for_live_positions() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000fb";
        let session_id = "00000000-0000-0000-0000-0000000000fc";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        let adapter = adapter_against(&server, pool, wallet_id).await;
        adapter.apply_funding("BTC", 12.5).await.unwrap();
    }

    #[tokio::test]
    async fn public_address_is_derived_from_the_configured_key() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-0000000000fd";
        let session_id = "00000000-0000-0000-0000-0000000000fe";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server_url = "https://example.invalid";
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let adapter = LiveExecutionAdapter::new(server_url, key, true, pool, wallet_id.to_string());
        assert!(adapter.public_address().starts_with("0x"));
        assert_eq!(adapter.public_address().len(), 42);
    }
}
