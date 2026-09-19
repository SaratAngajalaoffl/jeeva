use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::decision_maker::{parse_direction, DecisionError, DecisionMaker};
use super::model::{JevDecision, Probabilities};

const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The Jev model on OpenRouter (docs: openrouter.ai/~typesafe/jev-latest).
const MODEL: &str = "typesafe/jev-latest";

/// The three criteria Jev chooses between. Mirrors the `criteria` sent
/// to TypeSafe's `systemOne` API, so both decision makers ask the same
/// question and answer in the same vocabulary.
const CRITERIA: [&str; 3] = ["long", "short", "flat"];

const SYSTEM_PROMPT: &str = "You are Jev, a trading decision model. Given the current market \
state of a perpetual futures position, decide the Target Direction the position should be in \
after this cycle. Answer with the requested JSON object: `choice` (the criterion you select), \
`confidence` (0 to 1), and `probabilities` (a distribution over every criterion, summing to 1).";

#[derive(Debug, Serialize)]
struct ChatMessage<'a> {
    role: &'static str,
    content: &'a str,
}

#[derive(Debug, Serialize)]
struct ChatCompletionRequest<'a> {
    model: &'static str,
    messages: [ChatMessage<'a>; 2],
    response_format: Value,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatCompletionMessage,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct JevProbabilities {
    long: f64,
    short: f64,
    flat: f64,
}

#[derive(Debug, Deserialize)]
struct JevChoice {
    choice: String,
    confidence: f64,
    probabilities: JevProbabilities,
}

/// The JSON Schema Jev's answer is constrained to — the OpenRouter
/// equivalent of `SystemOneRequest`'s `question.criteria`, so the reply
/// can be parsed into the same `JevDecision` shape.
fn response_format() -> Value {
    json!({
        "type": "json_schema",
        "json_schema": {
            "name": "jev_decision",
            "strict": true,
            "schema": {
                "type": "object",
                "properties": {
                    "choice": { "type": "string", "enum": CRITERIA },
                    "confidence": { "type": "number" },
                    "probabilities": {
                        "type": "object",
                        "properties": {
                            "long": { "type": "number" },
                            "short": { "type": "number" },
                            "flat": { "type": "number" }
                        },
                        "required": ["long", "short", "flat"],
                        "additionalProperties": false
                    }
                },
                "required": ["choice", "confidence", "probabilities"],
                "additionalProperties": false
            }
        }
    })
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
        let url = format!("{}/chat/completions", self.base_url);

        let response = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&ChatCompletionRequest {
                model: MODEL,
                messages: [
                    ChatMessage {
                        role: "system",
                        content: SYSTEM_PROMPT,
                    },
                    ChatMessage {
                        role: "user",
                        content: state,
                    },
                ],
                response_format: response_format(),
            })
            .send()
            .await
            .map_err(|e| DecisionError(format!("OpenRouter request failed for {symbol}: {e}")))?;

        let response = response.error_for_status().map_err(|e| {
            DecisionError(format!(
                "OpenRouter returned an error status for {symbol}: {e}"
            ))
        })?;

        let body: ChatCompletionResponse = response
            .json()
            .await
            .map_err(|e| DecisionError(format!("OpenRouter response invalid for {symbol}: {e}")))?;

        let content = body
            .choices
            .first()
            .ok_or_else(|| {
                DecisionError(format!(
                    "OpenRouter response contained no choices for {symbol}"
                ))
            })?
            .message
            .content
            .clone();
        let choice: JevChoice = serde_json::from_str(&content).map_err(|e| {
            DecisionError(format!("OpenRouter completion invalid for {symbol}: {e}"))
        })?;

        let direction = parse_direction(&choice.choice)?;

        Ok(JevDecision {
            direction,
            confidence: choice.confidence,
            probabilities: Probabilities {
                long: choice.probabilities.long,
                short: choice.probabilities.short,
                flat: choice.probabilities.flat,
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

    /// A chat-completion body wrapping Jev's answer, as OpenRouter
    /// returns it: the choice itself arrives as a JSON *string* inside
    /// `choices[0].message.content`.
    fn completion(answer: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "content": answer.to_string() } }]
        }))
    }

    fn adapter_against(server: &MockServer) -> OpenRouterJevDecisionMaker {
        OpenRouterJevDecisionMaker::new(server.uri(), "test-api-key")
    }

    #[tokio::test]
    async fn sends_a_correctly_shaped_request_and_parses_a_successful_response() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer test-api-key"))
            .and(body_json(json!({
                "model": "typesafe/jev-latest",
                "messages": [
                    { "role": "system", "content": SYSTEM_PROMPT },
                    { "role": "user", "content": "BTC context" }
                ],
                "response_format": response_format()
            })))
            .respond_with(completion(json!({
                "choice": "long",
                "confidence": 0.82,
                "probabilities": { "long": 0.7, "short": 0.1, "flat": 0.2 }
            })))
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
            .and(path("/chat/completions"))
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
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("invalid"));
    }

    #[tokio::test]
    async fn a_completion_that_is_not_the_expected_object_is_a_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "The market looks bullish to me." } }]
            })))
            .mount(&server)
            .await;

        let dm = adapter_against(&server);
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("invalid"));
    }

    #[tokio::test]
    async fn an_unrecognized_choice_value_is_a_decision_maker_failure_not_a_crash() {
        let server = MockServer::start().await;

        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(completion(json!({
                "choice": "sideways",
                "confidence": 0.5,
                "probabilities": { "long": 0.3, "short": 0.3, "flat": 0.4 }
            })))
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
            .and(path("/chat/completions"))
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
