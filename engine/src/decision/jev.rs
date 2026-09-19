use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::model::{JevDecision, Probabilities, TargetDirection};

#[derive(Debug)]
pub struct JevError(pub String);

impl fmt::Display for JevError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for JevError {}

/// Obtains a Target Direction for a PERP from Jev. The real
/// implementation (a later slice) calls TypeSafe's `systemOne` API;
/// `FakeJevAdapter` requires no network access, making it the engine's
/// default decision source until real Jev access is granted.
#[async_trait]
pub trait JevDecisionSource: Send + Sync {
    async fn decide(&self, symbol: &str, state: &str) -> Result<JevDecision, JevError>;
}

fn decision_for(direction: TargetDirection) -> JevDecision {
    // A plausible-looking probability distribution skewed toward the
    // chosen direction, not just a hardcoded 1.0/0.0/0.0 — closer to
    // what a real Choice-question response looks like.
    let probabilities = match direction {
        TargetDirection::Long => Probabilities {
            long: 0.7,
            short: 0.1,
            flat: 0.2,
        },
        TargetDirection::Short => Probabilities {
            long: 0.1,
            short: 0.7,
            flat: 0.2,
        },
        TargetDirection::Flat => Probabilities {
            long: 0.15,
            short: 0.15,
            flat: 0.7,
        },
    };
    JevDecision {
        direction,
        confidence: 0.7,
        probabilities,
    }
}

/// A `JevDecisionSource` that never calls the network. By default it
/// cycles through flat -> long -> short -> flat -> ... on every call,
/// which is enough to exercise the whole position state machine during
/// ad hoc manual exploration; tests can instead script an exact
/// sequence of directions via `with_sequence`.
pub struct FakeJevAdapter {
    sequence: Vec<TargetDirection>,
    calls: AtomicUsize,
}

impl FakeJevAdapter {
    pub fn cycling() -> Self {
        Self::with_sequence(vec![
            TargetDirection::Flat,
            TargetDirection::Long,
            TargetDirection::Short,
        ])
    }

