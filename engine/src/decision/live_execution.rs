use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use aes_gcm::aead::rand_core::{OsRng, RngCore};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use sqlx::PgPool;
use tokio::sync::Mutex;

use super::execution::{
    execution_coordinator, DriftAction, DriftEvent, DriftOutcome, DriftPolicy, ExecutionAdapter,
    ExecutionError, OpenPosition, ReconcileTarget,
};
use super::hyperliquid_signing::{
    market_order_price, sign_order_action, KeyError, OrderAction, OrderRequest, OrderType,
    PrivateKey, Signature,
};
use super::model::Direction;

const DEFAULT_MARKET_SLIPPAGE: f64 = 0.05;
const MAX_STALE_PRICE_MOVE: f64 = 0.05;

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

fn client_order_id() -> String {
    // Hyperliquid requires a 128-bit client id. Two random u64 values
    // provide the full width without pulling UUID formatting (and its
    // hyphenation) into the signed exchange payload.
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("0x{}", hex::encode(bytes))
}

/// In-process cache of the outstanding order attempt per wallet+PERP,
/// so the wallet registry's periodic adapter replacement doesn't lose it
/// mid-flight. The durable copy of record lives in `live_order_attempts`
/// (Postgres), which is what an engine restart reads; this map is only a
/// fast path. The key is scoped by both wallet and PERP so neither wallet
/// refreshes nor concurrent markets overwrite each other.
fn ambiguous_submissions() -> &'static Mutex<HashMap<(String, String), PendingOrder>> {
    static SUBMISSIONS: OnceLock<Mutex<HashMap<(String, String), PendingOrder>>> = OnceLock::new();
    SUBMISSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// One signed-but-unconfirmed live order, kept until the exchange reports
/// a terminal status for its client order id. Holds everything needed to
/// re-send the byte-identical request: the exact signed `action`, the
/// `nonce` and signature it was signed with, and the order's economic
/// terms for recognising a matching retry.
#[derive(Clone, Debug, PartialEq)]
struct PendingOrder {
    action: OrderAction,
    client_order_id: String,
    nonce_ms: u64,
    signature: Signature,
    is_buy: bool,
    size: f64,
    mid_price: f64,
    reduce_only: bool,
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
    drift_policy: DriftPolicy,
    /// Serializes all order/close/reconcile operations for this wallet.
    operation_guards: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    decision_started_at: Mutex<HashMap<String, Instant>>,
}

