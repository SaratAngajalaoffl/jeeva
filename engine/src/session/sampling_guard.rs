use std::collections::{HashMap, HashSet};
use std::time::Duration;

use sqlx::PgPool;
use tokio::time::Instant;

use crate::config::{ConfigStore, MarketSettings};

use super::model::{TradingSessionConfig, TradingSessionStatus};
use super::store::SessionStore;

/// How long a session must be seen trading a market with sampling off
/// before the guard hard-closes it. Opening a session turns sampling on
/// through Mongo while the session itself lands in Postgres, and the two
/// stores reach the engine independently, so a brand-new session can
/// briefly look like a violation; a few poll ticks absorb that.
pub const SAMPLING_GUARD_GRACE: Duration = Duration::from_secs(10);

/// Every session that's still trading (`active` or `soft_closing`) a
/// market whose sampling is explicitly disabled. A market with no
/// settings at all is left alone rather than treated as disabled: the
/// config store may not have finished its initial load, and opening a
/// session always writes the market's settings anyway. Pure so the rule
/// is testable without a database.
pub fn sessions_without_sampling(
    sessions: &HashMap<String, TradingSessionConfig>,
    markets: &HashMap<String, MarketSettings>,
) -> Vec<String> {
    sessions
        .values()
        .filter(|s| {
            matches!(
                s.status,
                TradingSessionStatus::Active | TradingSessionStatus::SoftClosing
            )
        })
        .filter(|s| {
            markets
                .get(&s.symbol)
                .is_some_and(|market| !market.sampling_enabled)
        })
        .map(|s| s.id.clone())
        .collect()
}

/// Tracks how long each violation has persisted, returning the sessions
/// that have now been in violation for at least `grace` (and forgetting
/// any that resolved themselves in the meantime).
fn due_for_close(
    first_seen: &mut HashMap<String, Instant>,
    violating: Vec<String>,
    now: Instant,
    grace: Duration,
) -> Vec<String> {
    let violating: HashSet<String> = violating.into_iter().collect();
    first_seen.retain(|id, _| violating.contains(id));
    for id in &violating {
        first_seen.entry(id.clone()).or_insert(now);
    }
    first_seen
        .iter()
        .filter(|(_, seen)| now.duration_since(**seen) >= grace)
        .map(|(id, _)| id.clone())
        .collect()
}

async fn request_hard_close(pool: &PgPool, session_id: &str) {
    let result = sqlx::query(
        "UPDATE trading_sessions SET status = 'hard_closing' WHERE id = $1::uuid AND status IN ('active', 'soft_closing')",
    )
    .bind(session_id)
    .execute(pool)
    .await;

    if let Err(error) = result {
        tracing::error!(session_id, %error, "failed to hard-close session trading without sampling");
    }
}

/// Runs forever, enforcing "no market is ever traded blind" from the
/// engine side: a session left trading a market whose sampling has been
/// turned off is hard-closed (flattened, then closed by the decision and
/// reconcile loops as usual). The API already closes sessions when
/// sampling is disabled through it; this catches every other path, such
/// as a hand-edited `perpConfigs` document.
pub async fn run(
    pool: PgPool,
    sessions: SessionStore,
    markets: ConfigStore,
    poll_interval: Duration,
) -> ! {
    let mut first_seen: HashMap<String, Instant> = HashMap::new();

    loop {
        let violating = sessions_without_sampling(&sessions.snapshot(), &markets.snapshot());
        for session_id in due_for_close(
            &mut first_seen,
            violating,
            Instant::now(),
            SAMPLING_GUARD_GRACE,
        ) {
            tracing::warn!(
                session_id = %session_id,
                "session is trading a market with sampling disabled; hard-closing it"
            );
            request_hard_close(&pool, &session_id).await;
            first_seen.remove(&session_id);
        }

        tokio::time::sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::{DecisionMakerKind, HistoryFormat};

    fn session(id: &str, symbol: &str, status: TradingSessionStatus) -> TradingSessionConfig {
        TradingSessionConfig {
            id: id.to_string(),
            symbol: symbol.to_string(),
            decision_maker: DecisionMakerKind::Random,
            decision_frequency_seconds: 300.0,
            leverage: 1.0,
            position_size_usd: 100.0,
            history_window_seconds: 3600,
            history_format: HistoryFormat::Summary,
            wallet_id: None,
            status,
            store_decision_payloads: false,
            stop_loss_pct: None,
        }
    }

    fn market(symbol: &str, sampling_enabled: bool) -> (String, MarketSettings) {
        (
            symbol.to_string(),
            MarketSettings {
                symbol: symbol.to_string(),
                sampling_enabled,
                sampling_frequency_seconds: 60.0,
            },
        )
    }

    fn sessions(list: Vec<TradingSessionConfig>) -> HashMap<String, TradingSessionConfig> {
        list.into_iter().map(|s| (s.id.clone(), s)).collect()
    }

    #[test]
    fn flags_trading_sessions_on_a_market_with_sampling_off() {
        let sessions = sessions(vec![
            session("active", "BTC", TradingSessionStatus::Active),
            session("soft", "BTC", TradingSessionStatus::SoftClosing),
            session("sampled", "ETH", TradingSessionStatus::Active),
        ]);
        let markets = HashMap::from([market("BTC", false), market("ETH", true)]);

        let mut flagged = sessions_without_sampling(&sessions, &markets);
        flagged.sort();
        assert_eq!(flagged, vec!["active".to_string(), "soft".to_string()]);
    }

    #[test]
    fn leaves_sessions_already_hard_closing_alone() {
        let sessions = sessions(vec![session(
            "closing",
            "BTC",
            TradingSessionStatus::HardClosing,
        )]);
        let markets = HashMap::from([market("BTC", false)]);
        assert!(sessions_without_sampling(&sessions, &markets).is_empty());
    }

    #[test]
    fn treats_a_market_without_settings_as_unknown_not_disabled() {
        let sessions = sessions(vec![session("s1", "BTC", TradingSessionStatus::Active)]);
        assert!(sessions_without_sampling(&sessions, &HashMap::new()).is_empty());
    }

    #[test]
    fn only_closes_a_violation_once_it_outlasts_the_grace_period() {
        let grace = Duration::from_secs(10);
        let start = Instant::now();
        let mut first_seen = HashMap::new();

        assert!(due_for_close(&mut first_seen, vec!["s1".into()], start, grace).is_empty());
        assert!(due_for_close(
            &mut first_seen,
            vec!["s1".into()],
            start + Duration::from_secs(5),
            grace
        )
        .is_empty());
        assert_eq!(
            due_for_close(
                &mut first_seen,
                vec!["s1".into()],
                start + Duration::from_secs(10),
                grace
            ),
            vec!["s1".to_string()]
        );
    }

    #[test]
    fn a_violation_that_resolves_restarts_its_grace_period() {
        let grace = Duration::from_secs(10);
        let start = Instant::now();
        let mut first_seen = HashMap::new();

        due_for_close(&mut first_seen, vec!["s1".into()], start, grace);
        // Sampling came back on (e.g. the new session's config landed).
        due_for_close(
            &mut first_seen,
            vec![],
            start + Duration::from_secs(5),
            grace,
        );
        assert!(due_for_close(
            &mut first_seen,
            vec!["s1".into()],
            start + Duration::from_secs(12),
            grace
        )
        .is_empty());
    }
}
