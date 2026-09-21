use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use sqlx::PgPool;

use crate::decision::{ExecutionAdapter, LiveExecutionAdapter, MockExecutionAdapter, PrivateKey};
use crate::mode::EngineMode;

const DEFAULT_MOCK_SLIPPAGE_BPS: f64 = 5.0;

/// Decrypts a private key encrypted by the Express API's
/// `encryptPrivateKey` (see `api/src/wallets/crypto.ts`): AES-256-GCM
/// with a 32-byte key from `WALLET_ENCRYPTION_KEY` (base64), the
/// ciphertext string formatted as `iv:authTag:ciphertext`, each part
/// base64-encoded. Must stay byte-for-byte compatible with that module.
pub fn decrypt_private_key(encrypted: &str) -> Result<String, String> {
    let mut parts = encrypted.split(':');
    let (Some(iv_b64), Some(tag_b64), Some(ciphertext_b64), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed encrypted private key".to_string());
    };

    let key_b64 = std::env::var("WALLET_ENCRYPTION_KEY")
        .map_err(|_| "Missing required environment variable: WALLET_ENCRYPTION_KEY".to_string())?;
    let key_bytes = STANDARD
        .decode(key_b64)
        .map_err(|e| format!("invalid WALLET_ENCRYPTION_KEY: {e}"))?;
    if key_bytes.len() != 32 {
        return Err("WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes".to_string());
    }

    let iv = STANDARD
        .decode(iv_b64)
        .map_err(|e| format!("invalid iv: {e}"))?;
    let tag = STANDARD
        .decode(tag_b64)
        .map_err(|e| format!("invalid auth tag: {e}"))?;
    let mut ciphertext = STANDARD
        .decode(ciphertext_b64)
        .map_err(|e| format!("invalid ciphertext: {e}"))?;
    // The `aes-gcm` crate expects the auth tag appended to the
    // ciphertext, matching Node's `cipher.update()` + `getAuthTag()`
    // split back into one buffer.
    ciphertext.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new_from_slice(&key_bytes)
        .map_err(|e| format!("failed to initialize cipher: {e}"))?;
    let nonce = Nonce::from_slice(&iv);

    let plaintext = cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|e| format!("failed to decrypt private key: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("decrypted key is not valid utf-8: {e}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WalletKind {
    Mock,
    Live,
}

impl WalletKind {
    fn from_db(kind: &str) -> Option<Self> {
        match kind {
            "mock" => Some(WalletKind::Mock),
            "live" => Some(WalletKind::Live),
            _ => None,
        }
    }

    /// Whether this wallet may be traded while the engine's global mode
    /// is `mode` — the safety net required so a market can never execute
    /// against a real wallet while live trading is globally disabled
    /// (and vice versa).
    pub fn matches_mode(&self, mode: EngineMode) -> bool {
        matches!(
            (self, mode),
            (WalletKind::Mock, EngineMode::Mock) | (WalletKind::Live, EngineMode::Live)
        )
    }
}

struct WalletEntry {
    kind: WalletKind,
    adapter: Arc<dyn ExecutionAdapter>,
}

/// Holds one `ExecutionAdapter` per wallet row in Postgres, rebuilt from
/// the `wallets` table on a fixed poll interval so a wallet created from
/// the dashboard becomes tradeable without an engine restart — the same
/// no-restart guarantee the PERP config store and decision-maker
/// registry already provide. Mock wallets get a `MockExecutionAdapter`
/// scoped to that wallet's row; live wallets get a `LiveExecutionAdapter`
/// built from the wallet's decrypted private key.
pub struct WalletRegistry {
    entries: RwLock<HashMap<String, WalletEntry>>,
    pool: PgPool,
    slippage_bps: f64,
}

impl WalletRegistry {
    pub fn new(pool: PgPool) -> Arc<Self> {
        Arc::new(Self {
            entries: RwLock::new(HashMap::new()),
            pool,
            slippage_bps: std::env::var("MOCK_SLIPPAGE_BPS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(DEFAULT_MOCK_SLIPPAGE_BPS),
        })
    }

    /// Looks up the wallet's kind and its `ExecutionAdapter`, resolved
    /// fresh from the registry's last refresh — not cached at PERP
    /// decision-loop startup — so a wallet's availability (and the
    /// mode-match safety check callers perform against `WalletKind`)
    /// always reflects the current `wallets` table.
    pub fn resolve(&self, wallet_id: &str) -> Option<(WalletKind, Arc<dyn ExecutionAdapter>)> {
        self.entries
            .read()
            .unwrap()
            .get(wallet_id)
            .map(|entry| (entry.kind, entry.adapter.clone()))
    }

    /// Every currently known wallet, for the funding sweep (which must
    /// apply to open positions across every mock/live wallet, not just
    /// one).
    pub fn snapshot(&self) -> Vec<(String, WalletKind, Arc<dyn ExecutionAdapter>)> {
        self.entries
            .read()
            .unwrap()
            .iter()
            .map(|(id, entry)| (id.clone(), entry.kind, entry.adapter.clone()))
            .collect()
    }

    async fn refresh(&self) {
        let rows = match sqlx::query_as::<_, (String, String, Option<String>)>(
            "SELECT id::text AS id, kind, encrypted_private_key FROM wallets",
        )
        .fetch_all(&self.pool)
        .await
        {
            Ok(rows) => rows,
            Err(error) => {
                tracing::error!(%error, "failed to load wallets from Postgres");
                return;
            }
        };

        let is_mainnet = std::env::var("HYPERLIQUID_TESTNET").as_deref() != Ok("true");
        let base_url = if is_mainnet {
            "https://api.hyperliquid.xyz".to_string()
        } else {
            "https://api.hyperliquid-testnet.xyz".to_string()
        };

        let mut next = HashMap::new();
        for (id, kind_str, encrypted_private_key) in rows {
            let Some(kind) = WalletKind::from_db(&kind_str) else {
                tracing::error!(wallet_id = %id, kind = %kind_str, "unknown wallet kind; skipping");
                continue;
            };

            let adapter: Arc<dyn ExecutionAdapter> = match kind {
                WalletKind::Mock => Arc::new(MockExecutionAdapter::new(
                    self.pool.clone(),
                    self.slippage_bps,
                    id.clone(),
                )),
                WalletKind::Live => {
                    let Some(encrypted) = &encrypted_private_key else {
                        tracing::error!(wallet_id = %id, "live wallet is missing its encrypted credential; skipping");
                        continue;
                    };
                    let key_hex = match decrypt_private_key(encrypted) {
                        Ok(key) => key,
                        Err(error) => {
                            tracing::error!(wallet_id = %id, %error, "failed to decrypt live wallet credential; skipping");
                            continue;
                        }
                    };
                    let key = match PrivateKey::from_hex(&key_hex) {
                        Ok(key) => key,
                        Err(error) => {
                            tracing::error!(wallet_id = %id, %error, "decrypted live wallet credential is invalid; skipping");
                            continue;
                        }
                    };
                    Arc::new(LiveExecutionAdapter::new(
                        base_url.clone(),
                        key,
                        is_mainnet,
                        self.pool.clone(),
                        id.clone(),
                    ))
                }
            };

            next.insert(id, WalletEntry { kind, adapter });
        }

        let count = next.len();
        *self.entries.write().unwrap() = next;
        tracing::debug!(count, "refreshed wallet registry");
    }

    /// Runs forever, refreshing the registry from Postgres on
    /// `poll_interval`. Applies immediately on startup so wallets are
    /// available before the first decision cycle runs.
    pub async fn run(self: Arc<Self>, poll_interval: Duration) -> ! {
        loop {
            self.refresh().await;
            tokio::time::sleep(poll_interval).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Mirrors `api/src/wallets/crypto.ts`'s `encryptPrivateKey`, so this
    // test can assert on a fixture only this crate encrypts — it is not
    // a substitute for a cross-language interop test.
    fn encrypt_for_test(plaintext: &str, key: &[u8; 32]) -> String {
        use aes_gcm::aead::rand_core::RngCore;

        let cipher = Aes256Gcm::new_from_slice(key).unwrap();
        let mut iv = [0u8; 12];
        aes_gcm::aead::OsRng.fill_bytes(&mut iv);
        let nonce = Nonce::from_slice(&iv);
        let mut ciphertext = cipher.encrypt(nonce, plaintext.as_bytes()).unwrap();
        // `encrypt` returns ciphertext||tag; split it back apart the way
        // Node's `cipher.update()`/`getAuthTag()` naturally do, to mirror
        // the real wire format exactly.
        let tag = ciphertext.split_off(ciphertext.len() - 16);
        format!(
            "{}:{}:{}",
            STANDARD.encode(iv),
            STANDARD.encode(tag),
            STANDARD.encode(ciphertext)
        )
    }

    #[test]
    fn decrypts_a_value_encrypted_with_the_same_key() {
        let key = [7u8; 32];
        std::env::set_var("WALLET_ENCRYPTION_KEY", STANDARD.encode(key));

        let encrypted = encrypt_for_test("0xabc123", &key);
        let decrypted = decrypt_private_key(&encrypted).unwrap();

        assert_eq!(decrypted, "0xabc123");
    }

    #[test]
    fn rejects_malformed_input() {
        std::env::set_var("WALLET_ENCRYPTION_KEY", STANDARD.encode([1u8; 32]));
        assert!(decrypt_private_key("not-the-right-shape").is_err());
    }

    #[test]
    fn wallet_kind_matches_mode_correctly() {
        assert!(WalletKind::Mock.matches_mode(EngineMode::Mock));
        assert!(!WalletKind::Mock.matches_mode(EngineMode::Live));
        assert!(WalletKind::Live.matches_mode(EngineMode::Live));
        assert!(!WalletKind::Live.matches_mode(EngineMode::Mock));
    }
}