impl LiveExecutionAdapter {
    /// `pool`/`wallet_id` back this adapter's persisted virtual position
    /// state (the `live_positions` table) — the engine's own record of
    /// what it believes is open, read on every decision cycle instead of
    /// calling Hyperliquid each time. `wallet_id` identifies the row in
    /// the `wallets` table this adapter is scoped to, mirroring
    /// `MockExecutionAdapter`. Starts with `DriftPolicy::default()`; use
    /// `with_drift_policy` to configure a different one for this
    /// instance.
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
            drift_policy: DriftPolicy::default(),
            operation_guards: Arc::new(Mutex::new(HashMap::new())),
            decision_started_at: Mutex::new(HashMap::new()),
        }
    }

    /// Configures this instance's drift policy — see `DriftPolicy` for
    /// why this is per-adapter rather than a single engine-wide setting.
    pub fn with_drift_policy(mut self, drift_policy: DriftPolicy) -> Self {
        self.drift_policy = drift_policy;
        self
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

    /// Every open position this wallet's Hyperliquid account currently
    /// reports, symbol-keyed — used by `reconcile` to catch positions no
    /// known session's virtual state accounts for at all (as opposed to
    /// `fetch_exchange_position`, which checks one symbol a session
    /// already claims).
    async fn fetch_all_exchange_positions(
        &self,
    ) -> Result<Vec<(String, OpenPosition)>, ExecutionError> {
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

    async fn begin_decision(&self, symbol: &str) {
        self.decision_started_at
            .lock()
            .await
            .insert(symbol.to_string(), Instant::now());
    }

    async fn decision_is_fresh(&self, symbol: &str, max_age: Duration) -> bool {
        self.decision_started_at
            .lock()
            .await
            .get(symbol)
            .is_some_and(|started| started.elapsed() <= max_age)
    }

    async fn operation_guard(&self, symbol: &str) -> Arc<Mutex<()>> {
        self.operation_guards
            .lock()
            .await
            .entry(symbol.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Places whatever order brings the exchange's position for
    /// `symbol` to flat. Uses `position.entry_price` as the basis for
    /// `place_order`'s slippage-padded limit price — reconcile has no
    /// live mid-price feed of its own, so this is a best-effort
    /// reference rather than a current mark price; the IOC order type
    /// means an unfavorable price simply fails to fill rather than
    /// executing at a bad one.
    async fn flatten_exchange_position(
        &self,
        symbol: &str,
        position: OpenPosition,
    ) -> Result<(), ExecutionError> {
        let is_buy = matches!(position.direction, Direction::Short);
        let size = position.notional_usd / position.entry_price.max(f64::EPSILON);
        self.place_order(symbol, is_buy, size, position.entry_price, true)
            .await
    }

    /// Attempts to bring the exchange's position for `symbol` in line
    /// with `target` (virtual state's own belief): opens the full
    /// target size from flat, flattens-then-opens when the current
    /// position runs the opposite direction, or tops up/trims the
    /// existing same-direction position by the notional delta
    /// otherwise. Same reference-price caveat as
    /// `flatten_exchange_position`.
    async fn resubmit_to_match(
        &self,
        symbol: &str,
        target: OpenPosition,
    ) -> Result<(), ExecutionError> {
        let current = self.fetch_exchange_position(symbol).await?;

        match current {
            None => {
                let is_buy = matches!(target.direction, Direction::Long);
                let size = target.notional_usd / target.entry_price.max(f64::EPSILON);
                self.place_order(symbol, is_buy, size, target.entry_price, false)
                    .await
            }
            Some(current) if current.direction != target.direction => {
                self.flatten_exchange_position(symbol, current).await?;
                let is_buy = matches!(target.direction, Direction::Long);
                let size = target.notional_usd / target.entry_price.max(f64::EPSILON);
                self.place_order(symbol, is_buy, size, target.entry_price, false)
                    .await
            }
            Some(current) => {
                let delta = target.notional_usd - current.notional_usd;
                if delta.abs() < f64::EPSILON.max(target.notional_usd * 1e-6) {
                    return Ok(());
                }
                let is_buy = if delta > 0.0 {
                    matches!(target.direction, Direction::Long)
                } else {
                    matches!(target.direction, Direction::Short)
                };
                let size = delta.abs() / target.entry_price.max(f64::EPSILON);
                let reduce_only = delta < 0.0;
                self.place_order(symbol, is_buy, size, target.entry_price, reduce_only)
                    .await
            }
        }
    }

    /// Carries out `action` for one drift `event`, using whichever of
    /// `virtual_position`/`exchange_position` are relevant to it. Never
    /// panics on a missing session id or position — `Halt` and a policy
    /// action with nothing meaningful to act on (e.g. `ReSubmit` with no
    /// session to re-target) both resolve to a no-op `Ok(())`.
    async fn apply_drift_action(
        &self,
        event: &DriftEvent,
        action: DriftAction,
        virtual_position: Option<OpenPosition>,
        exchange_position: Option<OpenPosition>,
    ) -> Result<(), ExecutionError> {
        let symbol = event.symbol();
        let session_id = event.session_id();

        match action {
            DriftAction::Halt => {
                sqlx::query(
                    r#"
                    INSERT INTO live_execution_holds (wallet_id, symbol, reason)
                    VALUES ($1::uuid, $2, $3)
                    ON CONFLICT (wallet_id, symbol) DO UPDATE SET reason = EXCLUDED.reason
                    "#,
                )
                .bind(&self.wallet_id)
                .bind(symbol)
                .bind(format!("drift policy halt: {event:?}"))
                .execute(&self.pool)
                .await
                .map_err(|e| {
                    ExecutionError(format!("failed to persist live execution hold: {e}"))
                })?;
                Ok(())
            }
            DriftAction::AdoptAndLog => match (session_id, exchange_position) {
                (Some(session_id), Some(exchange)) => {
                    self.write_virtual_position(session_id, symbol, exchange)
                        .await
                }
                (Some(session_id), None) => self.delete_virtual_position(session_id).await,
                (None, _) => Ok(()),
            },
            DriftAction::Flatten => {
                if let Some(exchange) = exchange_position {
                    self.flatten_exchange_position(symbol, exchange).await?;
                    if self.fetch_exchange_position(symbol).await?.is_some() {
                        return Err(ExecutionError(
                            "reconcile flatten submitted but exchange still reports a position"
                                .to_string(),
                        ));
                    }
                }
                self.clear_confirmed_pending_order(symbol).await?;
                if let Some(session_id) = session_id {
                    self.delete_virtual_position(session_id).await?;
                }
                Ok(())
            }
            DriftAction::ReSubmit => match (session_id, virtual_position) {
                (Some(session_id), Some(target)) => {
                    self.resubmit_to_match(symbol, target).await?;
                    let confirmed =
                        self.fetch_exchange_position(symbol).await?.ok_or_else(|| {
                            ExecutionError(
                                "reconcile resubmit submitted but exchange reports no position"
                                    .to_string(),
                            )
                        })?;
                    if confirmed.direction != target.direction
                        || (confirmed.notional_usd - target.notional_usd).abs()
                            > f64::EPSILON.max(target.notional_usd * 1e-6)
                    {
                        return Err(ExecutionError(
                            "reconcile resubmit did not converge exchange position".to_string(),
                        ));
                    }
                    self.clear_confirmed_pending_order(symbol).await?;
                    self.write_virtual_position(session_id, symbol, confirmed)
                        .await
                }
                _ => Ok(()),
            },
        }
    }

    async fn clear_ambiguous_submission(&self, symbol: &str) -> bool {
        let key = (self.wallet_id.clone(), symbol.to_string());
        let removed = ambiguous_submissions().lock().await.remove(&key).is_some();
        match sqlx::query(
            "DELETE FROM live_order_attempts WHERE wallet_id = $1::uuid AND symbol = $2",
        )
        .bind(&self.wallet_id)
        .bind(symbol)
        .execute(&self.pool)
        .await
        {
            Ok(result) => removed || result.rows_affected() > 0,
            Err(error) => {
                tracing::error!(symbol, %error, "failed to clear persisted order attempt");
                false
            }
        }
    }

    async fn has_ambiguous_submission(&self, symbol: &str) -> bool {
        let in_memory = ambiguous_submissions()
            .lock()
            .await
            .contains_key(&(self.wallet_id.clone(), symbol.to_string()));
        if in_memory {
            return true;
        }
        self.load_pending_order(symbol)
            .await
            .map(|pending| pending.is_some())
            // Fail closed: if the durable attempt can't be read we can't
            // tell whether an order is outstanding, so assume it is.
            .unwrap_or(true)
    }

    async fn persist_pending_order(
        &self,
        symbol: &str,
        pending: &PendingOrder,
    ) -> Result<(), ExecutionError> {
        let action =
            serde_json::to_value(&pending.action).map_err(|e| ExecutionError(e.to_string()))?;
        sqlx::query(
            r#"
            INSERT INTO live_order_attempts
              (wallet_id, symbol, client_order_id, action, nonce, signature_r, signature_s, signature_v, is_buy, size, mid_price, reduce_only)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (wallet_id, symbol) DO NOTHING
            "#,
        )
        .bind(&self.wallet_id)
        .bind(symbol)
        .bind(&pending.client_order_id)
        .bind(action)
        .bind(pending.nonce_ms as i64)
        .bind(pending.signature.r_hex())
        .bind(pending.signature.s_hex())
        .bind(pending.signature.v as i32)
        .bind(pending.is_buy)
        .bind(pending.size)
        .bind(pending.mid_price)
        .bind(pending.reduce_only)
        .execute(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to persist live order attempt: {e}")))?;
        Ok(())
    }

    async fn load_pending_order(
        &self,
        symbol: &str,
    ) -> Result<Option<PendingOrder>, ExecutionError> {
        let row = sqlx::query_as::<_, (String, serde_json::Value, i64, String, String, i32, bool, f64, f64, bool)>(
            "SELECT client_order_id, action, nonce, signature_r, signature_s, signature_v, is_buy, size, mid_price, reduce_only FROM live_order_attempts WHERE wallet_id = $1::uuid AND symbol = $2",
        )
        .bind(&self.wallet_id)
        .bind(symbol)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to load live order attempt: {e}")))?;
        let Some((client_order_id, action, nonce, r, s, v, is_buy, size, mid_price, reduce_only)) =
            row
        else {
            return Ok(None);
        };
        let action = serde_json::from_value(action)
            .map_err(|e| ExecutionError(format!("invalid persisted order action: {e}")))?;
        let decode = |value: String| {
            let bytes = hex::decode(value.trim_start_matches("0x"))
                .map_err(|e| ExecutionError(format!("invalid persisted signature: {e}")))?;
            bytes
                .try_into()
                .map_err(|_| ExecutionError("invalid persisted signature length".to_string()))
        };
        Ok(Some(PendingOrder {
            action,
            client_order_id,
            nonce_ms: nonce as u64,
            signature: Signature {
                r: decode(r)?,
                s: decode(s)?,
                v: v as u8,
            },
            is_buy,
            size,
            mid_price,
            reduce_only,
        }))
    }

    async fn retry_ambiguous_submission(&self, symbol: &str) -> Result<(), ExecutionError> {
        let pending = self
            .load_pending_order(symbol)
            .await?
            .ok_or_else(|| ExecutionError("ambiguous order changed during retry".to_string()))?;
        self.send_signed_order(symbol, &pending).await
    }

    /// True once a live order's outcome has been observed as terminal.
    /// Hyperliquid reports the terminal states of an IOC order as
    /// `filled`, any `*Canceled`/`*Rejected` variant, or no record at
    /// all when the order never reached the book.
    fn is_terminal_order_status(status: &str) -> bool {
        status != "open" && status != "triggered"
    }

    async fn order_status(&self, client_order_id: &str) -> Result<Option<String>, ExecutionError> {
        let response = self
            .http
            .post(format!("{}/info", self.base_url))
            .json(&serde_json::json!({
                "type": "orderStatus",
                "user": self.public_address(),
                "oid": client_order_id,
            }))
            .send()
            .await
            .map_err(|e| ExecutionError(format!("orderStatus request failed: {e}")))?
            .json::<serde_json::Value>()
            .await
            .map_err(|e| ExecutionError(format!("orderStatus response invalid: {e}")))?;
        let status = response
            .pointer("/order/status")
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                response
                    .pointer("/response/status")
                    .and_then(serde_json::Value::as_str)
            })
            .or_else(|| {
                response
                    .pointer("/response/order/status")
                    .and_then(serde_json::Value::as_str)
            })
            .or_else(|| response.get("status").and_then(serde_json::Value::as_str));
        Ok(status.map(str::to_string))
    }

    async fn clear_confirmed_pending_order(&self, symbol: &str) -> Result<(), ExecutionError> {
        if let Some(pending) = self.load_pending_order(symbol).await? {
            match self.order_status(&pending.client_order_id).await? {
                // `None` means the exchange has no record of the cloid at
                // all: the submission never reached the book, so nothing is
                // left to wait for. A terminal status proves the same in
                // its own way. Anything still live keeps the marker, so a
                // second logical order can never be created behind it.
                None => {
                    self.clear_ambiguous_submission(symbol).await;
                }
                Some(status) if Self::is_terminal_order_status(&status) => {
                    self.clear_ambiguous_submission(symbol).await;
                }
                Some(_) => {}
            }
        }
        Ok(())
    }

    async fn ensure_pending_order_resolved(&self, symbol: &str) -> Result<(), ExecutionError> {
        self.clear_confirmed_pending_order(symbol).await?;
        if self.has_ambiguous_submission(symbol).await {
            return Err(ExecutionError(
                "live order outcome is still unresolved; refusing a new order".to_string(),
            ));
        }
        Ok(())
    }

    async fn is_halted(&self, symbol: &str) -> Result<bool, ExecutionError> {
        sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM live_execution_holds WHERE wallet_id = $1::uuid AND symbol = $2)",
        )
        .bind(&self.wallet_id)
        .bind(symbol)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| ExecutionError(format!("failed to read live execution hold: {e}")))
    }

    async fn clear_halt(&self, symbol: &str) -> Result<(), ExecutionError> {
        sqlx::query("DELETE FROM live_execution_holds WHERE wallet_id = $1::uuid AND symbol = $2")
            .bind(&self.wallet_id)
            .bind(symbol)
            .execute(&self.pool)
            .await
            .map_err(|e| ExecutionError(format!("failed to clear live execution hold: {e}")))?;
        Ok(())
    }

    async fn position_matches_decision(
        &self,
        _session_id: &str,
        symbol: &str,
        expected: Option<OpenPosition>,
    ) -> Result<bool, ExecutionError> {
        let Some(expected) = expected else {
            return Ok(self.fetch_exchange_position(symbol).await?.is_none());
        };
        let Some(actual) = self.fetch_exchange_position(symbol).await? else {
            return Ok(false);
        };
        Ok(actual.direction == expected.direction
            && (actual.notional_usd - expected.notional_usd).abs()
                <= f64::EPSILON.max(expected.notional_usd * 1e-6))
    }

    async fn place_order(
        &self,
        symbol: &str,
        is_buy: bool,
        size: f64,
        mid_price: f64,
        reduce_only: bool,
    ) -> Result<(), ExecutionError> {
        // Each PERP has at most one outstanding order attempt, so the
        // marker is per-symbol rather than a stack. The exact signed
        // logical order survives a transport failure and a wallet-registry
        // refresh: a retry reuses its action, nonce, and signature rather
        // than creating a second identity. Only a confirmed terminal
        // status (see `clear_confirmed_pending_order`) may discard it.
        let key = (self.wallet_id.clone(), symbol.to_string());
        let persisted = self.load_pending_order(symbol).await?;
        let pending = ambiguous_submissions()
            .lock()
            .await
            .get(&key)
            .cloned()
            .or(persisted);
        let pending = match pending {
            Some(pending)
                if pending.is_buy == is_buy
                    && pending.size == size
                    && pending.mid_price == mid_price
                    && pending.reduce_only == reduce_only =>
            {
                pending
            }
            // A different outstanding order on the same PERP. Refuse
            // rather than overwrite: dropping the marker would allow a
            // second logical order behind one whose outcome is unknown.
            Some(_) => {
                return Err(ExecutionError(
                    "previous order submission is ambiguous; reconciliation required".to_string(),
                ));
            }
            None => {
                let asset = self.asset_index(symbol).await?;
                let price = market_order_price(mid_price, is_buy, self.slippage);
                let order = OrderRequest {
                    asset,
                    is_buy,
                    price: format!("{price}"),
                    size: format!("{size}"),
                    reduce_only,
                    order_type: OrderType::ioc(),
                    cloid: Some(client_order_id()),
                };
                let pending_cloid = order.cloid.clone().expect("cloid generated above");
                let action = OrderAction::single(order);
                let nonce_ms = Utc::now().timestamp_millis() as u64;
                let signature = sign_order_action(&self.key, &action, nonce_ms, self.is_mainnet)?;
                let pending = PendingOrder {
                    action,
                    client_order_id: pending_cloid,
                    nonce_ms,
                    signature,
                    is_buy,
                    size,
                    mid_price,
                    reduce_only,
                };
                self.persist_pending_order(symbol, &pending).await?;
                ambiguous_submissions()
                    .lock()
                    .await
                    .insert(key.clone(), pending.clone());
                pending
            }
        };
        self.send_signed_order(symbol, &pending).await
    }

    async fn send_signed_order(
        &self,
        symbol: &str,
        pending: &PendingOrder,
    ) -> Result<(), ExecutionError> {
        let PendingOrder {
            action,
            nonce_ms,
            signature,
            ..
        } = pending;

        let body = serde_json::json!({
            "action": &action,
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
            self.clear_ambiguous_submission(symbol).await;
            return Err(ExecutionError(format!(
                "exchange rejected order: {:?}",
                response.response
            )));
        }

        // Keep the marker through the caller’s post-submit exchange read.
        // A successful HTTP response alone does not prove the order's
        // final state was observed.
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

    async fn needs_execution_coordination(&self) -> bool {
        true
    }

    async fn is_halted(&self, symbol: &str) -> Result<bool, ExecutionError> {
        self.is_halted(symbol).await
    }

    async fn clear_halt(&self, symbol: &str) -> Result<(), ExecutionError> {
        self.clear_halt(symbol).await
    }

    async fn position_matches_decision(
        &self,
        session_id: &str,
        symbol: &str,
        expected: Option<OpenPosition>,
    ) -> Result<bool, ExecutionError> {
        self.position_matches_decision(session_id, symbol, expected)
            .await
    }

    async fn mark_decision_started(&self, symbol: &str) {
        self.begin_decision(symbol).await;
    }

    async fn decision_is_fresh(
        &self,
        symbol: &str,
        latest_mid_price: f64,
        reference_mid_price: f64,
        max_age: Duration,
    ) -> Result<bool, ExecutionError> {
        if !self.decision_is_fresh(symbol, max_age).await {
            return Ok(false);
        }
        if !latest_mid_price.is_finite()
            || !reference_mid_price.is_finite()
            || reference_mid_price <= 0.0
        {
            return Ok(false);
        }
        let relative_move = (latest_mid_price - reference_mid_price).abs() / reference_mid_price;
        Ok(relative_move <= MAX_STALE_PRICE_MOVE)
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
        let operation_guard = self.operation_guard(symbol).await;
        let _guard = operation_guard.lock().await;

        // A prior submission may have succeeded even if its response was
        // lost. If it is still ambiguous, retry its exact signed action
        // below instead of creating a second logical order.
        if self.has_ambiguous_submission(symbol).await {
            self.retry_ambiguous_submission(symbol).await?;
        } else if let Some(existing) = self.fetch_exchange_position(symbol).await? {
            if existing.direction != direction {
                return Err(ExecutionError(
                    "refusing to open: exchange already reports the opposite direction".to_string(),
                ));
            }
            self.clear_ambiguous_submission(symbol).await;
            self.write_virtual_position(session_id, symbol, existing)
                .await?;
            return Ok(existing);
        }

        self.ensure_pending_order_resolved(symbol).await?;

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

        // A transport failure can leave the signed action pending in
        // place_order. Re-read here; reconciliation remains the recovery
        // boundary if this confirmation is also ambiguous.
        let position = self.fetch_exchange_position(symbol).await?.ok_or_else(|| {
            ExecutionError(
                "order submitted but no position found after open; refusing virtual-state update"
                    .to_string(),
            )
        })?;
        self.clear_confirmed_pending_order(symbol).await?;
        if position.direction != direction {
            return Err(ExecutionError(
                "exchange position did not match submitted open direction".to_string(),
            ));
        }
        // A successful response can still be followed by a partial or
        // no fill. Retain the exchange observation here; the next
        // reconcile pass will expose any remaining size mismatch.

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
        let operation_guard = self.operation_guard(symbol).await;
        let _guard = operation_guard.lock().await;

        let Some(position) = self.read_virtual_position(session_id).await? else {
            return Ok(());
        };

        if self.has_ambiguous_submission(symbol).await {
            // A lost response does not prove the first close missed. Retry
            // the exact signed action and require fresh exchange truth.
            self.retry_ambiguous_submission(symbol).await?;
            if self.fetch_exchange_position(symbol).await?.is_some() {
                return Err(ExecutionError(
                    "ambiguous close retry did not produce a flat exchange position".to_string(),
                ));
            }
            self.clear_confirmed_pending_order(symbol).await?;
            self.delete_virtual_position(session_id).await?;
            return Ok(());
        }

        // If a prior close already filled, converge virtual state without
        // submitting another reduce-only order.
        match self.fetch_exchange_position(symbol).await? {
            None => {
                self.delete_virtual_position(session_id).await?;
                return Ok(());
            }
            Some(exchange) if exchange.direction != position.direction => {
                return Err(ExecutionError(
                    "refusing to close: exchange reports the opposite direction".to_string(),
                ));
            }
            Some(_) => {}
        }

        // Closing sells a long (is_buy = false) and buys back a short
        // (is_buy = true).
        let is_buy = matches!(position.direction, Direction::Short);
        let size = position.notional_usd / position.entry_price.max(f64::EPSILON);

        self.place_order(symbol, is_buy, size, mid_price, true)
            .await?;

        if let Some(remaining) = self.fetch_exchange_position(symbol).await? {
            return Err(ExecutionError(format!(
                "close submitted but exchange still reports {} notional_usd; retaining virtual position",
                remaining.notional_usd
            )));
        }
        self.clear_confirmed_pending_order(symbol).await?;
        self.delete_virtual_position(session_id).await?;

        tracing::info!(symbol, "confirmed live position close");

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

    /// Detects drift between this wallet's virtual state and its real
    /// Hyperliquid positions for each of `sessions`, plus any exchange
    /// position no session in `sessions` accounts for at all, and
    /// applies this adapter's configured `DriftPolicy` to each finding.
    async fn reconcile(
        &self,
        sessions: &[ReconcileTarget],
    ) -> Result<Vec<DriftOutcome>, ExecutionError> {
        let mut outcomes = Vec::new();
        let mut accounted_for = std::collections::HashSet::new();

        for target in sessions {
            accounted_for.insert(target.symbol.clone());

            let operation_guard = self.operation_guard(&target.symbol).await;
            let _guard = operation_guard.lock().await;
            let virtual_position = self.read_virtual_position(&target.session_id).await?;
            let exchange_position = self.fetch_exchange_position(&target.symbol).await?;
            // Reconciliation is the recovery boundary for an ambiguous
            // submission. Keep it until the exchange reports a terminal
            // order status; a position snapshot alone is not proof that a
            // delayed order will not appear later.
            self.ensure_pending_order_resolved(&target.symbol).await?;

            let event = match (virtual_position, exchange_position) {
                (Some(_), None) => Some(DriftEvent::MissingOnExchange {
                    session_id: target.session_id.clone(),
                    symbol: target.symbol.clone(),
                }),
                (None, Some(exchange)) => Some(DriftEvent::SizeMismatch {
                    session_id: target.session_id.clone(),
                    symbol: target.symbol.clone(),
                    virtual_notional_usd: 0.0,
                    exchange_notional_usd: exchange.notional_usd,
                }),
                (Some(virtual_position), Some(exchange_position)) => {
                    let direction_matches =
                        virtual_position.direction == exchange_position.direction;
                    let size_matches =
                        (virtual_position.notional_usd - exchange_position.notional_usd).abs()
                            < f64::EPSILON.max(virtual_position.notional_usd * 1e-6);
                    if direction_matches && size_matches {
                        None
                    } else {
                        Some(DriftEvent::SizeMismatch {
                            session_id: target.session_id.clone(),
                            symbol: target.symbol.clone(),
                            virtual_notional_usd: virtual_position.notional_usd,
                            exchange_notional_usd: exchange_position.notional_usd,
                        })
                    }
                }
                (None, None) => None,
            };

            let Some(event) = event else { continue };
            let action = self.drift_policy.action_for(&event);
            let result = self
                .apply_drift_action(&event, action, virtual_position, exchange_position)
                .await;
            outcomes.push(DriftOutcome {
                event,
                action,
                error: result.err().map(|e| e.to_string()),
            });
        }

        for (symbol, position) in self.fetch_all_exchange_positions().await? {
            if accounted_for.contains(&symbol) {
                continue;
            }
            let operation_guard = self.operation_guard(&symbol).await;
            let _guard = operation_guard.lock().await;
            // Unknown positions are discovered after the reconcile
            // snapshot, so they were not claimed by the wallet pass.
            // Claim them here before remediation to exclude a live
            // decision that started after the snapshot.
            let Some(_coordinator_guard) = execution_coordinator().try_lock(&symbol) else {
                continue;
            };
            let event = DriftEvent::UnknownOnExchange {
                symbol: symbol.clone(),
            };
            let action = self.drift_policy.action_for(&event);
            let result = self
                .apply_drift_action(&event, action, None, Some(position))
                .await;
            outcomes.push(DriftOutcome {
                event,
                action,
                error: result.err().map(|e| e.to_string()),
            });
        }

        Ok(outcomes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sqlx::postgres::PgPoolOptions;
    use wiremock::matchers::{method, path};
    use wiremock::Request;
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
        sqlx::query("DELETE FROM live_order_attempts WHERE wallet_id = $1::uuid")
            .bind(wallet_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM live_execution_holds WHERE wallet_id = $1::uuid")
            .bind(wallet_id)
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

    async fn adapter_against(
        server: &MockServer,
        pool: PgPool,
        wallet_id: &str,
    ) -> LiveExecutionAdapter {
        adapter_against_with_timeout(server, pool, wallet_id, Duration::from_secs(30)).await
    }

    async fn adapter_against_with_timeout(
        server: &MockServer,
        pool: PgPool,
        wallet_id: &str,
        timeout: Duration,
    ) -> LiveExecutionAdapter {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let mut adapter =
            LiveExecutionAdapter::new(server.uri(), key, true, pool, wallet_id.to_string());
        adapter.http = reqwest::Client::builder().timeout(timeout).build().unwrap();
        adapter
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
        // First /info call: pre-order exchange check.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "assetPositions": [],
                "order": { "status": "filled" }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        // Second /info call: balance read before the order.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "universe": [{ "name": "BTC" }],
                "assetPositions": [],
                "order": { "status": "filled" }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        // Third /info call: asset index lookup for the order.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }],
                "assetPositions": [],
                "order": { "status": "filled" }
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
                ],
                "order": { "status": "filled" }
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
        let restarted =
            LiveExecutionAdapter::new(server.uri(), key, true, pool, wallet_id.to_string());
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
        // The first call is the pre-close exchange check and must still
        // report the position; later calls can report flat.
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }],
                "assetPositions": [
                    { "position": { "coin": "BTC", "szi": "0.02", "entryPx": "50000" } }
                ],
                "order": { "status": "filled" }
            })))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }],
                "assetPositions": [],
                "order": { "status": "filled" }
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
    async fn close_retains_virtual_state_until_exchange_is_flat() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000112";
        let session_id = "00000000-0000-0000-0000-000000000113";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "universe": [{ "name": "BTC" }],
                "assetPositions": [
                    { "position": { "coin": "BTC", "szi": "0.01", "entryPx": "50000" } }
                ],
                "order": { "status": "filled" }
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

        let error = adapter.close(session_id, "BTC", 51000.0).await.unwrap_err();
        assert!(error.0.contains("still reports"));
        assert!(adapter
            .get_position(session_id, "BTC")
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn open_adopts_existing_exchange_position_without_resubmitting() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000110";
        let session_id = "00000000-0000-0000-0000-000000000111";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        mount_combined_info(
            &server,
            json!([{ "position": { "coin": "BTC", "szi": "0.02", "entryPx": "50000" } }]),
        )
        .await;
        let adapter = adapter_against(&server, pool, wallet_id).await;
        let position = adapter
            .open(session_id, "BTC", Direction::Long, 1000.0, 1.0, 50000.0)
            .await
            .unwrap();
        assert_eq!(position.notional_usd, 1000.0);
    }

    #[tokio::test]
    async fn ambiguous_submission_survives_adapter_refresh_and_reuses_the_signed_action() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000114";
        reset_wallet_and_position(&pool, wallet_id, "00000000-0000-0000-0000-000000000121").await;

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "universe": [{ "name": "BTC" }, { "name": "ETH" }],
                "assetPositions": [],
                "order": { "status": "filled" }
            })))
            .mount(&server)
            .await;
        let _exchange = Mock::given(method("POST"))
            .and(path("/exchange"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(150))
                    .set_body_json(json!({ "status": "ok", "response": {} })),
            )
            .mount(&server)
            .await;

        let adapter = adapter_against_with_timeout(
            &server,
            pool.clone(),
            wallet_id,
            Duration::from_millis(30),
        )
        .await;
        let error = adapter
            .place_order("BTC", true, 0.02, 50_000.0, false)
            .await
            .unwrap_err();
        assert!(error.0.contains("exchange request failed"));

        // WalletRegistry normally rebuilds this adapter every five seconds.
        let rebuilt = adapter_against_with_timeout(
            &server,
            pool.clone(),
            wallet_id,
            Duration::from_millis(500),
        )
        .await;
        rebuilt
            .place_order("BTC", true, 0.02, 50_000.0, false)
            .await
            .unwrap();

        let requests = server
            .received_requests()
            .await
            .expect("request history should be available");
        let exchange_requests: Vec<&Request> = requests
            .iter()
            .filter(|request| request.url.path() == "/exchange")
            .collect();
        assert_eq!(exchange_requests.len(), 2);
        let btc_cloid = serde_json::from_slice::<serde_json::Value>(&exchange_requests[0].body)
            .unwrap()["action"]["orders"][0]["c"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let retried_btc_cloid =
            serde_json::from_slice::<serde_json::Value>(&exchange_requests[1].body).unwrap()
                ["action"]["orders"][0]["c"]
                .as_str()
                .unwrap_or("")
                .to_string();
        assert_eq!(btc_cloid, retried_btc_cloid);
        assert!(
            btc_cloid.starts_with("0x"),
            "body was {:?}",
            String::from_utf8_lossy(&exchange_requests[0].body)
        );

        // The retry received an OK response, so this adapter can confirm
        // the position and release BTC's marker.
    }

    #[tokio::test]
    async fn unknown_position_reconciliation_yields_to_a_live_decision_claim() {
        let server = MockServer::start().await;
        mount_combined_info(
            &server,
            json!([{ "position": { "coin": "SOL", "szi": "1", "entryPx": "100" } }]),
        )
        .await;
        let adapter = adapter_against(
            &server,
            PgPoolOptions::new()
                .connect_lazy(&test_database_url())
                .unwrap(),
            "00000000-0000-0000-0000-000000000118",
        )
        .await;

        let decision_claim = execution_coordinator().try_lock("SOL").unwrap();
        assert!(adapter.reconcile(&[]).await.unwrap().is_empty());
        drop(decision_claim);
    }

    #[tokio::test]
    async fn two_symbols_retain_independent_ambiguity_markers() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000116";
        reset_wallet_and_position(&pool, wallet_id, "00000000-0000-0000-0000-000000000122").await;

        let adapter = adapter_against(&MockServer::start().await, pool.clone(), wallet_id).await;
        for (symbol, size) in [("BTC", 0.02), ("ETH", 1.0)] {
            let pending = PendingOrder {
                action: OrderAction::single(OrderRequest {
                    asset: 0,
                    is_buy: true,
                    price: "50000".to_string(),
                    size: "0.1".to_string(),
                    reduce_only: false,
                    order_type: OrderType::ioc(),
                    cloid: Some(format!("0x{:032x}", size as u64)),
                }),
                client_order_id: format!("0x{:032x}", size as u64),
                nonce_ms: 1,
                signature: Signature {
                    r: [0; 32],
                    s: [0; 32],
                    v: 27,
                },
                is_buy: true,
                size,
                mid_price: 100.0,
                reduce_only: false,
            };
            ambiguous_submissions()
                .lock()
                .await
                .insert((wallet_id.to_string(), symbol.to_string()), pending.clone());
            adapter
                .persist_pending_order(symbol, &pending)
                .await
                .unwrap();
        }

        assert!(adapter.clear_ambiguous_submission("BTC").await);
        assert!(
            !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM live_order_attempts WHERE wallet_id = $1::uuid AND symbol = 'BTC')",
            )
            .bind(wallet_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "clearing BTC must not touch another PERP's durable marker",
        );
        assert!(
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM live_order_attempts WHERE wallet_id = $1::uuid AND symbol = 'ETH')",
            )
            .bind(wallet_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
            "ETH's durable marker survives independently",
        );
    }

    #[tokio::test]
    async fn decision_freshness_rejects_old_and_moved_signals() {
        let server = MockServer::start().await;
        let adapter = adapter_against(
            &server,
            PgPoolOptions::new()
                .connect_lazy(&test_database_url())
                .unwrap(),
            "00000000-0000-0000-0000-0000000000ff",
        )
        .await;
        assert!(!ExecutionAdapter::decision_is_fresh(
            &adapter,
            "BTC",
            100.0,
            100.0,
            Duration::ZERO,
        )
        .await
        .unwrap());
        adapter.mark_decision_started("BTC").await;
        assert!(ExecutionAdapter::decision_is_fresh(
            &adapter,
            "BTC",
            104.0,
            100.0,
            Duration::from_secs(30),
        )
        .await
        .unwrap());
        assert!(!ExecutionAdapter::decision_is_fresh(
            &adapter,
            "BTC",
            106.0,
            100.0,
            Duration::from_secs(30),
        )
        .await
        .unwrap());
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

    /// A single `/info` mock whose body carries every field any
    /// `/info` call type reads (`clearinghouseState`'s
    /// `assetPositions`/`withdrawable`, `meta`'s `universe`) — each
    /// endpoint ignores the fields it doesn't recognize, so one mock can
    /// stand in for every `/info` call a test makes, however many times.
    async fn mount_combined_info(server: &MockServer, asset_positions: serde_json::Value) {
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "withdrawable": "1000.0",
                "universe": [{ "name": "BTC" }],
                "assetPositions": asset_positions,
            "order": { "status": "filled" },
            })))
            .mount(server)
            .await;
    }

    async fn mount_ok_exchange(server: &MockServer) {
        Mock::given(method("POST"))
            .and(path("/exchange"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(json!({ "status": "ok", "response": {} })),
            )
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn reconcile_adopts_virtual_state_when_the_exchange_is_actually_flat() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000101";
        let session_id = "00000000-0000-0000-0000-000000000102";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        mount_combined_info(&server, json!([])).await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id).await;
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

        let outcomes = adapter
            .reconcile(&[ReconcileTarget {
                session_id: session_id.to_string(),
                symbol: "BTC".to_string(),
                status: crate::session::TradingSessionStatus::Active,
            }])
            .await
            .unwrap();

        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            outcomes[0].event,
            DriftEvent::MissingOnExchange {
                session_id: session_id.to_string(),
                symbol: "BTC".to_string(),
            }
        );
        assert_eq!(outcomes[0].action, DriftAction::AdoptAndLog);
        assert_eq!(outcomes[0].error, None);

        // Virtual state now agrees with the exchange: flat.
        assert_eq!(adapter.get_position(session_id, "BTC").await.unwrap(), None);
    }

    #[tokio::test]
    async fn reconcile_flattens_an_unknown_exchange_position_by_default() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000103";
        let session_id = "00000000-0000-0000-0000-000000000104";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        mount_combined_info(
            &server,
            json!([{ "position": { "coin": "BTC", "szi": "0.02", "entryPx": "50000" } }]),
        )
        .await;
        mount_ok_exchange(&server).await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id).await;

        // No sessions at all track BTC — the exchange position is
        // entirely unaccounted for.
        let outcomes = adapter.reconcile(&[]).await.unwrap();

        assert_eq!(outcomes.len(), 1);
        assert_eq!(
            outcomes[0].event,
            DriftEvent::UnknownOnExchange {
                symbol: "BTC".to_string(),
            }
        );
        assert_eq!(outcomes[0].action, DriftAction::Flatten);
        // The static mock keeps reporting the position after submission,
        // so the unverified remediation must be reported as failed.
        assert!(outcomes[0]
            .error
            .as_deref()
            .unwrap()
            .contains("still reports"));
    }

    #[tokio::test]
    async fn reconcile_resubmits_to_top_up_a_partially_filled_position() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000105";
        let session_id = "00000000-0000-0000-0000-000000000106";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        // Exchange only has half of what virtual state believes is open
        // (e.g. a partial fill never topped up).
        mount_combined_info(
            &server,
            json!([{ "position": { "coin": "BTC", "szi": "0.01", "entryPx": "50000" } }]),
        )
        .await;
        mount_ok_exchange(&server).await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id)
            .await
            .with_drift_policy(DriftPolicy {
                size_mismatch: DriftAction::ReSubmit,
                ..DriftPolicy::default()
            });
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

        let outcomes = adapter
            .reconcile(&[ReconcileTarget {
                session_id: session_id.to_string(),
                symbol: "BTC".to_string(),
                status: crate::session::TradingSessionStatus::Active,
            }])
            .await
            .unwrap();

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].action, DriftAction::ReSubmit);
        // The static mock still reports only the half-size position, so
        // reconciliation must not claim the remediation succeeded.
        assert!(outcomes[0]
            .error
            .as_deref()
            .unwrap()
            .contains("did not converge"));
        assert!(matches!(outcomes[0].event, DriftEvent::SizeMismatch { .. }));
    }

    #[tokio::test]
    async fn reconcile_takes_no_action_when_the_policy_is_halt() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000107";
        let session_id = "00000000-0000-0000-0000-000000000108";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let server = MockServer::start().await;
        // No /exchange mock at all: if Halt somehow placed an order,
        // this test would fail on the unmatched request instead of
        // silently passing.
        mount_combined_info(
            &server,
            json!([{ "position": { "coin": "BTC", "szi": "0.01", "entryPx": "50000" } }]),
        )
        .await;

        let adapter = adapter_against(&server, pool.clone(), wallet_id)
            .await
            .with_drift_policy(DriftPolicy {
                size_mismatch: DriftAction::Halt,
                ..DriftPolicy::default()
            });
        let seeded = OpenPosition {
            direction: Direction::Long,
            entry_price: 50000.0,
            notional_usd: 1000.0,
            opened_at: Utc::now(),
        };
        adapter
            .write_virtual_position(session_id, "BTC", seeded)
            .await
            .unwrap();

        let outcomes = adapter
            .reconcile(&[ReconcileTarget {
                session_id: session_id.to_string(),
                symbol: "BTC".to_string(),
                status: crate::session::TradingSessionStatus::Active,
            }])
            .await
            .unwrap();

        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].action, DriftAction::Halt);
        assert_eq!(outcomes[0].error, None);
        assert!(ExecutionAdapter::is_halted(&adapter, "BTC").await.unwrap());

        // Virtual state is untouched — Halt takes no corrective action.
        let unchanged = adapter
            .get_position(session_id, "BTC")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.notional_usd, seeded.notional_usd);

        ExecutionAdapter::clear_halt(&adapter, "BTC").await.unwrap();
        assert!(!ExecutionAdapter::is_halted(&adapter, "BTC").await.unwrap());
    }

    #[tokio::test]
    async fn pending_order_survives_process_restart_until_terminal_status() {
        let pool = pool().await;
        let wallet_id = "00000000-0000-0000-0000-000000000119";
        let session_id = "00000000-0000-0000-0000-000000000120";
        reset_wallet_and_position(&pool, wallet_id, session_id).await;

        let pending = PendingOrder {
            action: OrderAction::single(OrderRequest {
                asset: 0,
                is_buy: true,
                price: "50000".to_string(),
                size: "0.02".to_string(),
                reduce_only: false,
                order_type: OrderType::ioc(),
                cloid: Some("0x00000000000000000000000000000123".to_string()),
            }),
            client_order_id: "0x00000000000000000000000000000123".to_string(),
            nonce_ms: 1,
            signature: Signature {
                r: [1; 32],
                s: [2; 32],
                v: 27,
            },
            is_buy: true,
            size: 0.02,
            mid_price: 50_000.0,
            reduce_only: false,
        };

        let server = MockServer::start().await;
        let first = adapter_against(&server, pool.clone(), wallet_id).await;
        first.persist_pending_order("BTC", &pending).await.unwrap();
        ambiguous_submissions()
            .lock()
            .await
            .insert((wallet_id.to_string(), "BTC".to_string()), pending.clone());

        // Simulate a process restart by rebuilding the adapter and dropping
        // the in-process marker. The durable row remains the source of truth.
        ambiguous_submissions()
            .lock()
            .await
            .remove(&(wallet_id.to_string(), "BTC".to_string()));
        let restarted = adapter_against(&server, pool.clone(), wallet_id).await;
        assert_eq!(
            restarted.load_pending_order("BTC").await.unwrap(),
            Some(pending)
        );

        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "order": { "status": "open" }
            })))
            .mount(&server)
            .await;
        let error = restarted
            .ensure_pending_order_resolved("BTC")
            .await
            .unwrap_err();
        assert!(error.0.contains("unresolved"));

        server.reset().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "order": { "status": "filled" }
            })))
            .mount(&server)
            .await;
        restarted
            .ensure_pending_order_resolved("BTC")
            .await
            .unwrap();
        assert!(restarted.load_pending_order("BTC").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn an_unrecorded_pending_order_is_released_but_a_live_one_is_not() {
        assert!(LiveExecutionAdapter::is_terminal_order_status("filled"));
        assert!(LiveExecutionAdapter::is_terminal_order_status(
            "iocCancelRejected"
        ));
        assert!(!LiveExecutionAdapter::is_terminal_order_status("open"));
        assert!(!LiveExecutionAdapter::is_terminal_order_status("triggered"));
    }
}
