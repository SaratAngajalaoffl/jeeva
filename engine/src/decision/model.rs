use serde::{Deserialize, Serialize};

/// Jev's decision output: the position direction the engine should be
/// in after this cycle. Never "buy"/"sell"/"hold" — see CONTEXT.md.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetDirection {
    Long,
    Short,
    Flat,
}

impl TargetDirection {
    pub fn as_str(&self) -> &'static str {
        match self {
            TargetDirection::Long => "long",
            TargetDirection::Short => "short",
            TargetDirection::Flat => "flat",
        }
    }
}

/// A PERP's actual open position direction. Unlike `TargetDirection`,
/// there is no `Flat` variant here — flat is the *absence* of a
/// `Direction` (`Option<Direction> = None`), not a value of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Long,
    Short,
}

impl Direction {
    pub fn as_str(&self) -> &'static str {
        match self {
            Direction::Long => "long",
            Direction::Short => "short",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Probabilities {
    pub long: f64,
    pub short: f64,
    pub flat: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JevDecision {
    pub direction: TargetDirection,
    pub confidence: f64,
    pub probabilities: Probabilities,
}

/// What the engine should do to a PERP's position given its current
/// state and Jev's latest Target Direction. Pure and total over every
/// (current, target) combination, so the whole state machine — no-op,
/// close-then-open, open from flat, close to flat — can be exercised
/// without any async/DB/network dependency.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PositionAction {
    NoOp,
    Open(Direction),
    Close,
    CloseThenOpen(Direction),
}

pub fn decide_action(current: Option<Direction>, target: TargetDirection) -> PositionAction {
    match (current, target) {
        (None, TargetDirection::Flat) => PositionAction::NoOp,
        (None, TargetDirection::Long) => PositionAction::Open(Direction::Long),
        (None, TargetDirection::Short) => PositionAction::Open(Direction::Short),

        (Some(Direction::Long), TargetDirection::Long) => PositionAction::NoOp,
        (Some(Direction::Short), TargetDirection::Short) => PositionAction::NoOp,

        (Some(Direction::Long), TargetDirection::Short) => {
            PositionAction::CloseThenOpen(Direction::Short)
        }
        (Some(Direction::Short), TargetDirection::Long) => {
            PositionAction::CloseThenOpen(Direction::Long)
        }

        (Some(_), TargetDirection::Flat) => PositionAction::Close,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staying_flat_is_a_no_op() {
        assert_eq!(
            decide_action(None, TargetDirection::Flat),
            PositionAction::NoOp
        );
    }

    #[test]
    fn opens_long_from_flat() {
        assert_eq!(
            decide_action(None, TargetDirection::Long),
            PositionAction::Open(Direction::Long)
        );
    }

    #[test]
    fn opens_short_from_flat() {
        assert_eq!(
            decide_action(None, TargetDirection::Short),
            PositionAction::Open(Direction::Short)
        );
    }

    #[test]
    fn repeating_long_is_a_no_op_no_pyramiding() {
        assert_eq!(
            decide_action(Some(Direction::Long), TargetDirection::Long),
            PositionAction::NoOp
        );
    }

    #[test]
    fn repeating_short_is_a_no_op_no_pyramiding() {
        assert_eq!(
            decide_action(Some(Direction::Short), TargetDirection::Short),
            PositionAction::NoOp
        );
    }

    #[test]
    fn flips_long_to_short() {
        assert_eq!(
            decide_action(Some(Direction::Long), TargetDirection::Short),
            PositionAction::CloseThenOpen(Direction::Short)
        );
    }

    #[test]
    fn flips_short_to_long() {
        assert_eq!(
            decide_action(Some(Direction::Short), TargetDirection::Long),
            PositionAction::CloseThenOpen(Direction::Long)
        );
    }

    #[test]
    fn closes_long_to_flat() {
        assert_eq!(
            decide_action(Some(Direction::Long), TargetDirection::Flat),
            PositionAction::Close
        );
    }

    #[test]
    fn closes_short_to_flat() {
        assert_eq!(
            decide_action(Some(Direction::Short), TargetDirection::Flat),
            PositionAction::Close
        );
    }
}
