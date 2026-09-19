use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;

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
}
