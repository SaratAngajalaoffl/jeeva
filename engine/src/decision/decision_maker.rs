use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use super::model::{JevDecision, Probabilities, TargetDirection};

#[derive(Debug)]
pub struct DecisionError(pub String);

impl fmt::Display for DecisionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for DecisionError {}

/// Obtains a Target Direction for a PERP. Three implementations exist:
/// `FakeDecisionMaker` (synthetic, no network — the engine's default),
/// `TypeSafeJevDecisionMaker` (calls TypeSafe's real `systemOne` API
/// directly), and `OpenRouterJevDecisionMaker` (calls the same Jev
/// model via OpenRouter). Chosen per PERP via `PerpConfig::decision_maker`,
/// independent of the PERP's `ExecutionAdapter`/mock-live axis.
#[async_trait]
pub trait DecisionMaker: Send + Sync {
    async fn decide(&self, symbol: &str, state: &str) -> Result<JevDecision, DecisionError>;
}

/// Which `DecisionMaker` implementation a PERP is configured to use.
/// Mirrors the `perpConfigs.decisionMaker` field written by the
/// Express API. Defaults to `Fake` so a fresh PERP never depends on
/// external credentials before someone explicitly picks one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DecisionMakerKind {
    #[default]
    Fake,
    TypeSafe,
    OpenRouter,
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

/// A `DecisionMaker` that never calls the network. By default it
/// cycles through flat -> long -> short -> flat -> ... on every call,
/// which is enough to exercise the whole position state machine during
/// ad hoc manual exploration; tests can instead script an exact
/// sequence of directions via `with_sequence`.
pub struct FakeDecisionMaker {
    sequence: Vec<TargetDirection>,
    calls: AtomicUsize,
}

impl FakeDecisionMaker {
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
            "FakeDecisionMaker sequence must not be empty"
        );
        Self {
            sequence,
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl DecisionMaker for FakeDecisionMaker {
    async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        let direction = self.sequence[call % self.sequence.len()];
        Ok(decision_for(direction))
    }
}

/// A `DecisionMaker` used when the configured backend isn't available —
/// either no credentials were supplied (TypeSafe without
/// `TYPESAFE_API_KEY`) or the implementation doesn't exist yet
/// (OpenRouter). Every call fails loudly through the normal
/// decision-cycle failure/auto-flatten path rather than the engine
/// silently no-oping or panicking at startup.
pub struct UnconfiguredDecisionMaker {
    pub name: &'static str,
}

#[async_trait]
impl DecisionMaker for UnconfiguredDecisionMaker {
    async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
        Err(DecisionError(format!(
            "{} decision maker is not configured on this engine",
            self.name
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cycling_adapter_walks_flat_long_short_and_wraps() {
        let dm = FakeDecisionMaker::cycling();
        let mut directions = Vec::new();
        for _ in 0..4 {
            directions.push(dm.decide("BTC", "state").await.unwrap().direction);
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
        let dm = FakeDecisionMaker::with_sequence(vec![
            TargetDirection::Long,
            TargetDirection::Long,
        ]);
        assert_eq!(
            dm.decide("BTC", "state").await.unwrap().direction,
            TargetDirection::Long
        );
        assert_eq!(
            dm.decide("BTC", "state").await.unwrap().direction,
            TargetDirection::Long
        );
        assert_eq!(
            dm.decide("BTC", "state").await.unwrap().direction,
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

    #[tokio::test]
    async fn unconfigured_decision_maker_always_fails() {
        let dm = UnconfiguredDecisionMaker { name: "typesafe" };
        let error = dm.decide("BTC", "state").await.unwrap_err();
        assert!(error.0.contains("typesafe"));
    }
}
