use std::time::Duration;

use sqlx::PgPool;

/// Default market-data TTL: seven days. Matches the default used when
/// `MARKET_DATA_TTL_DAYS` is unset.
pub const DEFAULT_TTL_DAYS: f64 = 7.0;

/// Parses a `MARKET_DATA_TTL_DAYS` value. Unset/blank falls back to
/// `DEFAULT_TTL_DAYS`; a malformed value is an error so a bad
/// deployment config fails fast at startup rather than silently
/// retaining an unintended amount of history. Pure so it's unit-testable
/// without mutating the process environment.
pub fn parse_ttl_days(raw: Option<&str>) -> Result<f64, String> {
    let raw = match raw {
        Some(value) if !value.trim().is_empty() => value,
        _ => return Ok(DEFAULT_TTL_DAYS),
    };

    match raw.trim().parse::<f64>() {
        Ok(days) if days.is_finite() && days > 0.0 => Ok(days),
        _ => Err(format!(
            "Invalid MARKET_DATA_TTL_DAYS: {raw} (expected a positive number of days)"
        )),
    }
}

/// The market-data TTL, in days, from the environment.
pub fn ttl_days_from_env() -> Result<f64, String> {
    parse_ttl_days(std::env::var("MARKET_DATA_TTL_DAYS").ok().as_deref())
}

/// Deletes market-data samples older than `ttl_days`, returning how many
/// rows were removed.
pub async fn prune_expired(pool: &PgPool, ttl_days: f64) -> Result<u64, sqlx::Error> {
    let result =
        sqlx::query("DELETE FROM market_data WHERE time < now() - make_interval(secs => $1)")
            .bind(ttl_days * 86_400.0)
            .execute(pool)
            .await?;

    Ok(result.rows_affected())
}

/// Runs forever, pruning expired market data every `interval`. The TTL
/// is captured once at startup (it's deployment configuration, not
/// mutable runtime state).
pub async fn run(pool: PgPool, ttl_days: f64, interval: Duration) -> ! {
    loop {
        match prune_expired(&pool, ttl_days).await {
            Ok(removed) if removed > 0 => {
                tracing::info!(removed, ttl_days, "pruned expired market data");
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(%error, ttl_days, "failed to prune expired market data");
            }
        }
        tokio::time::sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_seven_days_when_unset_or_blank() {
        assert_eq!(parse_ttl_days(None).unwrap(), 7.0);
        assert_eq!(parse_ttl_days(Some("")).unwrap(), 7.0);
        assert_eq!(parse_ttl_days(Some("   ")).unwrap(), 7.0);
    }

    #[test]
    fn accepts_a_positive_number_of_days() {
        assert_eq!(parse_ttl_days(Some("30")).unwrap(), 30.0);
        assert_eq!(parse_ttl_days(Some("1.5")).unwrap(), 1.5);
    }

    #[test]
    fn rejects_malformed_values() {
        for value in ["0", "-1", "abc", "NaN", "inf"] {
            assert!(
                parse_ttl_days(Some(value)).is_err(),
                "expected {value} to be rejected"
            );
        }
    }
}
