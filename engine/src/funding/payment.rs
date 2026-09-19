use crate::decision::Direction;

/// The wallet balance change (USD) for one funding payment on an open
/// position. Matches Hyperliquid's real convention: a positive funding
/// rate means longs pay shorts (payment = notional * oracle_price *
/// rate; we already carry `notional_usd` in price terms, so it's
/// simply `notional_usd * rate`). Pure and DB/network-free, so the
/// crediting/debiting math is directly testable.
pub fn calculate_funding_payment(
    direction: Direction,
    notional_usd: f64,
    funding_rate: f64,
) -> f64 {
    match direction {
        Direction::Long => -notional_usd * funding_rate,
        Direction::Short => notional_usd * funding_rate,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_pays_when_funding_rate_is_positive() {
        let payment = calculate_funding_payment(Direction::Long, 1000.0, 0.0001);
        assert!((payment + 0.1).abs() < 1e-9);
    }

    #[test]
    fn a_short_receives_when_funding_rate_is_positive() {
        let payment = calculate_funding_payment(Direction::Short, 1000.0, 0.0001);
        assert!((payment - 0.1).abs() < 1e-9);
    }

    #[test]
    fn a_long_receives_when_funding_rate_is_negative() {
        let payment = calculate_funding_payment(Direction::Long, 1000.0, -0.0001);
        assert!((payment - 0.1).abs() < 1e-9);
    }

    #[test]
    fn a_short_pays_when_funding_rate_is_negative() {
        let payment = calculate_funding_payment(Direction::Short, 1000.0, -0.0001);
        assert!((payment + 0.1).abs() < 1e-9);
    }

    #[test]
    fn zero_funding_rate_is_a_no_op() {
        assert_eq!(calculate_funding_payment(Direction::Long, 1000.0, 0.0), 0.0);
        assert_eq!(
            calculate_funding_payment(Direction::Short, 1000.0, 0.0),
            0.0
        );
    }

    #[test]
    fn payment_scales_with_notional() {
        let small = calculate_funding_payment(Direction::Long, 100.0, 0.001);
        let large = calculate_funding_payment(Direction::Long, 1000.0, 0.001);
        assert!((large - small * 10.0).abs() < 1e-9);
    }
}
