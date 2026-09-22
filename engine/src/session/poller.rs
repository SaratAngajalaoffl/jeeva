use std::collections::HashMap;
use std::time::Duration;

use sqlx::PgPool;

use crate::decision::{effective_history_window, DecisionMakerKind, HistoryFormat};

use super::model::{TradingSessionConfig, TradingSessionStatus};
use super::store::SessionStore;

type SessionRow = (
    String,
    String,
    String,
    f64,
    f64,
    f64,
    i32,
    String,
    Option<String>,
    String,
    bool,
    Option<f64>,
);

fn row_to_session(row: SessionRow) -> Option<TradingSessionConfig> {
    let (
        id,
        symbol,
        decision_maker,
        decision_frequency_seconds,
        leverage,
        position_size_usd,
        history_window_samples,
        history_format,
        wallet_id,
        status,
        store_decision_payloads,
        stop_loss_pct,
    ) = row;

    let Some(decision_maker) = DecisionMakerKind::from_db(&decision_maker) else {
        tracing::error!(session_id = %id, decision_maker, "unknown decision maker kind; skipping session");
        return None;
    };
    let Some(status) = TradingSessionStatus::from_db(&status) else {
        tracing::error!(session_id = %id, status, "unknown trading session status; skipping session");
        return None;
    };
    let Some(history_format) = HistoryFormat::from_db(&history_format) else {
        tracing::error!(session_id = %id, history_format, "unknown history format; skipping session");
        return None;
    };

    Some(TradingSessionConfig {
        id,
        symbol,
        decision_maker,
        decision_frequency_seconds,
        leverage,
        position_size_usd,
        // Clamped rather than rejected: a window outside the readable
        // range is a config mistake, not a reason to stop trading a
        // session entirely.
        history_window_samples: effective_history_window(history_window_samples.max(0) as u32),
        history_format,
        wallet_id,
        status,
        store_decision_payloads,
        stop_loss_pct,
    })
}

/// Postgres has no change-stream equivalent, so unlike the Mongo-backed
/// `ConfigStore`, this reloads every non-closed session on each tick
/// (mirrors `crate::wallets::WalletRegistry::refresh`'s poll-and-replace
/// pattern) rather than tailing individual row changes.
async fn refresh(pool: &PgPool, store: &SessionStore) {
    let rows = match sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id::text, symbol, decision_maker, decision_frequency_seconds,
               leverage, position_size_usd, history_window_samples,
               history_format, wallet_id::text, status, store_decision_payloads,
               stop_loss_pct
        FROM trading_sessions
        WHERE status <> 'closed'
        "#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to load trading sessions from Postgres");
            return;
        }
    };

    let sessions: HashMap<String, TradingSessionConfig> = rows
        .into_iter()
        .filter_map(row_to_session)
        .map(|s| (s.id.clone(), s))
        .collect();

    tracing::debug!(count = sessions.len(), "refreshed trading session store");
    store.replace_all(sessions);
}

/// Runs forever, refreshing the session store from Postgres on
/// `poll_interval`. Applies immediately on startup so sessions are
/// available before the first decision cycle runs.
pub async fn run(pool: PgPool, store: SessionStore, poll_interval: Duration) -> ! {
    loop {
        refresh(&pool, &store).await;
        tokio::time::sleep(poll_interval).await;
    }
}

/// Transitions a session to `closed`, freeing its wallet (the partial
/// unique index on `trading_sessions.wallet_id` only applies to
/// non-closed rows) — called once the engine has finished a soft/hard
/// close's flattening.
pub async fn close_session(pool: &PgPool, session_id: &str) {
    let result = sqlx::query(
        "UPDATE trading_sessions SET status = 'closed', closed_at = now() WHERE id = $1::uuid",
    )
    .bind(session_id)
    .execute(pool)
    .await;

    if let Err(error) = result {
        tracing::error!(session_id, %error, "failed to mark trading session closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_to_session_rejects_an_unknown_decision_maker() {
        let row: SessionRow = (
            "s1".to_string(),
            "BTC".to_string(),
            "not-a-real-kind".to_string(),
            300.0,
            1.0,
            100.0,
            250,
            "summary".to_string(),
            None,
            "active".to_string(),
            false,
            None,
        );
        assert!(row_to_session(row).is_none());
    }

    #[test]
    fn row_to_session_rejects_an_unknown_status() {
        let row: SessionRow = (
            "s1".to_string(),
            "BTC".to_string(),
            "random".to_string(),
            300.0,
            1.0,
            100.0,
            250,
            "summary".to_string(),
            None,
            "not-a-real-status".to_string(),
            false,
            None,
        );
        assert!(row_to_session(row).is_none());
    }

    #[test]
    fn row_to_session_rejects_an_unknown_history_format() {
        let row: SessionRow = (
            "s1".to_string(),
            "BTC".to_string(),
            "random".to_string(),
            300.0,
            1.0,
            100.0,
            250,
            "everything".to_string(),
            None,
            "active".to_string(),
            false,
            None,
        );
        assert!(row_to_session(row).is_none());
    }

    #[test]
    fn row_to_session_parses_a_valid_row() {
        let row: SessionRow = (
            "s1".to_string(),
            "BTC".to_string(),
            "openrouter".to_string(),
            30.0,
            5.0,
            250.0,
            500,
            "raw".to_string(),
            Some("w1".to_string()),
            "soft_closing".to_string(),
            true,
            None,
        );
        let session = row_to_session(row).unwrap();
        assert_eq!(session.id, "s1");
        assert_eq!(session.decision_maker, DecisionMakerKind::OpenRouter);
        assert_eq!(session.status, TradingSessionStatus::SoftClosing);
        assert_eq!(session.history_window_samples, 500);
        assert_eq!(session.history_format, HistoryFormat::Raw);
        assert_eq!(session.wallet_id.as_deref(), Some("w1"));
        assert!(session.store_decision_payloads);
    }

    #[test]
    fn row_to_session_clamps_an_out_of_range_history_window() {
        let row: SessionRow = (
            "s1".to_string(),
            "BTC".to_string(),
            "random".to_string(),
            300.0,
            1.0,
            100.0,
            0,
            "summary".to_string(),
            None,
            "active".to_string(),
            false,
            None,
        );
        // The column's CHECK constraint makes 0 unreachable in practice;
        // the engine still degrades to the smallest readable window
        // rather than refusing to run the session.
        assert_eq!(row_to_session(row).unwrap().history_window_samples, 1);
    }
}
