use crate::{
    App,
    admin::List,
    error::{ApiError, Result},
    util,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

pub(crate) async fn clickhouse(
    app: &App,
    query: &str,
    params: Vec<(&str, String)>,
    body: Option<String>,
) -> Result<String> {
    let request = app
        .http
        .post(&app.config.clickhouse_url)
        .basic_auth(
            &app.config.clickhouse_user,
            Some(&app.config.clickhouse_password),
        )
        .query(&[("database", "krine"), ("query", query)])
        .query(&params);
    let mut response = request
        .header(
            reqwest::header::CONTENT_LENGTH,
            body.as_ref().map_or(0, String::len),
        )
        .body(body.unwrap_or_default())
        .send()
        .await
        .map_err(|_| ApiError::unavailable())?;
    if !response.status().is_success() {
        tracing::warn!(status=%response.status(), code=?response.headers().get("x-clickhouse-exception-code"), "analytical request rejected");
        return Err(ApiError::unavailable());
    }
    if response.content_length().is_some_and(|n| n > 8_388_608) {
        return Err(ApiError::unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::unavailable())?
    {
        if bytes.len() + chunk.len() > 8_388_608 {
            return Err(ApiError::unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| ApiError::unavailable())
}
pub(crate) fn table(app: &App, versioned: bool) -> String {
    let name = if versioned { "history_v2" } else { "history" };
    #[cfg(test)]
    if !app.provider_test.history_suffix.is_empty() {
        return format!("{name}_{}", app.provider_test.history_suffix);
    }
    let _ = app;
    name.into()
}
pub(crate) use crate::retention::{configure as configure_retention, current as retention};
pub(crate) async fn available_records(
    app: &App,
    ids: &[String],
    cutoff: i64,
) -> Result<Vec<String>> {
    if ids.is_empty() || ids.len() > 3 {
        return Err(ApiError::unavailable());
    }
    let keys = ["param_id0", "param_id1", "param_id2"];
    let placeholders = ["{id0:String}", "{id1:String}", "{id2:String}"];
    let mut params = ids
        .iter()
        .enumerate()
        .map(|(i, id)| (keys[i], id.clone()))
        .collect::<Vec<_>>();
    params.push(("param_cutoff", cutoff.to_string()));
    let response=clickhouse(app,&format!("SELECT id FROM {} FINAL WHERE kind IN ('event','decision') AND id IN ({}) AND at>={{cutoff:Int64}} LIMIT 3 FORMAT JSONEachRow",table(app,true),placeholders[..ids.len()].join(",")),params,None).await?;
    response
        .lines()
        .map(|line| {
            serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|row| row["id"].as_str().map(str::to_owned))
                .ok_or_else(ApiError::unavailable)
        })
        .collect()
}
pub(crate) async fn initialize(app: &App) -> Result<bool> {
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('history-v2-migration',0))")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO analytical_migrations(name) VALUES('history_v2') ON CONFLICT DO NOTHING",
    )
    .execute(&mut *tx)
    .await?;
    let migration = sqlx::query("SELECT * FROM analytical_migrations WHERE name='history_v2'")
        .fetch_one(&mut *tx)
        .await?;
    if migration.get::<bool, _>("completed") {
        return Ok(true);
    }
    let legacy = table(app, false);
    let versioned = table(app, true);
    clickhouse(app,&format!("CREATE TABLE IF NOT EXISTS {legacy} (kind LowCardinality(String), id String, at Int64, payload String) ENGINE=ReplacingMergeTree ORDER BY (kind,id)"),vec![],None).await?;
    clickhouse(app,&format!("CREATE TABLE IF NOT EXISTS {versioned} (kind LowCardinality(String), id String, at Int64, payload String, revision UInt64) ENGINE=ReplacingMergeTree(revision) ORDER BY (kind,id)"),vec![],None).await?;
    let params = vec![
        ("param_kind", migration.get::<String, _>("cursor_kind")),
        ("param_id", migration.get::<String, _>("cursor_id")),
    ];
    let rows=clickhouse(app,&format!("SELECT kind,id FROM {legacy} FINAL WHERE (kind,id)>({{kind:String}},{{id:String}}) ORDER BY kind,id LIMIT 100 FORMAT JSONEachRow"),params.clone(),None).await?;
    let last = rows
        .lines()
        .last()
        .map(serde_json::from_str::<Value>)
        .transpose()
        .map_err(|_| ApiError::unavailable())?;
    if let Some(last) = last {
        let kind = last["kind"].as_str().ok_or_else(ApiError::unavailable)?;
        let id = last["id"].as_str().ok_or_else(ApiError::unavailable)?;
        let mut params = params;
        params.extend([
            ("param_last_kind", kind.into()),
            ("param_last_id", id.into()),
        ]);
        // Checkpoint after each bounded copy. A lost acknowledgement safely
        // repeats revision one; the explicit version keeps later states newer.
        clickhouse(app,&format!("INSERT INTO {versioned} SELECT kind,id,at,payload,1 FROM {legacy} FINAL WHERE (kind,id)>({{kind:String}},{{id:String}}) AND (kind,id)<=({{last_kind:String}},{{last_id:String}})"),params,None).await?;
        sqlx::query(
            "UPDATE analytical_migrations SET cursor_kind=$1,cursor_id=$2 WHERE name='history_v2'",
        )
        .bind(kind)
        .bind(id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query("UPDATE analytical_migrations SET completed=true WHERE name='history_v2'")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(true)
}
pub async fn export(app: &App) -> Result<()> {
    if !initialize(app).await? {
        return Ok(());
    }
    // Capture complete immutable snapshots, then release the database before
    // network I/O. Newer revisions can coalesce into these slots during export.
    let rows=sqlx::query("SELECT id,logical_id,revision,kind,at,payload FROM delivery_outbox WHERE exported_at IS NULL ORDER BY at,id LIMIT 100").fetch_all(&app.db).await?;
    if rows.is_empty() {
        return cleanup(app).await;
    }
    let mut body = String::new();
    let mut ids = Vec::new();
    let mut revisions = Vec::new();
    for row in rows {
        let id: String = row.get("id");
        body.push_str(&serde_json::to_string(&json!({"id":row.get::<String,_>("logical_id"),"revision":row.get::<i64,_>("revision"),"kind":row.get::<String,_>("kind"),"at":row.get::<i64,_>("at"),"payload":row.get::<Value,_>("payload").to_string()})).map_err(|_|ApiError::unavailable())?);
        body.push('\n');
        ids.push(id);
        revisions.push(row.get::<i64, _>("revision"));
    }
    if !body.is_empty() {
        clickhouse(
            app,
            &format!("INSERT INTO {} FORMAT JSONEachRow", table(app, true)),
            vec![],
            Some(body),
        )
        .await?;
    }
    #[cfg(test)]
    if let Some(pause) = &app.provider_test.after_export {
        pause.arrived.notify_one();
        pause.resume.notified().await;
    }
    acknowledge(app, &ids, &revisions).await?;
    cleanup(app).await
}
async fn acknowledge(app: &App, ids: &[String], revisions: &[i64]) -> Result<()> {
    // An acknowledgement for revision N cannot erase pending revision N+1.
    sqlx::query("UPDATE delivery_outbox d SET exported_at=$1 FROM unnest($2::text[],$3::bigint[]) AS delivered(id,revision) WHERE d.id=delivered.id AND d.revision=delivered.revision")
        .bind(util::now()).bind(ids).bind(revisions).execute(&app.db).await?;
    Ok(())
}
async fn cleanup(app: &App) -> Result<()> {
    let cutoff = util::now() - 172_800_000;
    // Never remove unexported envelopes. Retry guards outlive their supported
    // windows; analytical retention belongs to ClickHouse rather than PG.
    let mut tx = app.db.begin().await?;
    sqlx::query("DELETE FROM events e WHERE accepted_at<$1 AND projected AND EXISTS(SELECT 1 FROM delivery_outbox o WHERE o.id='event:'||e.id AND o.exported_at IS NOT NULL)").bind(cutoff).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM operations o WHERE accepted_at<$1 AND state='final' AND response IS NOT NULL AND EXISTS(SELECT 1 FROM delivery_outbox b WHERE COALESCE(b.logical_id,b.id)='decision:'||(o.response->>'decision_id') AND b.revision=o.history_revision AND b.exported_at IS NOT NULL)").bind(cutoff).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM operations WHERE accepted_at<$1 AND response IS NULL")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM delivery_outbox WHERE at<$1 AND exported_at IS NOT NULL")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM provider_revisions r WHERE created_at<$1 AND NOT EXISTS(SELECT 1 FROM provider_current c WHERE c.capability=r.capability AND c.revision=r.revision) AND NOT EXISTS(SELECT 1 FROM operations o WHERE o.state<>'final' AND (o.envelope->'provider_revisions'->r.capability->>'revision')::bigint=r.revision)")
        .bind(util::now()-2_592_000_000_i64).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM provider_tests WHERE expires_at<$1")
        .bind(util::now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_mutations WHERE created_at<$1")
        .bind(cutoff)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM admin_sessions WHERE expires_at<$1")
        .bind(util::now())
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM observed_ips WHERE last_seen<$1 AND NOT has_corrections")
        .bind(util::now() - 2_592_000_000_i64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filters {
    limit: Option<i64>,
    cursor: Option<String>,
    check: Option<String>,
    operation_id: Option<String>,
    outcome: Option<String>,
    entity: Option<String>,
    entity_kind: Option<String>,
    name: Option<String>,
    from: Option<i64>,
    to: Option<i64>,
}
const DECISION_SUMMARY_FIELDS: &[&str] = &[
    "decision_id",
    "operation_id",
    "check",
    "policy_version",
    "outcome",
    "reason",
    "accepted_at",
    "completed_at",
    "client_id",
    "session_id",
    "user_id",
    "ip",
    "source",
    "reason_summary",
];

async fn list(
    app: &App,
    kind: &str,
    f: Filters,
    entity_field: Option<&'static str>,
) -> Result<Json<Value>> {
    let entity_field = match f.entity_kind.as_deref() {
        Some(kind) => {
            if f.entity.as_ref().is_none_or(String::is_empty) {
                return Err(ApiError::invalid(
                    "entity_kind requires an entity identifier.",
                ));
            }
            Some(match kind {
                "client" => "client_id",
                "session" => "session_id",
                "user" => "user_id",
                "ip" => "ip",
                _ => return Err(ApiError::invalid("Invalid entity kind.")),
            })
        }
        None => entity_field,
    };
    let scope = util::digest(
        serde_json::to_vec(&json!({"kind":kind,"check":f.check,"operation_id":f.operation_id,"outcome":f.outcome,"entity":f.entity,"entity_field":entity_field,"name":f.name,"from":f.from,"to":f.to})).map_err(|_| ApiError::unavailable())?,
    );
    let after = history_cursor(f.cursor.as_deref(), &scope, f.entity_kind.is_none())?;
    let limit = List {
        limit: f.limit,
        ..Default::default()
    }
    .limit()?;
    for value in [&f.check, &f.operation_id, &f.outcome, &f.entity, &f.name]
        .into_iter()
        .flatten()
    {
        if value.len() > 256 {
            return Err(ApiError::invalid("Activity filter is too long."));
        }
    }
    if f.from.zip(f.to).is_some_and(|(from, to)| from > to) {
        return Err(ApiError::invalid("Invalid time range."));
    }
    let mut query = "SELECT at,id".to_owned();
    if kind == "decision" {
        // Large policy traces belong only in the detail response. Extract raw
        // scalar JSON so nullable IDs and numeric fields keep their wire types.
        for field in DECISION_SUMMARY_FIELDS {
            if *field == "reason_summary" {
                query.push_str(",if(length(JSONExtractRaw(payload,'reason_summary')) BETWEEN 1 AND 8192,JSONExtractRaw(payload,'reason_summary'),'null') AS summary_reason_summary");
            } else {
                query.push_str(&format!(
                    ",JSONExtractRaw(payload,'{field}') AS summary_{field}"
                ));
            }
        }
    } else {
        query.push_str(",payload");
    }
    query.push_str(&format!(
        " FROM {} FINAL WHERE kind={{kind:String}}",
        table(app, true)
    ));
    let retention = retention(app).await?;
    query.push_str(" AND at>={retention_cutoff:Int64}");
    let mut params = vec![
        ("param_retention_cutoff", retention.cutoff.to_string()),
        ("param_kind", kind.to_owned()),
        ("param_limit", (limit + 1).to_string()),
    ];
    for (field, key, value) in [
        ("check", "param_check", f.check),
        ("operation_id", "param_operation_id", f.operation_id),
        ("outcome", "param_outcome", f.outcome),
        ("name", "param_name", f.name),
    ] {
        if let Some(value) = value {
            query.push_str(&format!(
                " AND JSONExtractString(payload,'{field}')={{{}:String}}",
                key.trim_start_matches("param_")
            ));
            params.push((key, value));
        }
    }
    if let Some(entity) = f.entity {
        if let Some(field) = entity_field {
            query.push_str(&format!(
                " AND JSONExtractString(payload,'{field}')={{entity:String}}"
            ));
        } else {
            query.push_str(" AND (JSONExtractString(payload,'client_id')={entity:String} OR JSONExtractString(payload,'session_id')={entity:String} OR JSONExtractString(payload,'user_id')={entity:String} OR JSONExtractString(payload,'ip')={entity:String})");
        }
        params.push(("param_entity", entity));
    }
    if let Some(from) = f.from {
        query.push_str(" AND at>={from:Int64}");
        params.push(("param_from", from.to_string()));
    }
    if let Some(to) = f.to {
        query.push_str(" AND at<={to:Int64}");
        params.push(("param_to", to.to_string()));
    }
    if let Some((at, id)) = after {
        query.push_str(" AND (at,id)<({cursor_at:Int64},{cursor_id:String})");
        params.push(("param_cursor_at", at.to_string()));
        params.push(("param_cursor_id", id));
    }
    query.push_str(" ORDER BY at DESC,id DESC LIMIT {limit:UInt32} FORMAT JSONEachRow");
    let response = clickhouse(app, &query, params, None).await?;
    let mut rows = Vec::new();
    for line in response.lines() {
        rows.push(serde_json::from_str::<Value>(line).map_err(|_| ApiError::unavailable())?);
    }
    let next = if rows.len() > limit as usize {
        let row = &rows[limit as usize - 1];
        let at = parse_i64(&row["at"])?;
        Some(
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&(
                    at,
                    row["id"].as_str().ok_or_else(ApiError::unavailable)?,
                    &scope,
                ))
                .map_err(|_| ApiError::unavailable())?,
            ),
        )
    } else {
        None
    };
    let items = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| {
            if kind == "decision" {
                return summary(&row);
            }
            let payload =
                serde_json::from_str(row["payload"].as_str().ok_or_else(ApiError::unavailable)?)
                    .map_err(|_| ApiError::unavailable())?;
            Ok(payload)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"next_cursor":next,"retention":retention.description()}),
    ))
}
fn history_cursor(value: Option<&str>, scope: &str, legacy: bool) -> Result<Option<(i64, String)>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.len() > 1024 {
        return Err(ApiError::invalid("Invalid cursor."));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| ApiError::invalid("Invalid cursor."))?;
    if let Ok((at, id, bound)) = serde_json::from_slice::<(i64, String, String)>(&decoded) {
        if bound != scope || at < 0 || id.len() > 256 {
            return Err(ApiError::invalid(
                "The cursor does not match these Activity filters.",
            ));
        }
        return Ok(Some((at, id)));
    }
    if legacy {
        return List {
            cursor: Some(value.to_owned()),
            ..Default::default()
        }
        .cursor();
    }
    Err(ApiError::invalid("Invalid scoped Activity cursor."))
}
fn parse_i64(value: &Value) -> Result<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .ok_or_else(ApiError::unavailable)
}
fn summary(row: &Value) -> Result<Value> {
    let mut result = serde_json::Map::new();
    for field in DECISION_SUMMARY_FIELDS {
        let raw = row[format!("summary_{field}")]
            .as_str()
            .ok_or_else(ApiError::unavailable)?;
        let value = serde_json::from_str(raw).map_err(|_| ApiError::unavailable())?;
        result.insert((*field).into(), value);
    }
    Ok(Value::Object(result))
}
pub async fn events(
    State(app): State<App>,
    query: std::result::Result<Query<Filters>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(f) = query.map_err(|_| ApiError::invalid("Invalid activity query."))?;
    list(&app, "event", f, None).await
}
pub async fn decisions(
    State(app): State<App>,
    query: std::result::Result<Query<Filters>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(f) = query.map_err(|_| ApiError::invalid("Invalid activity query."))?;
    list(&app, "decision", f, None).await
}
async fn get(app: &App, kind: &str, id: &str) -> Result<Json<Value>> {
    let retention = retention(app).await?;
    let pending: Option<Value> = sqlx::query_scalar("SELECT payload FROM delivery_outbox WHERE COALESCE(logical_id,id)=$1 AND at>=$2 ORDER BY revision DESC LIMIT 1")
        .bind(format!("{kind}:{id}")).bind(retention.cutoff)
        .fetch_optional(&app.db)
        .await?;
    if let Some(value) = pending {
        return Ok(Json(value));
    }
    let response=clickhouse(app,&format!("SELECT payload FROM {} FINAL WHERE kind={{kind:String}} AND id={{id:String}} AND at>={{cutoff:Int64}} LIMIT 1 FORMAT JSONEachRow",table(app,true)),vec![("param_kind",kind.into()),("param_id",format!("{kind}:{id}")),("param_cutoff",retention.cutoff.to_string())],None).await?;
    let row: Value = serde_json::from_str(response.trim()).map_err(|_| ApiError::absent())?;
    Ok(Json(
        serde_json::from_str(row["payload"].as_str().ok_or_else(ApiError::unavailable)?)
            .map_err(|_| ApiError::unavailable())?,
    ))
}
pub async fn event(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    get(&app, "event", &id).await
}
pub async fn decision(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    get(&app, "decision", &id).await
}

pub async fn recent(app: &App, kind: &str, entity_kind: &str, entity: &str) -> Result<Value> {
    let field = match entity_kind {
        "client" => "client_id",
        "session" => "session_id",
        "user" => "user_id",
        "ip" => "ip",
        _ => return Err(ApiError::absent()),
    };
    Ok(list(
        app,
        kind,
        Filters {
            limit: Some(20),
            entity: Some(entity.into()),
            ..Default::default()
        },
        Some(field),
    )
    .await?
    .0["items"]
        .clone())
}
