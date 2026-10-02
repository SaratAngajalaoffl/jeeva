use async_trait::async_trait;
use serde::Deserialize;
use std::fmt;

use super::model::MarketDataSample;
use crate::hyperliquid::{coin, dex};

#[derive(Debug)]
pub struct MarketDataError(pub String);

impl fmt::Display for MarketDataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for MarketDataError {}

/// Abstracts fetching a PERP's current price, open interest, volume,
/// and orderbook-derived spread/mid-price. The real implementation
/// calls Hyperliquid's public info API (no wallet/credentials needed);
/// tests use a fake implementation to avoid network calls.
#[async_trait]
pub trait MarketDataClient: Send + Sync {
    async fn fetch_sample(&self, symbol: &str) -> Result<MarketDataSample, MarketDataError>;
}

pub struct HyperliquidMarketDataClient {
    base_url: String,
    http: reqwest::Client,
}

impl HyperliquidMarketDataClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }
}

impl Default for HyperliquidMarketDataClient {
    fn default() -> Self {
        Self::new("https://api.hyperliquid.xyz")
    }
}

#[derive(Debug, Deserialize)]
struct Universe {
    name: String,
}

#[derive(Debug, Deserialize)]
struct MetaPage {
    universe: Vec<Universe>,
}

#[derive(Debug, Deserialize)]
struct AssetCtx {
    #[serde(rename = "markPx")]
    mark_px: String,
    #[serde(rename = "midPx")]
    mid_px: Option<String>,
    #[serde(rename = "openInterest")]
    open_interest: String,
    #[serde(rename = "dayNtlVlm")]
    day_ntl_vlm: String,
}

#[derive(Debug, Deserialize)]
struct Level {
    px: String,
}

#[derive(Debug, Deserialize)]
struct L2BookResponse {
    levels: Vec<Vec<Level>>,
}

fn parse_f64(value: &str, field: &str) -> Result<f64, MarketDataError> {
    value
        .parse()
        .map_err(|_| MarketDataError(format!("could not parse {field} value: {value}")))
}

#[async_trait]
impl MarketDataClient for HyperliquidMarketDataClient {
    async fn fetch_sample(&self, symbol: &str) -> Result<MarketDataSample, MarketDataError> {
        let url = format!("{}/info", self.base_url);
        let dex = dex(symbol);
        let coin = coin(symbol);

        let mut request = serde_json::json!({ "type": "metaAndAssetCtxs" });
        if let Some(dex) = dex {
            request["dex"] = serde_json::Value::String(dex.to_string());
        }
        let (meta, asset_ctxs): (MetaPage, Vec<AssetCtx>) = self
            .http
            .post(&url)
            .json(&request)
            .send()
            .await
            .map_err(|e| MarketDataError(format!("metaAndAssetCtxs request failed: {e}")))?
            .json()
            .await
            .map_err(|e| MarketDataError(format!("metaAndAssetCtxs response invalid: {e}")))?;

        let index = meta
            .universe
            .iter()
            .position(|u| coin == crate::hyperliquid::coin(&u.name))
            .ok_or_else(|| MarketDataError(format!("unknown symbol: {symbol}")))?;
        let ctx = asset_ctxs
            .get(index)
            .ok_or_else(|| MarketDataError(format!("no asset context for symbol: {symbol}")))?;

        let price = parse_f64(&ctx.mark_px, "markPx")?;
        let open_interest = parse_f64(&ctx.open_interest, "openInterest")?;
        let volume = parse_f64(&ctx.day_ntl_vlm, "dayNtlVlm")?;

        let book: L2BookResponse = self
            .http
            .post(&url)
            .json(&serde_json::json!({ "type": "l2Book", "coin": symbol }))
            .send()
            .await
            .map_err(|e| MarketDataError(format!("l2Book request failed: {e}")))?
            .json()
            .await
            .map_err(|e| MarketDataError(format!("l2Book response invalid: {e}")))?;

        let best_bid = book
            .levels
            .first()
            .and_then(|side| side.first())
            .map(|level| parse_f64(&level.px, "bid px"))
            .transpose()?
            .ok_or_else(|| MarketDataError(format!("no bid levels for symbol: {symbol}")))?;
        let best_ask = book
            .levels
            .get(1)
            .and_then(|side| side.first())
            .map(|level| parse_f64(&level.px, "ask px"))
            .transpose()?
            .ok_or_else(|| MarketDataError(format!("no ask levels for symbol: {symbol}")))?;

        let mid_price = match &ctx.mid_px {
            Some(mid) => parse_f64(mid, "midPx")?,
            None => (best_bid + best_ask) / 2.0,
        };

        Ok(MarketDataSample {
            symbol: symbol.to_string(),
            price,
            open_interest,
            volume,
            spread: best_ask - best_bid,
            mid_price,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_a_hip3_sample_with_consistent_namespacing() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .and(body_partial_json(json!({
                "type": "metaAndAssetCtxs",
                "dex": "xyz"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "universe": [{ "name": "xyz:AAOI" }] },
                [{
                    "markPx": "101.5",
                    "midPx": "101.5",
                    "openInterest": "1000",
                    "dayNtlVlm": "250000"
                }]
            ])))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .and(body_partial_json(json!({
                "type": "l2Book",
                "coin": "xyz:AAOI"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "levels": [[{ "px": "101.4" }], [{ "px": "101.6" }]]
            })))
            .mount(&server)
            .await;

        let sample = HyperliquidMarketDataClient::new(server.uri())
            .fetch_sample("xyz:AAOI")
            .await
            .unwrap();

        assert_eq!(sample.symbol, "xyz:AAOI");
        assert_eq!(sample.price, 101.5);
        assert_eq!(sample.open_interest, 1000.0);
        assert_eq!(sample.volume, 250000.0);
        assert!((sample.spread - 0.2).abs() < 1e-9);
    }
}