    pub fn with_sequence(sequence: Vec<TargetDirection>) -> Self {
        assert!(
            !sequence.is_empty(),
            "FakeJevAdapter sequence must not be empty"
        );
        Self {
            sequence,
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl JevDecisionSource for FakeJevAdapter {
    async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, JevError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let direction = self.sequence[call % self.sequence.len()];
        Ok(decision_for(direction))
    }
}

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

fn parse_direction(choice: &str) -> Result<TargetDirection, JevError> {
    match choice {
        "long" => Ok(TargetDirection::Long),
        "short" => Ok(TargetDirection::Short),
        "flat" => Ok(TargetDirection::Flat),
        other => Err(JevError(format!(
            "systemOne returned an unrecognized choice: {other}"
        ))),
    }
}

/// Calls TypeSafe's real `systemOne` API (docs.typesafe.ai) to obtain a
/// Target Direction. Authenticates via a bearer token supplied only
/// through `TYPESAFE_API_KEY` — never logged, never included in any
/// value returned to a caller — matching the private-key handling
/// discipline used for Hyperliquid credentials.
pub struct RealJevAdapter {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl RealJevAdapter {
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
impl JevDecisionSource for RealJevAdapter {
    async fn decide(&self, symbol: &str, state: &str) -> Result<JevDecision, JevError> {
        let url = format!("{}/v1/systemOne", self.base_url);

        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&SystemOneRequest {
                state,
                question: ChoiceQuestion {
                    criteria: &["long", "short", "flat"],
                },
            })
            .send()
            .await
            .map_err(|e| JevError(format!("systemOne request failed for {symbol}: {e}")))?;

        let response = response.error_for_status().map_err(|e| {
            JevError(format!(
                "systemOne returned an error status for {symbol}: {e}"
            ))
        })?;

        let body: SystemOneResponse = response
            .json()
            .await
            .map_err(|e| JevError(format!("systemOne response invalid for {symbol}: {e}")))?;

        let direction = parse_direction(&body.choice)?;

        Ok(JevDecision {
            direction,
            confidence: body.confidence,
            probabilities: Probabilities {
                long: body.probabilities.long,
                short: body.probabilities.short,
                flat: body.probabilities.flat,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cycling_adapter_walks_flat_long_short_and_wraps() {
        let jev = FakeJevAdapter::cycling();
        let mut directions = Vec::new();
        for _ in 0..4 {
            directions.push(jev.decide("BTC", "state").await.unwrap().direction);
        }
        assert_eq!(
            directions,
            vec![
                TargetDirection::Flat,
                TargetDirection::Long,
                TargetDirection::Short,
                TargetDirection::Flat,
            ]
        );
    }

    #[tokio::test]
    async fn scripted_sequence_is_followed_exactly_and_then_wraps() {
        let jev = FakeJevAdapter::with_sequence(vec![TargetDirection::Long, TargetDirection::Long]);
        assert_eq!(
            jev.decide("BTC", "state").await.unwrap().direction,
            TargetDirection::Long
        );
        assert_eq!(
            jev.decide("BTC", "state").await.unwrap().direction,
            TargetDirection::Long
        );
        assert_eq!(
            jev.decide("BTC", "state").await.unwrap().direction,
            TargetDirection::Long
        );
    }

    #[tokio::test]
    async fn probabilities_sum_to_one_for_every_direction() {
        for direction in [
            TargetDirection::Long,
            TargetDirection::Short,
            TargetDirection::Flat,
        ] {
            let decision = decision_for(direction);
            let sum = decision.probabilities.long
                + decision.probabilities.short
                + decision.probabilities.flat;
            assert!((sum - 1.0).abs() < 1e-9);
        }
    }

    mod real_adapter {
        use super::*;
        use serde_json::json;
        use wiremock::matchers::{body_json, header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        async fn adapter_against(server: &MockServer) -> RealJevAdapter {
            RealJevAdapter::new(server.uri(), "test-api-key")
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

            let jev = adapter_against(&server).await;
            let decision = jev.decide("BTC", "BTC context").await.unwrap();

            assert_eq!(decision.direction, TargetDirection::Long);
            assert_eq!(decision.confidence, 0.82);
            assert_eq!(decision.probabilities.long, 0.7);
            assert_eq!(decision.probabilities.short, 0.1);
            assert_eq!(decision.probabilities.flat, 0.2);
        }

        #[tokio::test]
        async fn a_non_2xx_response_is_a_decision_source_failure_not_a_crash() {
            let server = MockServer::start().await;

            Mock::given(method("POST"))
                .and(path("/v1/systemOne"))
                .respond_with(ResponseTemplate::new(500))
                .mount(&server)
                .await;

            let jev = adapter_against(&server).await;
            let error = jev.decide("BTC", "state").await.unwrap_err();
            assert!(error.0.contains("error status"));
        }

        #[tokio::test]
        async fn a_malformed_response_body_is_a_decision_source_failure_not_a_crash() {
            let server = MockServer::start().await;

            Mock::given(method("POST"))
                .and(path("/v1/systemOne"))
                .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
                .mount(&server)
                .await;

            let jev = adapter_against(&server).await;
            let error = jev.decide("BTC", "state").await.unwrap_err();
            assert!(error.0.contains("invalid"));
        }

        #[tokio::test]
        async fn an_unrecognized_choice_value_is_a_decision_source_failure_not_a_crash() {
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

            let jev = adapter_against(&server).await;
            let error = jev.decide("BTC", "state").await.unwrap_err();
            assert!(error.0.contains("unrecognized choice"));
        }

        #[tokio::test]
        async fn a_timed_out_request_is_a_decision_source_failure_not_a_crash() {
            let server = MockServer::start().await;

            Mock::given(method("POST"))
                .and(path("/v1/systemOne"))
                .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
                .mount(&server)
                .await;

            let jev = RealJevAdapter {
                base_url: server.uri(),
                api_key: "test-api-key".to_string(),
                http: reqwest::Client::builder()
                    .timeout(Duration::from_millis(20))
                    .build()
                    .unwrap(),
            };

            let error = jev.decide("BTC", "state").await.unwrap_err();
            assert!(error.0.contains("request failed"));
        }
    }
}
