use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::decision_maker::{parse_direction, DecisionError, DecisionMaker};
use super::model::{JevDecision, Probabilities};

const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/alpha";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The Jev model on OpenRouter (docs: openrouter.ai/~typesafe/jev-latest).
/// Note the leading `~`: OpenRouter's Decisions API addresses Jev with a
/// tilde-prefixed model id, unlike ordinary `/chat/completions` models.
const MODEL: &str = "~typesafe/jev-latest";

/// The id of the (sole) question sent to Jev, and the key its answer is
/// returned under in `answers`.
const QUESTION_ID: &str = "direction";

const QUESTION_INSTRUCTIONS: &str =
    "Given the current market state of a perpetual futures position, decide the Target \
Direction the position should be in after this cycle.";

#[derive(Debug, Serialize)]
struct DecisionRequest<'a> {
    model: &'static str,
    state: &'a str,
    questions: Value,
}

/// Jev is queried through OpenRouter's Decisions API rather than
/// `/chat/completions`: it doesn't generate text, it answers typed
/// questions about a `state` and returns calibrated probabilities. A
/// `choice` question mirrors `SystemOneRequest`'s `question.criteria`,
/// so the reply can be parsed into the same `JevDecision` shape.
fn questions() -> Value {
    json!({
        QUESTION_ID: {
            "type": "choice",
            "instructions": QUESTION_INSTRUCTIONS,
            "criteria": {
                "long": "Open or hold a long position",
                "short": "Open or hold a short position",
                "flat": "Stay out of the market"
            }
        }
    })
}

#[derive(Debug, Deserialize)]
struct DecisionResponse {
    answers: std::collections::HashMap<String, DirectionAnswer>,
}

#[derive(Debug, Deserialize)]
struct JevProbabilities {
    long: f64,
    short: f64,
    flat: f64,
}

#[derive(Debug, Deserialize)]
struct DirectionAnswer {
    choice: String,
    confidence: f64,
    probabilities: JevProbabilities,
}

/// Calls Jev via OpenRouter (`openrouter.ai/~typesafe/jev-latest`)
/// instead of TypeSafe's API directly, for operators who already hold
/// an OpenRouter key. Authenticates via a bearer token supplied only
/// through `OPENROUTER_API_KEY` — never logged, never included in any
/// value returned to a caller — matching the discipline used for
/// `TYPESAFE_API_KEY` and the Hyperliquid private key.
pub struct OpenRouterJevDecisionMaker {
    base_url: String,
    api_key: String,
    http: reqwest::Client,
}

impl OpenRouterJevDecisionMaker {
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
        let base_url =
            std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let api_key = std::env::var("OPENROUTER_API_KEY")
            .expect("Missing required environment variable: OPENROUTER_API_KEY");
        Self::new(base_url, api_key)
    }
}

#[async_trait]
impl DecisionMaker for OpenRouterJevDecisionMaker {
    async fn decide(&self, symbol: &str, state: &str) -> Result<JevDecision, DecisionError> {
        let url = format!("{}/decisions", self.base_url);

        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&DecisionRequest {
                model: MODEL,
                state,
                questions: questions(),
            })
            .send()
            .await
            .map_err(|e| DecisionError(format!("OpenRouter request failed for {symbol}: {e}")))?;

        let response = response.error_for_status().map_err(|e| {
            DecisionError(format!(
                "OpenRouter returned an error status for {symbol}: {e}"
            ))
        })?;

        let mut body: DecisionResponse = response
            .json()
            .await
            .map_err(|e| DecisionError(format!("OpenRouter response invalid for {symbol}: {e}")))?;

        let answer = body.answers.remove(QUESTION_ID).ok_or_else(|| {
            DecisionError(format!(
                "OpenRouter response contained no '{QUESTION_ID}' answer for {symbol}"
            ))
        })?;

        let direction = parse_direction(&answer.choice)?;

        Ok(JevDecision {
            direction,
            confidence: answer.confidence,
            probabilities: Probabilities {
                long: answer.probabilities.long,
                short: answer.probabilities.short,
                flat: answer.probabilities.flat,
            },
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

    /// A Decisions API response wrapping Jev's answer to the `direction`
    /// question, as OpenRouter returns it.
    fn decision_response(choice: &str, confidence: f64, probs: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({
            "model": "typesafe/jev-1.13-20260917",
            "answers": {
                QUESTION_ID: {
                    "type": "choice",
                    "choice": choice,
                    "probabilities": probs,
                    "confidence": confidence
                }
            },
            "usage": { "input_tokens": 1, "output_tokens": 1, "cost": 0.0 },
            "id": "gen-dec-test",
            "provider": "TypeSafe"
        }))
    }

    fn adapter_against(server: &MockServer) -> OpenRouterJevDecisionMaker {
        OpenRouterJevDecisionMaker::new(server.uri(), "test-api-key")
    }

    #[tokio::test]
    async fn sends_a_correctly_shaped_request_and_parses_a_successful_response() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/decisions"))
            .and(header("authorization", "Bearer test-api-key"))
            .and(body_json(json!({
                "model": "~typesafe/jev-latest",
                "state": "BTC context",
                "questions": questions()
            })))
            .respond_with(decision_response(
                "long",
                0.82,
                json!({ "long": 0.7, "short": 0.1, "flat": 0.2 }),
            ))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
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
            .and(path("/decisions"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("error status"));
    }

    #[tokio::test]
    async fn a_malformed_response_body_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/decisions"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("invalid"));
    }

    #[tokio::test]
    async fn a_response_missing_the_direction_answer_is_a_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/decisions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model": "typesafe/jev-1.13-20260917",
                "answers": {},
                "usage": { "input_tokens": 1, "output_tokens": 1, "cost": 0.0 },
                "id": "gen-dec-test",
                "provider": "TypeSafe"
            })))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("no 'direction' answer"));
    }

    #[tokio::test]
    async fn an_unrecognized_choice_value_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/decisions"))
            .respond_with(decision_response(
                "sideways",
                0.5,
                json!({ "long": 0.3, "short": 0.3, "flat": 0.4 }),
            ))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("unrecognized choice"));
    }

    #[tokio::test]
    async fn a_timed_out_request_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/decisions"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(200)))
            .mount(&server)
            .await;

        let dm = OpenRouterJevDecisionMaker {
            base_url: server.uri(),
            api_key: "test-api-key".to_string(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_millis(20))
                .build()
                .unwrap(),
        };

        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("request failed"));
    }
}
