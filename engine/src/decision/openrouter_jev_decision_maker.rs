use async_trait::async_trait;

use super::decision_maker::{DecisionError, DecisionMaker};
use super::model::JevDecision;

/// Calls Jev via OpenRouter (`openrouter.ai/~typesafe/jev-latest`)
/// instead of TypeSafe's API directly — see
/// `TypeSafeJevDecisionMaker` for the request/response shape this
/// should mirror once implemented.
///
/// Not yet implemented (tracked in a GitHub issue). The intended shape:
/// authenticate via a bearer token from `OPENROUTER_API_KEY`, POST to
/// OpenRouter's chat-completions endpoint with model
/// `typesafe/jev-latest` and a prompt/tool-call shaped like
/// `TypeSafeJevDecisionMaker`'s `SystemOneRequest`, then parse the
/// response into the same `JevDecision`/`TargetDirection` shape.
/// `decide()` currently always fails so a PERP switched to this
/// decision maker errors loudly through the normal decision-cycle
/// failure/auto-flatten path rather than silently no-oping.
pub struct OpenRouterJevDecisionMaker;

impl OpenRouterJevDecisionMaker {
    pub fn unimplemented() -> Self {
        Self
    }
}

#[async_trait]
impl DecisionMaker for OpenRouterJevDecisionMaker {
    async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
        Err(DecisionError(
            "OpenRouterJevDecisionMaker is not yet implemented".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn always_fails_until_implemented() {
        let dm = OpenRouterJevDecisionMaker::unimplemented();
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("not yet implemented"));
    }
}
