use std::fmt;

use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, SigningKey};
use serde::Serialize;
use tiny_keccak::{Hasher, Keccak};

/// A Hyperliquid account private key, held only in memory for the
/// lifetime of the engine process. Deliberately does not derive
/// `Debug`/`Display` (a hand-rolled `Debug` below redacts the bytes) so
/// the key can never be accidentally formatted into a log line, an
/// error message, or a struct that gets serialized elsewhere.
pub struct PrivateKey(SigningKey);

impl fmt::Debug for PrivateKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PrivateKey(<redacted>)")
    }
}

#[derive(Debug)]
pub struct KeyError(pub String);

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for KeyError {}

fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Keccak::v256();
    hasher.update(data);
    let mut out = [0u8; 32];
    hasher.finalize(&mut out);
    out
}

impl PrivateKey {
    /// Parses a 32-byte secp256k1 private key from hex, with or without
    /// a `0x` prefix.
    pub fn from_hex(hex_str: &str) -> Result<Self, KeyError> {
        let trimmed = hex_str.trim().trim_start_matches("0x");
        let bytes = hex::decode(trimmed)
            .map_err(|e| KeyError(format!("private key is not valid hex: {e}")))?;
        let signing_key = SigningKey::from_slice(&bytes)
            .map_err(|e| KeyError(format!("private key is not a valid secp256k1 key: {e}")))?;
        Ok(Self(signing_key))
    }

    /// The wallet's derived Ethereum-style public address (checksum-free
    /// lowercase hex, `0x`-prefixed) — safe to expose read-only, unlike
    /// the key itself.
    pub fn public_address(&self) -> String {
        let verifying_key = self.0.verifying_key();
        let encoded = verifying_key.to_encoded_point(false);
        // Uncompressed point is 0x04 || X (32 bytes) || Y (32 bytes);
        // the address is the last 20 bytes of keccak256(X || Y).
        let uncompressed = encoded.as_bytes();
        let hash = keccak256(&uncompressed[1..]);
        format!("0x{}", hex::encode(&hash[12..]))
    }

    fn sign_prehash(&self, prehash: &[u8; 32]) -> Result<(EcdsaSignature, RecoveryId), KeyError> {
        self.0
            .sign_prehash_recoverable(prehash)
            .map_err(|e| KeyError(format!("failed to sign: {e}")))
    }
}

/// A 20-byte Hyperliquid account address. Used for a sub-account the
/// signing key trades on behalf of: Hyperliquid sub-accounts have no key
/// of their own, so their orders are signed by the master account (or an
/// API wallet the master approved) and name the sub-account as the
/// `vaultAddress`, which is also folded into the signed action hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountAddress([u8; 20]);

impl AccountAddress {
    /// Parses a `0x`-prefixed (or bare) 40-character hex address.
    pub fn from_hex(hex_str: &str) -> Result<Self, KeyError> {
        let trimmed = hex_str.trim();
        let trimmed = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .unwrap_or(trimmed);
        let bytes = hex::decode(trimmed)
            .map_err(|e| KeyError(format!("account address is not valid hex: {e}")))?;
        let bytes: [u8; 20] = bytes
            .try_into()
            .map_err(|_| KeyError("account address must be exactly 20 bytes".to_string()))?;
        Ok(Self(bytes))
    }

    /// Lowercase, `0x`-prefixed hex, the form Hyperliquid's `/info` and
    /// `/exchange` endpoints accept.
    pub fn to_hex(&self) -> String {
        format!("0x{}", hex::encode(self.0))
    }
}

