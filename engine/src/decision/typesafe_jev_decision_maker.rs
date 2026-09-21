use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::decision_maker::{parse_direction, DecisionError, DecisionMaker};
use super::model::{JevDecision, Probabilities};

const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Serialize)]
struct ChoiceQuestion {
    criteria: &'static [&'static str],
}

#[derive(Debug, Serialize)]
struct SystemOneRequest<'a> {
    state: &'a str,
    question: ChoiceQuestion,
}

#[derive(Debug, Deserialize)]
struct SystemOneProbabilities {
    long: f64,
    short: f64,
    flat: f64,
}

#[derive(Debug, Deserialize)]
struct SystemOneResponse {
    choice: String,
    confidence: f64,
    probabilities: SystemOneProbabilities,
}

/// Calls TypeSafe's real `systemOne` API (docs.typesafe.ai) directly to
/// obtain a Target Direction. Authenticates via a bearer token supplied
/// only through `TYPESAFE_API_KEY` — never logged, never included in
/// any value returned to a caller — matching the private-key handling
/// discipline used for Hyperliquid credentials.
pub struct TypeSafeJevDecisionMaker {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl TypeSafeJevDecisionMaker {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            api_key: api_key.into(),
            http: reqwest::Client::builder()
                .timeout(DEFAULT_REQUEST_TIMEOUT)
                .build()
                .expect("failed to build HTTP client"),
        }
    }

    pub fn from_env() -> Self {
        let base_url = std::env::var("TYPESAFE_BASE_URL")
            .unwrap_or_else(|_| "https://api.typesafe.ai".to_string());
        let api_key = std::env::var("TYPESAFE_API_KEY")
            .expect("Missing required environment variable: TYPESAFE_API_KEY");
        Self::new(base_url, api_key)
    }
}

#[async_trait]
impl DecisionMaker for TypeSafeJevDecisionMaker {
    async fn decide(&self, symbol: &str, state: &str) -> Result<JevDecision, DecisionError> {
        let url = format!("{}/v1/systemOne", self.base_url);
        let request_body = SystemOneRequest {
            state,
            question: ChoiceQuestion {
                criteria: &["long", "short", "flat"],
            },
        };
        // Best-effort: if this ever fails to serialize, the raw request
        // is just omitted from the log rather than the cycle failing.
        let raw_request = serde_json::to_string(&request_body).ok();

        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&request_body)
            .send()
            .await
            .map_err(|e| {
                DecisionError::new(format!("systemOne request failed for {symbol}: {e}"))
                    .with_raw(raw_request.clone(), None)
            })?;

        let response = response.error_for_status().map_err(|e| {
            DecisionError::new(format!(
                "systemOne returned an error status for {symbol}: {e}"
            ))
            .with_raw(raw_request.clone(), None)
        })?;

        let raw_response = response.text().await.map_err(|e| {
            DecisionError::new(format!("systemOne response invalid for {symbol}: {e}"))
                .with_raw(raw_request.clone(), None)
        })?;

        let body: SystemOneResponse = serde_json::from_str(&raw_response).map_err(|e| {
            DecisionError::new(format!("systemOne response invalid for {symbol}: {e}"))
                .with_raw(raw_request.clone(), Some(raw_response.clone()))
        })?;

        let direction = parse_direction(&body.choice)
            .map_err(|e| e.with_raw(raw_request.clone(), Some(raw_response.clone())))?;

        Ok(JevDecision {
            direction,
            confidence: body.confidence,
            probabilities: Probabilities {
                long: body.probabilities.long,
                short: body.probabilities.short,
                flat: body.probabilities.flat,
            },
            raw_request,
            raw_response: Some(raw_response),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::model::TargetDirection;
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn adapter_against(server: &MockServer) -> TypeSafeJevDecisionMaker {
        TypeSafeJevDecisionMaker::new(server.uri(), "test-api-key")
    }

    #[tokio::test]
    async fn sends_a_correctly_shaped_request_and_parses_a_successful_response() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/systemOne"))
            .and(header("authorization", "Bearer test-api-key"))
            .and(body_json(json!({
                "state": "BTC context",
                "question": { "criteria": ["long", "short", "flat"] }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choice": "long",
                "confidence": 0.82,
                "probabilities": { "long": 0.7, "short": 0.1, "flat": 0.2 }
            })))
            .mount(&server)
            .await;

        let dm = adapter_against(&server).await;
        let decision = dm.decide("BTC", "BTC context").await.unwrap();

        assert_eq!(decision.direction, TargetDirection::Long);
        assert_eq!(decision.confidence, 0.82);
        assert_eq!(decision.probabilities.long, 0.7);
        assert_eq!(decision.probabilities.short, 0.1);
        assert_eq!(decision.probabilities.flat, 0.2);
    }

    #[tokio::test]
    async fn a_non_2xx_response_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/systemOne"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let dm = adapter_against(&server).await;
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.message.contains("error status"));
    }

    #[tokio::test]
    async fn a_malformed_response_body_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/systemOne"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let dm = adapter_against(&server).await;
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.message.contains("invalid"));
    }

    #[tokio::test]
    async fn an_unrecognized_choice_value_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/systemOne"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choice": "sideways",
                "confidence": 0.5,
                "probabilities": { "long": 0.3, "short": 0.3, "flat": 0.4 }
            })))
            .mount(&server)
            .await;

        let dm = adapter_against(&server).await;
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.message.contains("unrecognized choice"));
    }

    #[tokio::test]
    async fn a_timed_out_request_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/v1/systemOne"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
            .mount(&server)
            .await;

        let dm = TypeSafeJevDecisionMaker {
            base_url: server.uri(),
            api_key: "test-api-key".to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_millis(20))
                .build()
                .unwrap(),
        };

        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.message.contains("request failed"));
    }
}
