use std::sync::Arc;

use super::decision_maker::{DecisionMaker, DecisionMakerKind};

/// Holds one `DecisionMaker` per `DecisionMakerKind`, resolved fresh on
/// every decision cycle from the PERP's configured kind — so switching
/// a PERP's decision maker from the dashboard takes effect on the next
/// cycle, with no restart, the same way a leverage or position-size
/// change does today.
pub struct DecisionMakerRegistry {
    fake: Arc<dyn DecisionMaker>,
    typesafe: Arc<dyn DecisionMaker>,
    openrouter: Arc<dyn DecisionMaker>,
}

impl DecisionMakerRegistry {
    pub fn new(
        fake: Arc<dyn DecisionMaker>,
        typesafe: Arc<dyn DecisionMaker>,
        openrouter: Arc<dyn DecisionMaker>,
    ) -> Self {
        Self {
            fake,
            typesafe,
            openrouter,
        }
    }

    pub fn get(&self, kind: DecisionMakerKind) -> &Arc<dyn DecisionMaker> {
        match kind {
            DecisionMakerKind::Fake => &self.fake,
            DecisionMakerKind::TypeSafe => &self.typesafe,
            DecisionMakerKind::OpenRouter => &self.openrouter,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::model::{JevDecision, Probabilities, TargetDirection};
    use crate::decision::DecisionError;
    use async_trait::async_trait;

    #[allow(dead_code)]
    struct NamedDecisionMaker(&'static str);

    #[async_trait]
    impl DecisionMaker for NamedDecisionMaker {
        async fn decide(&self, _symbol: &str, _state: &str) -> Result<JevDecision, DecisionError> {
            Ok(JevDecision {
                direction: TargetDirection::Flat,
                confidence: 1.0,
                probabilities: Probabilities {
                    long: 0.0,
                    short: 0.0,
                    flat: 1.0,
                },
            })
        }
    }

    fn registry() -> DecisionMakerRegistry {
        DecisionMakerRegistry::new(
            Arc::new(NamedDecisionMaker("fake")),
            Arc::new(NamedDecisionMaker("typesafe")),
            Arc::new(NamedDecisionMaker("openrouter")),
        )
    }

    #[test]
    fn get_returns_the_matching_kind() {
        let registry = registry();
        assert!(Arc::ptr_eq(
            registry.get(DecisionMakerKind::Fake),
            registry.get(DecisionMakerKind::Fake)
        ));
        assert!(!Arc::ptr_eq(
            registry.get(DecisionMakerKind::Fake),
            registry.get(DecisionMakerKind::TypeSafe)
        ));
    }
}
