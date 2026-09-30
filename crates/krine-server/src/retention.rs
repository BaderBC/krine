//! Logical expiry has one clock and a durable floor. Physical work may lag it,
//! but can only delete below an already committed floor.
use crate::{
    App,
    error::{ApiError, Result},
    history,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::time::Duration;

const CLEANUP_INTERVAL: i64 = 4 * 3_600_000;

pub(crate) struct Retention {
    pub days: i64,
    pub requested_days: i64,
    pub cutoff: i64,
}
impl Retention {
    pub fn description(&self) -> Value {
        json!({"days":self.days,"requested_days":self.requested_days,
            "applying":self.days != self.requested_days,"available_since":self.cutoff})
    }
}

pub(crate) async fn configure(db: &sqlx::PgPool, days: i64) -> Result<()> {
    let mut tx = db.begin().await?;
    crate::operators::gate(&mut tx, true).await?;
    let previous: i32 =
        sqlx::query_scalar("SELECT requested_days FROM analytical_retention WHERE singleton")
            .fetch_one(&mut *tx)
            .await?;
    // Capture the old rolling boundary even when nobody read history for months.
    // An extension waits for the one-time removal of legacy rolling TTLs.
    sqlx::query("UPDATE analytical_retention SET expired_before=GREATEST(expired_before,(extract(epoch FROM clock_timestamp())*1000)::bigint-LEAST(days,$1)*86400000::bigint), requested_days=$1, days=CASE WHEN NOT EXISTS(SELECT 1 FROM analytical_cleanup WHERE NOT retired) THEN $1 ELSE LEAST(days,$1) END WHERE singleton")
        .bind(days).execute(&mut *tx).await?;
    if i64::from(previous) != days {
        crate::operators::record(
            &mut tx,
            &crate::operators::host_actor(),
            crate::operators::Audit::new(
                "retention.configure",
                "installation",
                "analytical_retention",
            )
            .changes(json!({"previous_days":previous,"days":days})),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn current(app: &App) -> Result<Retention> {
    // Admin history reads are bounded control-plane operations. Commit the
    // boundary before using it, including if the PostgreSQL clock moves back.
    let row = sqlx::query("UPDATE analytical_retention SET expired_before=GREATEST(expired_before,(extract(epoch FROM clock_timestamp())*1000)::bigint-days::bigint*86400000) WHERE singleton RETURNING days,requested_days,expired_before")
        .fetch_one(&app.db).await?;
    Ok(Retention {
        days: i64::from(row.get::<i32, _>("days")),
        requested_days: i64::from(row.get::<i32, _>("requested_days")),
        cutoff: row.get("expired_before"),
    })
}

#[derive(Deserialize)]
struct Mutations {
    latest: String,
    pending: String,
}
async fn mutations(app: &App, table: &str) -> Result<(i64, bool)> {
    // Only identifiers/status for one of this installation's two owned tables.
    // No command, exception or cross-table metadata access is granted.
    let response = history::clickhouse(app,
        "SELECT toString(max(toInt64OrZero(extract(mutation_id,'^mutation_([0-9]+)')))) AS latest,toString(countIf(is_done=0)) AS pending FROM system.mutations WHERE database='krine' AND table={table:String} FORMAT JSONEachRow",
        vec![("param_table",table.into())],None).await?;
    let status: Mutations =
        serde_json::from_str(response.trim()).map_err(|_| ApiError::unavailable())?;
    let latest = status.latest.parse().map_err(|_| ApiError::unavailable())?;
    let pending: u64 = status
        .pending
        .parse()
        .map_err(|_| ApiError::unavailable())?;
    Ok((latest, pending != 0))
}

pub(crate) async fn maintain(app: &App) -> Result<()> {
    // The transaction holds only this advisory lock. Durable intent/floor writes
    // use separate short transactions so crashes cannot roll them back after CH
    // has accepted irreversible work. Dropping/cancelling the task frees the lock.
    let mut guard = app.db.begin().await?;
    let acquired: bool = sqlx::query_scalar(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('history-physical-cleanup',0))",
    )
    .fetch_one(&mut *guard)
    .await?;
    if !acquired {
        return Ok(());
    }
    let due: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM analytical_cleanup WHERE baseline IS NOT NULL OR next_cleanup<=(extract(epoch FROM clock_timestamp())*1000)::bigint)")
        .fetch_one(&app.db).await?;
    if !due {
        return activate(app).await;
    }
    // This only creates missing tables / advances the existing bounded legacy
    // copy. Export uses its own worker and never waits for a cleanup mutation.
    history::initialize(app).await?;
    for versioned in [false, true] {
        maintain_table(app, versioned).await?;
    }
    activate(app).await
}

async fn activate(app: &App) -> Result<()> {
    // Recompute the old effective boundary at activation, not at the earlier
    // request. Data that expired during a slow retirement cannot reappear.
    sqlx::query("UPDATE analytical_retention SET expired_before=GREATEST(expired_before,(extract(epoch FROM clock_timestamp())*1000)::bigint-days::bigint*86400000),days=requested_days WHERE singleton AND days<>requested_days AND NOT EXISTS(SELECT 1 FROM analytical_cleanup WHERE NOT retired)")
        .execute(&app.db).await?;
    Ok(())
}

async fn maintain_table(app: &App, versioned: bool) -> Result<()> {
    let key = if versioned { "history_v2" } else { "history" };
    let table = history::table(app, versioned);
    let row = sqlx::query("SELECT *, (extract(epoch FROM clock_timestamp())*1000)::bigint AS now FROM analytical_cleanup WHERE table_name=$1")
        .bind(key).fetch_one(&app.db).await?;
    let baseline: Option<i64> = row.get("baseline");
    let retired: bool = row.get("retired");
    if baseline.is_none() && row.get::<i64, _>("next_cleanup") > row.get::<i64, _>("now") {
        return Ok(());
    }
    let query_id = format!("krine-history-cleanup-{table}");
    if baseline.is_none() && !retired {
        // REMOVE TTL alone is not a barrier against an already selected TTL
        // merge. The following mutation must also finish before extension.
        let definition =
            history::clickhouse(app, &format!("SHOW CREATE TABLE {table}"), vec![], None).await?;
        if definition.contains("TTL ") {
            history::clickhouse(
                app,
                &format!("ALTER TABLE {table} REMOVE TTL"),
                vec![("query_id", query_id.clone())],
                None,
            )
            .await?;
        }
    }
    let (latest, pending) = mutations(app, &table).await?;
    if let Some(previous) = baseline
        && latest > previous
        && !pending
    {
        return completed(app, key).await;
    }
    if pending {
        return Ok(());
    }
    let (baseline, cutoff) = if let Some(baseline) = baseline {
        (baseline, row.get("cutoff"))
    } else {
        let floor = current(app).await?.cutoff;
        sqlx::query("UPDATE analytical_cleanup SET cutoff=$2,baseline=$3 WHERE table_name=$1")
            .bind(key)
            .bind(floor)
            .bind(latest)
            .execute(&app.db)
            .await?;
        (latest, floor)
    };
    // A fixed query ID serializes even submissions whose HTTP acknowledgement
    // was lost. The engine's queue guard then forbids a second unfinished job.
    // Retrying after completion is harmless: its immutable cutoff is committed.
    history::clickhouse(app,
        &format!("ALTER TABLE {table} DELETE WHERE at < {cutoff} SETTINGS mutations_sync=0,number_of_mutations_to_throw=1"),
        vec![("query_id",query_id)],None).await?;
    #[cfg(test)]
    if app.provider_test.lose_cleanup_ack {
        return Err(ApiError::unavailable());
    }
    let (latest, pending) = mutations(app, &table).await?;
    if latest > baseline && !pending {
        completed(app, key).await?;
    }
    Ok(())
}

async fn completed(app: &App, table: &str) -> Result<()> {
    sqlx::query("UPDATE analytical_cleanup SET retired=true,baseline=NULL,next_cleanup=(extract(epoch FROM clock_timestamp())*1000)::bigint+$2 WHERE table_name=$1")
        .bind(table).bind(CLEANUP_INTERVAL).execute(&app.db).await?;
    Ok(())
}

pub(crate) async fn worker(app: App, mut shutdown: tokio::sync::watch::Receiver<bool>) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _=shutdown.changed()=>break,
            _=interval.tick()=> {
                if let Err(error)=maintain(&app).await {
                    tracing::warn!(code=error.code,"analytical retention cleanup pending");
                }
            }
        }
    }
}
