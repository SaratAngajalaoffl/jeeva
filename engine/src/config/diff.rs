use serde_json::{json, Map, Value as JsonValue};

use super::model::MarketSettings;

/// Computes which fields differ between an old and new market settings,
/// keyed by field name, each mapping to `{"from": ..., "to": ...}`.
/// Returns an empty map if nothing changed.
pub fn diff_fields(old: &MarketSettings, new: &MarketSettings) -> Map<String, JsonValue> {
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

    field!("samplingEnabled", sampling_enabled);
    field!("samplingFrequencySeconds", sampling_frequency_seconds);

    changes
}

/// Logs a structured event for a market settings change: a `created`
/// event for a brand-new symbol, a `changed` event naming exactly which
/// fields differed (skipped entirely if nothing actually changed), or a
/// `removed` event when a symbol disappears from the collection.
pub fn log_change(old: Option<&MarketSettings>, new: &MarketSettings) {
    match old {
        None => {
            tracing::info!(
                symbol = %new.symbol,
                config = %serde_json::to_string(new).unwrap_or_default(),
                "market settings created"
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
                "market settings changed"
            );
        }
    }
}

pub fn log_removed(symbol: &str) {
    tracing::info!(symbol = %symbol, "market settings removed");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(symbol: &str) -> MarketSettings {
        MarketSettings {
            symbol: symbol.to_string(),
            sampling_enabled: false,
            sampling_frequency_seconds: 60.0,
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
        new.sampling_enabled = true;

        let changes = diff_fields(&old, &new);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes["samplingEnabled"]["from"], json!(false));
        assert_eq!(changes["samplingEnabled"]["to"], json!(true));
    }

    #[test]
    fn detects_frequency_changes() {
        let old = sample("BTC");
        let mut new = sample("BTC");
        new.sampling_frequency_seconds = 10.0;

        let changes = diff_fields(&old, &new);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes["samplingFrequencySeconds"]["to"], json!(10.0));
    }
}
