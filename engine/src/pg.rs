use sqlx::PgPool;

/// Runs a migration statement, tolerating the duplicate-object errors
/// Postgres can raise when two connections run a `CREATE ... IF NOT
/// EXISTS` concurrently (its existence check and creation aren't atomic
/// together) — this lets every component safely run its own migration
/// against a shared pool without a distributed lock.
pub async fn execute_idempotent(pool: &PgPool, sql: &'static str) -> Result<(), sqlx::Error> {
    match sqlx::query(sql).execute(pool).await {
        Ok(_) => Ok(()),
        Err(sqlx::Error::Database(db_err))
            if matches!(db_err.code().as_deref(), Some("23505") | Some("42P07")) =>
        {
            Ok(())
        }
        Err(e) => Err(e),
    }
}
