use serde_json::{json, Map, Value as JsonValue};

use super::model::PerpConfig;

/// Computes which fields differ between an old and new config, keyed by
/// field name, each mapping to `{"from": ..., "to": ...}`. Returns an
/// empty map if nothing changed.
pub fn diff_fields(old: &PerpConfig, new: &PerpConfig) -> Map<String, JsonValue> {
    let mut changes = Map::new();

    macro_rules! field {
        ($name:literal, $field:ident) => {
            if old.$field != new.$field {
                changes.insert(
                    $name.to_string(),
                    json!({ "from": old.$field, "to": new.$field }),
                );
            }
        };
    }

    field!("tradingEnabled", trading_enabled);
    field!("samplingEnabled", sampling_enabled);
    field!("decisionFrequencySeconds", decision_frequency_seconds);
    field!("samplingFrequencySeconds", sampling_frequency_seconds);
    field!("leverage", leverage);
    field!("positionSizeUsd", position_size_usd);
    field!("walletId", wallet_id);

    changes
}

/// Logs a structured event for a PERP config change: a `created` event
/// for a brand-new symbol, a `changed` event naming exactly which fields
/// differed (skipped entirely if nothing actually changed), or a
/// `removed` event when a symbol disappears from the collection.
pub fn log_change(old: Option<&PerpConfig>, new: &PerpConfig) {
    match old {
        None => {
            tracing::info!(
                symbol = %new.symbol,
                config = %serde_json::to_string(new).unwrap_or_default(),
                "perp config created"
            );
        }
        Some(old) => {
            let changes = diff_fields(old, new);
            if changes.is_empty() {
                return;
            }
            tracing::info!(
                symbol = %new.symbol,
                changes = %JsonValue::Object(changes).to_string(),
                "perp config changed"
            );
        }
    }
}

pub fn log_removed(symbol: &str) {
    tracing::info!(symbol = %symbol, "perp config removed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(symbol: &str) -> PerpConfig {
        PerpConfig {
            symbol: symbol.to_string(),
            trading_enabled: false,
            sampling_enabled: false,
            decision_frequency_seconds: 300.0,
            sampling_frequency_seconds: 60.0,
            leverage: 1.0,
            position_size_usd: 100.0,
            decision_maker: Default::default(),
            wallet_id: None,
        }
    }

    #[test]
    fn no_diff_when_nothing_changed() {
        let a = sample("BTC");
        let b = sample("BTC");
        assert!(diff_fields(&a, &b).is_empty());
    }

    #[test]
    fn detects_a_single_changed_field() {
        let old = sample("BTC");
        let mut new = sample("BTC");
        new.trading_enabled = true;

        let changes = diff_fields(&old, &new);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes["tradingEnabled"]["from"], json!(false));
        assert_eq!(changes["tradingEnabled"]["to"], json!(true));
    }

    #[test]
    fn detects_multiple_changed_fields_independently() {
        let old = sample("BTC");
        let mut new = sample("BTC");
        new.leverage = 10.0;
        new.position_size_usd = 500.0;

        let changes = diff_fields(&old, &new);
        assert_eq!(changes.len(), 2);
        assert!(changes.contains_key("leverage"));
        assert!(changes.contains_key("positionSizeUsd"));
        assert!(!changes.contains_key("tradingEnabled"));
    }

    #[test]
    fn detects_frequency_changes() {
        let old = sample("BTC");
        let mut new = sample("BTC");
        new.decision_frequency_seconds = 30.0;
        new.sampling_frequency_seconds = 10.0;

        let changes = diff_fields(&old, &new);
        assert_eq!(changes.len(), 2);
        assert_eq!(changes["decisionFrequencySeconds"]["to"], json!(30.0));
        assert_eq!(changes["samplingFrequencySeconds"]["to"], json!(10.0));
    }
}
