//! One short PG lock serializes projection publication and coherent reads. A
//! fresh generation is rebuilt off to the side after every Valkey incarnation
//! or watermark mismatch; old generations expire without destructive commands.
use crate::{
    App,
    error::{ApiError, Result},
    util,
};
use redis::AsyncCommands;
use sqlx::{Postgres, Row, Transaction};

pub const SNAPSHOT_BUDGET_MS: i64 = 5_000;
const WINDOW_SECONDS: i64 = 300;
const COUNTER_TTL_SECONDS: i64 = WINDOW_SECONDS + (SNAPSHOT_BUDGET_MS + 999) / 1000 + 1;

pub struct Ready {
    pub generation: String,
    pub run_id: String,
    pub watermark: i64,
}
const PROJECT: &str = r#"
if redis.call('GET',KEYS[1]) ~= ARGV[1] then return -1 end
for i=3,#KEYS do
  local offset=5+(i-3)*2
  redis.call('ZADD',KEYS[i],ARGV[offset+1],ARGV[offset])
  redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf','('..ARGV[2])
  redis.call('EXPIRE',KEYS[i],ARGV[4])
end
redis.call('SET',KEYS[2],ARGV[3],'EX',3600)
return 1
"#;
async fn incarnation(app: &App) -> Result<String> {
    let info: String = redis::cmd("INFO")
        .arg("server")
        .query_async(&mut app.redis.clone())
        .await?;
    info.lines()
        .find_map(|line| line.trim().strip_prefix("run_id:").map(str::to_owned))
        .ok_or_else(ApiError::valkey)
}
pub async fn locked_ready(app: &App, tx: &mut Transaction<'_, Postgres>) -> Result<Ready> {
    let row = sqlx::query(
        "SELECT run_id,generation,watermark FROM projection_state WHERE singleton=true FOR UPDATE",
    )
    .fetch_one(&mut **tx)
    .await?;
    let run = incarnation(app).await?;
    let generation: String = row.get("generation");
    let watermark: i64 = row.get("watermark");
    let cache: Option<String> = app.redis.clone().get("krine:projection:watermark").await?;
    let marker: Option<String> = app.redis.clone().get("krine:projection:generation").await?;
    if !generation.starts_with("g1_")
        || row.get::<String, _>("run_id") != run
        || cache.as_deref() != Some(&watermark.to_string())
        || marker.as_deref() != Some(&generation)
    {
        rebuild(app, tx, &run).await
    } else {
        Ok(Ready {
            generation,
            run_id: run.to_owned(),
            watermark,
        })
    }
}
async fn rebuild(app: &App, tx: &mut Transaction<'_, Postgres>, run: &str) -> Result<Ready> {
    let generation = util::token("g1_");
    let _: () = app
        .redis
        .clone()
        .set("krine:projection:generation", &generation)
        .await?;
    let rows = sqlx::query(
        "SELECT id,envelope->>'session_id' AS session_id,envelope->>'ip' AS ip,accepted_at,seq FROM events WHERE accepted_at >= $1 ORDER BY seq",
    )
    .bind(util::now() - 300_000)
    .fetch_all(&mut **tx)
    .await?;
    let watermark = sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(seq),0) FROM events")
        .fetch_one(&mut **tx)
        .await?;
    for batch in rows.chunks(250) {
        apply_batch(app, &generation, batch, watermark).await?;
    }
    // A different incarnation during rebuild invalidates the entire generation.
    if incarnation(app).await? != run {
        return Err(ApiError::valkey());
    }
    let _: () = app
        .redis
        .clone()
        .set("krine:projection:watermark", watermark)
        .await?;
    sqlx::query("UPDATE events SET projected=true WHERE NOT projected")
        .execute(&mut **tx)
        .await?;
    sqlx::query(
        "UPDATE projection_state SET run_id=$1,generation=$2,watermark=$3 WHERE singleton=true",
    )
    .bind(run)
    .bind(&generation)
    .bind(watermark)
    .execute(&mut **tx)
    .await?;
    Ok(Ready {
        generation,
        run_id: run.to_owned(),
        watermark,
    })
}
async fn apply_batch(
    app: &App,
    generation: &str,
    rows: &[sqlx::postgres::PgRow],
    watermark: i64,
) -> Result<()> {
    let program = redis::Script::new(PROJECT);
    let mut script = program.prepare_invoke();
    script
        .key("krine:projection:generation")
        .key("krine:projection:watermark");
    let mut entries = Vec::new();
    for row in rows {
        for kind in ["session_id", "ip"] {
            if let Some(value) = row.get::<Option<String>, _>(kind) {
                script.key(format!(
                    "krine:hot:{generation}:{kind}:{}",
                    util::digest(value)
                ));
                entries.push((row.get::<String, _>("id"), row.get::<i64, _>("accepted_at")));
            }
        }
    }
    script
        .arg(generation)
        .arg(util::now() - 300_000)
        .arg(watermark)
        .arg(COUNTER_TTL_SECONDS);
    for (id, at) in entries {
        script.arg(id).arg(at);
    }
    let result: i64 = script.invoke_async(&mut app.redis.clone()).await?;
    if result != 1 {
        return Err(ApiError::valkey());
    }
    Ok(())
}
pub async fn project(app: &App, id: &str) -> Result<()> {
    let mut tx = app.db.begin().await?;
    let ready = locked_ready(app, &mut tx).await?;
    let rows=sqlx::query("SELECT id,envelope->>'session_id' AS session_id,envelope->>'ip' AS ip,accepted_at,seq FROM events WHERE NOT projected ORDER BY seq LIMIT 1000").fetch_all(&mut *tx).await?;
    let mut watermark: i64 =
        sqlx::query_scalar("SELECT watermark FROM projection_state WHERE singleton=true")
            .fetch_one(&mut *tx)
            .await?;
    for batch in rows.chunks(250) {
        if let Some(row) = batch.last() {
            watermark = watermark.max(row.get("seq"));
        }
        apply_batch(app, &ready.generation, batch, watermark).await?;
        let ids = batch
            .iter()
            .map(|row| row.get::<String, _>("id"))
            .collect::<Vec<_>>();
        sqlx::query("UPDATE events SET projected=true WHERE id=ANY($1)")
            .bind(ids)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE projection_state SET watermark=$1 WHERE singleton=true")
        .bind(watermark)
        .execute(&mut *tx)
        .await?;
    if !id.is_empty() {
        let done: bool = sqlx::query_scalar("SELECT projected FROM events WHERE id=$1")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
        if !done {
            return Err(ApiError::valkey());
        }
    }
    tx.commit().await?;
    Ok(())
}
pub async fn ensure_ready(app: &App) -> Result<()> {
    project(app, "").await
}
pub async fn count(app: &App, ready: &Ready, kind: &str, id: &str, at: i64) -> Result<i64> {
    let value:i64=redis::Script::new("if redis.call('GET',KEYS[1]) ~= ARGV[1] then return -1 end; return redis.call('ZCOUNT',KEYS[2],ARGV[2],ARGV[3])").key("krine:projection:generation").key(format!("krine:hot:{}:{kind}:{}",ready.generation,util::digest(id))).arg(&ready.generation).arg(at-300_000).arg(at).invoke_async(&mut app.redis.clone()).await?;
    if value < 0 {
        return Err(ApiError::valkey());
    }
    Ok(value)
}

pub async fn validate(app: &App, ready: &Ready) -> Result<()> {
    let watermark: Option<String> = app.redis.clone().get("krine:projection:watermark").await?;
    let generation: Option<String> = app.redis.clone().get("krine:projection:generation").await?;
    if incarnation(app).await? != ready.run_id
        || watermark.as_deref() != Some(&ready.watermark.to_string())
        || generation.as_deref() != Some(&ready.generation)
    {
        return Err(ApiError::valkey());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires real stores and KRINE_* configuration"]
    async fn rejects_projection_rollback_between_metric_reads() {
        let app = App::connect(crate::config::Config::load().unwrap())
            .await
            .unwrap();
        let mut tx = app.db.begin().await.unwrap();
        let ready = locked_ready(&app, &mut tx).await.unwrap();
        count(&app, &ready, "ip", "127.0.0.1", util::now())
            .await
            .unwrap();
        let _: () = app
            .redis
            .clone()
            .set("krine:projection:watermark", "stale")
            .await
            .unwrap();
        assert!(validate(&app, &ready).await.is_err());
        let _: () = app
            .redis
            .clone()
            .set("krine:projection:generation", "lost")
            .await
            .unwrap();
        assert!(
            count(&app, &ready, "ip", "127.0.0.1", util::now())
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        test_ready(&app).await;
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires real stores and KRINE_* configuration"]
    async fn rebuilds_twenty_thousand_retained_events_within_worker_budget() {
        let app = App::connect(crate::config::Config::load().unwrap())
            .await
            .unwrap();
        let prefix = util::token("batch_");
        let at = util::now();
        let mut tx = app.db.begin().await.unwrap();
        sqlx::query("SELECT singleton FROM projection_state WHERE singleton=true FOR UPDATE")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("DELETE FROM events WHERE digest='test' AND left(id,6)='batch_'")
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO events(id,digest,envelope,accepted_at) SELECT $1||n::text,'test',jsonb_build_object('session_id',$1::text),$2 FROM generate_series(1,20000) n").bind(&prefix).bind(at).execute(&mut *tx).await.unwrap();
        tx.commit().await.unwrap();
        let _: () = app
            .redis
            .clone()
            .set("krine:projection:generation", "force-rebuild")
            .await
            .unwrap();
        let start = std::time::Instant::now();
        test_ready(&app).await;
        let mut tx = app.db.begin().await.unwrap();
        let ready = locked_ready(&app, &mut tx).await.unwrap();
        assert_eq!(
            count(&app, &ready, "session_id", &prefix, util::now())
                .await
                .unwrap(),
            20000
        );
        eprintln!(
            "20,000 retained event rebuild completed in {} ms",
            start.elapsed().as_millis()
        );
        sqlx::query("DELETE FROM events WHERE left(id,length($1))=$1")
            .bind(&prefix)
            .execute(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
}

#[cfg(test)]
async fn test_ready(app: &App) {
    tokio::time::timeout(std::time::Duration::from_secs(5),async {
        loop {if ensure_ready(app).await.is_ok(){break;}tokio::time::sleep(std::time::Duration::from_millis(50)).await;}
    }).await.expect("recovery finishes within the worker budget, including bounded contention with another worker");
}
