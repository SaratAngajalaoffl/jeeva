use std::fmt;

use async_trait::async_trait;
use serde::Deserialize;

use crate::hyperliquid::{coin, dex};

#[derive(Debug)]
pub struct FundingRateError(pub String);

impl fmt::Display for FundingRateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for FundingRateError {}

/// Fetches a PERP's current real funding rate — the hourly rate
/// Hyperliquid actually applies to open positions. The real
/// implementation calls Hyperliquid's public info API; tests use a
/// fake implementation to avoid network calls.
#[async_trait]
pub trait FundingRateSource: Send + Sync {
    async fn funding_rate(&self, symbol: &str) -> Result<f64, FundingRateError>;
}

pub struct HyperliquidFundingRateSource {
    base_url: String,
    http: reqwest::Client,
}

impl HyperliquidFundingRateSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            http: reqwest::Client::new(),
        }
    }
}

impl Default for HyperliquidFundingRateSource {
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
    funding: String,
}

#[async_trait]
impl FundingRateSource for HyperliquidFundingRateSource {
    async fn funding_rate(&self, symbol: &str) -> Result<f64, FundingRateError> {
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
            .map_err(|e| FundingRateError(format!("metaAndAssetCtxs request failed: {e}")))?
            .json()
            .await
            .map_err(|e| FundingRateError(format!("metaAndAssetCtxs response invalid: {e}")))?;

        let index = meta
            .universe
            .iter()
            .position(|u| coin == crate::hyperliquid::coin(&u.name))
            .ok_or_else(|| FundingRateError(format!("unknown symbol: {symbol}")))?;
        let ctx = asset_ctxs
            .get(index)
            .ok_or_else(|| FundingRateError(format!("no asset context for symbol: {symbol}")))?;

        ctx.funding
            .parse()
            .map_err(|_| FundingRateError(format!("could not parse funding rate: {}", ctx.funding)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_a_hip3_funding_rate_from_its_dex() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/info"))
            .and(body_partial_json(json!({
                "type": "metaAndAssetCtxs",
                "dex": "xyz"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                { "universe": [{ "name": "xyz:AAOI" }] },
                [{ "funding": "0.0001" }]
            ])))
            .expect(1)
            .mount(&server)
            .await;

        let rate = HyperliquidFundingRateSource::new(server.uri())
            .funding_rate("xyz:AAOI")
            .await
            .unwrap();
        assert_eq!(rate, 0.0001);
    }
}