/// A single order within a Hyperliquid `order` action. Field names
/// match Hyperliquid's wire format exactly (see docs.hyperliquid.xyz),
/// so this struct is msgpack-encoded as-is for hashing and JSON-encoded
/// as-is for the HTTP request body.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct OrderRequest {
    /// Asset index into Hyperliquid's `universe` array.
    #[serde(rename = "a")]
    pub asset: u32,
    /// True for buy/long, false for sell/short.
    #[serde(rename = "b")]
    pub is_buy: bool,
    /// Limit price, as a string (Hyperliquid requires string-encoded
    /// decimals, never floats, to avoid precision loss).
    #[serde(rename = "p")]
    pub price: String,
    /// Order size, as a string.
    #[serde(rename = "s")]
    pub size: String,
    #[serde(rename = "r")]
    pub reduce_only: bool,
    #[serde(rename = "t")]
    pub order_type: OrderType,
    /// Optional client order id. Its position is part of the signed
    /// MessagePack wire layout: Hyperliquid's canonical order map is
    /// `a, b, p, s, r, t, c?`, so this must remain the final field.
    #[serde(rename = "c", skip_serializing_if = "Option::is_none")]
    pub cloid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct OrderType {
    pub limit: LimitOrderType,
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
pub struct LimitOrderType {
    pub tif: String,
}

impl OrderType {
    /// Immediate-or-cancel, used to approximate a market order by
    /// pairing it with an aggressively-priced limit (see
    /// `market_order_price`).
    pub fn ioc() -> Self {
        Self {
            limit: LimitOrderType {
                tif: "Ioc".to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OrderAction {
    Order {
        orders: Vec<OrderRequest>,
        grouping: String,
    },
}

impl OrderAction {
    pub fn single(order: OrderRequest) -> Self {
        OrderAction::Order {
            orders: vec![order],
            grouping: "na".to_string(),
        }
    }
}

/// Hyperliquid does not accept true market orders; the convention (used
/// by their own SDKs) is an IOC limit order priced aggressively through
/// the book so it fills immediately at whatever the market will bear,
/// capped by `slippage`. Buying is priced above mid, selling below.
pub fn market_order_price(mid_price: f64, is_buy: bool, slippage: f64) -> f64 {
    if is_buy {
        mid_price * (1.0 + slippage)
    } else {
        mid_price * (1.0 - slippage)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Signature {
    pub r: [u8; 32],
    pub s: [u8; 32],
    pub v: u8,
}

impl Signature {
    /// Lowercase, `0x`-prefixed hex, as Hyperliquid's `/exchange`
    /// endpoint expects each component.
    pub fn r_hex(&self) -> String {
        format!("0x{}", hex::encode(self.r))
    }
    pub fn s_hex(&self) -> String {
        format!("0x{}", hex::encode(self.s))
    }
}

const HYPERLIQUID_EXCHANGE_DOMAIN_CHAIN_ID: u64 = 1337;

fn eip712_domain_separator() -> [u8; 32] {
    let type_hash = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let name_hash = keccak256(b"Exchange");
    let version_hash = keccak256(b"1");

    let mut chain_id_bytes = [0u8; 32];
    chain_id_bytes[24..].copy_from_slice(&HYPERLIQUID_EXCHANGE_DOMAIN_CHAIN_ID.to_be_bytes());

    // verifyingContract is the zero address for Hyperliquid's agent
    // signing scheme.
    let verifying_contract = [0u8; 32];

    let mut encoded = Vec::with_capacity(32 * 5);
    encoded.extend_from_slice(&type_hash);
    encoded.extend_from_slice(&name_hash);
    encoded.extend_from_slice(&version_hash);
    encoded.extend_from_slice(&chain_id_bytes);
    encoded.extend_from_slice(&verifying_contract);

    keccak256(&encoded)
}

fn agent_struct_hash(source: &str, connection_id: &[u8; 32]) -> [u8; 32] {
    let type_hash = keccak256(b"Agent(string source,bytes32 connectionId)");
    let source_hash = keccak256(source.as_bytes());

    let mut encoded = Vec::with_capacity(32 * 3);
    encoded.extend_from_slice(&type_hash);
    encoded.extend_from_slice(&source_hash);
    encoded.extend_from_slice(connection_id);

    keccak256(&encoded)
}

/// Hashes the action for signing per Hyperliquid's L1-action scheme:
/// msgpack-encode the action, append the 8-byte big-endian nonce, then
/// either `0x00` (trading the signer's own account) or `0x01` followed by
/// the 20-byte vault/sub-account address, and keccak256 the result to get
/// the "connection id" wrapped in an EIP-712 `Agent` struct.
fn connection_id(
    action: &OrderAction,
    nonce_ms: u64,
    vault_address: Option<&AccountAddress>,
) -> Result<[u8; 32], KeyError> {
    let mut buf = Vec::new();
    let mut serializer = rmp_serde::Serializer::new(&mut buf).with_struct_map();
    action
        .serialize(&mut serializer)
        .map_err(|e| KeyError(format!("failed to msgpack-encode order action: {e}")))?;

    buf.extend_from_slice(&nonce_ms.to_be_bytes());
    match vault_address {
        None => buf.push(0x00),
        Some(address) => {
            buf.push(0x01);
            buf.extend_from_slice(&address.0);
        }
    }

    Ok(keccak256(&buf))
}

fn eip712_hash(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    let mut encoded = Vec::with_capacity(2 + 32 + 32);
    encoded.extend_from_slice(&[0x19, 0x01]);
    encoded.extend_from_slice(domain_separator);
    encoded.extend_from_slice(struct_hash);
    keccak256(&encoded)
}

/// Signs a Hyperliquid order action, returning both the signature and
/// the nonce used (the exchange request must echo the same nonce).
/// `is_mainnet` selects the EIP-712 `Agent.source` value Hyperliquid's
/// scheme requires ("a" for mainnet, "b" for testnet). `vault_address`
/// is the sub-account being traded, if any; the `/exchange` request must
/// then send the same address as `vaultAddress`.
pub fn sign_order_action(
    key: &PrivateKey,
    action: &OrderAction,
    nonce_ms: u64,
    is_mainnet: bool,
    vault_address: Option<&AccountAddress>,
) -> Result<Signature, KeyError> {
    let connection_id = connection_id(action, nonce_ms, vault_address)?;
    let source = if is_mainnet { "a" } else { "b" };
    let struct_hash = agent_struct_hash(source, &connection_id);
    let domain_separator = eip712_domain_separator();
    let digest = eip712_hash(&domain_separator, &struct_hash);

    let (signature, recovery_id) = key.sign_prehash(&digest)?;
    let bytes = signature.to_bytes();

    let mut r = [0u8; 32];
    let mut s = [0u8; 32];
    r.copy_from_slice(&bytes[..32]);
    s.copy_from_slice(&bytes[32..]);

    Ok(Signature {
        r,
        s,
        v: 27 + recovery_id.to_byte(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY_HEX: &str = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    #[test]
    fn rejects_a_non_hex_key() {
        let error = PrivateKey::from_hex("not-hex").unwrap_err();
        assert!(error.0.contains("hex"));
    }

    #[test]
    fn rejects_a_key_of_the_wrong_length() {
        let error = PrivateKey::from_hex("0xabcd").unwrap_err();
        assert!(error.0.contains("secp256k1"));
    }

    #[test]
    fn derives_a_stable_public_address_from_a_known_key() {
        // Well-known secp256k1 private key 0x1 -> the well-known
        // address 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf.
        let key = PrivateKey::from_hex(
            "0x0000000000000000000000000000000000000000000000000000000000000001",
        )
        .unwrap();
        assert_eq!(
            key.public_address().to_lowercase(),
            "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"
        );
    }

    #[test]
    fn public_address_is_deterministic_for_the_same_key() {
        let key1 = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let key2 = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        assert_eq!(key1.public_address(), key2.public_address());
    }

    #[test]
    fn different_keys_derive_different_addresses() {
        let key1 = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let key2 = PrivateKey::from_hex(
            "0x0000000000000000000000000000000000000000000000000000000000000002",
        )
        .unwrap();
        assert_ne!(key1.public_address(), key2.public_address());
    }

    #[test]
    fn debug_format_never_reveals_key_material() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let formatted = format!("{key:?}");
        assert_eq!(formatted, "PrivateKey(<redacted>)");
        assert!(!formatted.contains(TEST_KEY_HEX.trim_start_matches("0x")));
    }

    fn sample_order() -> OrderAction {
        OrderAction::single(OrderRequest {
            asset: 0,
            is_buy: true,
            price: "50000".to_string(),
            size: "0.1".to_string(),
            reduce_only: false,
            order_type: OrderType::ioc(),
            cloid: None,
        })
    }

    #[test]
    fn signing_is_deterministic_for_the_same_action_and_nonce() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let action = sample_order();
        let sig1 = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        let sig2 = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        assert_eq!(sig1, sig2);
    }

    #[test]
    fn signature_changes_when_the_nonce_changes() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let action = sample_order();
        let sig1 = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        let sig2 = sign_order_action(&key, &action, 2_000, true, None).unwrap();
        assert_ne!(sig1, sig2);
    }

    #[test]
    fn client_order_id_changes_the_signed_order() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let mut action = sample_order();
        let first_signature = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        let OrderAction::Order { orders, .. } = &mut action;
        orders[0].cloid = Some("0x0123456789abcdef0123456789abcdef".to_string());
        let second_signature = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        assert_ne!(first_signature, second_signature);
    }

    #[test]
    fn client_order_id_matches_the_canonical_messagepack_layout() {
        let action = OrderAction::single(OrderRequest {
            asset: 0,
            is_buy: true,
            price: "50000".to_string(),
            size: "0.1".to_string(),
            reduce_only: false,
            order_type: OrderType::ioc(),
            cloid: Some("0x0123456789abcdef0123456789abcdef".to_string()),
        });

        // Hyperliquid signs an ordered map, so field placement is part of
        // the protocol. The official L2Order layout is
        // {a, b, p, s, r, t, c}. Verify that the serialized field names
        // occur in that order, independently of MessagePack's string
        // length encoding.
        let mut encoded = Vec::new();
        let mut serializer = rmp_serde::Serializer::new(&mut encoded).with_struct_map();
        action.serialize(&mut serializer).unwrap();
        let mut previous = 0;
        for field in [b"a", b"b", b"p", b"s", b"r", b"t", b"c"] {
            let key = [0xa1, field[0]];
            let position = encoded
                .windows(key.len())
                .skip(previous)
                .position(|window| window == key)
                .map(|offset| previous + offset)
                .expect("canonical order key must be present");
            previous = position + key.len();
        }
    }

    #[test]
    fn signature_changes_when_the_order_changes() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let mut action = sample_order();
        let sig1 = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        let OrderAction::Order { orders, .. } = &mut action;
        orders[0].size = "0.2".to_string();
        let sig2 = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        assert_ne!(sig1, sig2);
    }

    #[test]
    fn signature_changes_between_mainnet_and_testnet_source() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let action = sample_order();
        let mainnet_sig = sign_order_action(&key, &action, 1_000, true, None).unwrap();
        let testnet_sig = sign_order_action(&key, &action, 1_000, false, None).unwrap();
        assert_ne!(mainnet_sig, testnet_sig);
    }

    #[test]
    fn signature_recovers_to_the_signing_keys_own_address() {
        use k256::ecdsa::{RecoveryId, Signature as EcdsaSignature, VerifyingKey};

        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let action = sample_order();
        let nonce_ms = 42_000;
        let sig = sign_order_action(&key, &action, nonce_ms, true, None).unwrap();

        let connection_id = connection_id(&action, nonce_ms, None).unwrap();
        let struct_hash = agent_struct_hash("a", &connection_id);
        let domain_separator = eip712_domain_separator();
        let digest = eip712_hash(&domain_separator, &struct_hash);

        let mut sig_bytes = [0u8; 64];
        sig_bytes[..32].copy_from_slice(&sig.r);
        sig_bytes[32..].copy_from_slice(&sig.s);
        let ecdsa_sig = EcdsaSignature::from_bytes((&sig_bytes).into()).unwrap();
        let recovery_id = RecoveryId::from_byte(sig.v - 27).unwrap();

        let recovered =
            VerifyingKey::recover_from_prehash(&digest, &ecdsa_sig, recovery_id).unwrap();
        let expected = VerifyingKey::from(key.0.clone());
        assert_eq!(recovered, expected);
    }

    /// Left-pads a hex signature component to 32 bytes: the Python SDK
    /// formats r/s as integers, dropping leading zero nibbles.
    fn component(hex_str: &str) -> [u8; 32] {
        let padded = format!("{:0>64}", hex_str.trim_start_matches("0x"));
        hex::decode(padded).unwrap().try_into().unwrap()
    }

    /// Reference signatures produced by Hyperliquid's official Python SDK
    /// (`hyperliquid.utils.signing.sign_l1_action`) for `sample_order()`,
    /// `TEST_KEY_HEX`, nonce 42000 and no expiry. Pinning to the SDK's
    /// output is what proves the vault-address encoding matches the
    /// exchange's, not just that it differs from the direct-account one.
    #[test]
    fn signatures_match_the_official_sdk_with_and_without_a_vault() {
        let key = PrivateKey::from_hex(TEST_KEY_HEX).unwrap();
        let action = sample_order();
        let vault = AccountAddress::from_hex("0x1111111111111111111111111111111111111111").unwrap();
        let cases: [(Option<&AccountAddress>, bool, &str, &str, u8); 4] = [
            (
                None,
                true,
                "0x9e732307667ddccad7794f1299d69ce130cf92b373af07bf8204f226edb8dd8f",
                "0x34cd86926deb45e95b188b1358ca774e179e30d143f28fbc078abcac47f1d1a7",
                28,
            ),
            (
                None,
                false,
                "0x392294cda98db3a747154012fda2dcbe2e0a2baba7d0d721fa2ee2ac54c59c5f",
                "0x772a392ae1eef40a5f95ebfd38a77b0fe2e7ed956902f6406cbfd75840f3cf2a",
                28,
            ),
            (
                Some(&vault),
                true,
                "0x5f12b6cac160138fe81f7fbb8507c9002160c057f9af1f4125ebb9a5fc75b7ed",
                "0xfb5be637bdc21a7dcc9ea82fced12a847340e71816b88c15ad026ece32bdbf5",
                27,
            ),
            (
                Some(&vault),
                false,
                "0x2c368eac5d46bd1c8fa218815840643a4c78569c18da66354265a919d30057e",
                "0x340db101bb5c75822c6a7edc2349ffed740e833682e5cbcf886fa8a333b4a5a6",
                27,
            ),
        ];
        for (vault_address, is_mainnet, r, s, v) in cases {
            let sig = sign_order_action(&key, &action, 42_000, is_mainnet, vault_address).unwrap();
            assert_eq!(
                sig.r,
                component(r),
                "r for vault={vault_address:?} mainnet={is_mainnet}"
            );
            assert_eq!(
                sig.s,
                component(s),
                "s for vault={vault_address:?} mainnet={is_mainnet}"
            );
            assert_eq!(
                sig.v, v,
                "v for vault={vault_address:?} mainnet={is_mainnet}"
            );
        }
    }

    #[test]
    fn parses_and_normalizes_an_account_address() {
        let address =
            AccountAddress::from_hex(" 0xABCDEFabcdef0123456789abcdef0123456789AB ").unwrap();
        assert_eq!(
            address.to_hex(),
            "0xabcdefabcdef0123456789abcdef0123456789ab"
        );
        assert!(AccountAddress::from_hex("0x1234").is_err());
        assert!(AccountAddress::from_hex("0xzz").is_err());
    }

    #[test]
    fn market_order_price_pads_buys_up_and_sells_down() {
        assert_eq!(market_order_price(100.0, true, 0.05), 105.0);
        assert_eq!(market_order_price(100.0, false, 0.05), 95.0);
    }

    #[test]
    fn order_action_serializes_to_the_expected_json_shape() {
        let action = sample_order();
        let json = serde_json::to_value(&action).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "type": "order",
                "orders": [{
                    "a": 0,
                    "b": true,
                    "p": "50000",
                    "s": "0.1",
                    "r": false,
                    "t": { "limit": { "tif": "Ioc" } }
                }],
                "grouping": "na"
            })
        );
    }
}
