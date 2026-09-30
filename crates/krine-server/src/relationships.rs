use crate::operators::{Audit, Capability};
use crate::{
    App, admin,
    error::{ApiError, Result},
    json::StrictJson,
    util,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row, Transaction};

pub(crate) async fn lock(tx: &mut Transaction<'_, Postgres>, client: &str) -> Result<()> {
    // Order: operation/proof -> projection -> client relationships -> provider.
    // Relationship writers never acquire projection/provider locks afterwards.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("relationships:{client}"))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

pub(crate) fn detail_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id":row.get::<String,_>("id"), "kind":row.get::<String,_>("kind"),
        "client_id":row.get::<String,_>("client_id"), "session_id":row.get::<Option<String>,_>("session_id"),
        "user_id":row.get::<Option<String>,_>("user_id"), "ip":row.get::<Option<String>,_>("ip"),
        "first_seen":row.get::<i64,_>("first_seen"), "last_seen":row.get::<i64,_>("last_seen"),
        "source":row.get::<String,_>("source"), "credential_id":row.get::<Option<String>,_>("credential_id"),
        "last_credential_id":row.get::<Option<String>,_>("last_credential_id"),
        "first_source":row.get::<String,_>("first_source"), "last_source":row.get::<String,_>("last_source"),
        "first_event_id":row.get::<Option<String>,_>("first_event_id"), "last_event_id":row.get::<Option<String>,_>("last_event_id"),
        "revision":row.get::<i64,_>("revision"), "revoked_at":row.get::<Option<i64>,_>("revoked_at"),
        "revocation_reason":row.get::<Option<String>,_>("revocation_reason"), "revoked_by":row.get::<Option<String>,_>("revoked_by"),
        "metadata":row.get::<Value,_>("metadata")
    })
}
fn table(kind: &str) -> Result<&'static str> {
    match kind {
        "backend" => Ok("associations"),
        "observed_ip" => Ok("observed_ips"),
        _ => Err(ApiError::absent()),
    }
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub(crate) limit: Option<i64>,
    pub(crate) cursor: Option<String>,
}
impl Page {
    fn list(self) -> admin::List {
        admin::List {
            limit: self.limit,
            cursor: self.cursor,
            q: None,
        }
    }
}
pub async fn list(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
    query: std::result::Result<Query<Page>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(page) = query.map_err(|_| ApiError::invalid("Invalid relationship query."))?;
    let list = page.list();
    let limit = list.limit()?;
    let column = match kind.as_str() {
        "client" => "client_id",
        "session" => "session_id",
        "user" => "user_id",
        "ip" => "ip",
        _ => return Err(ApiError::absent()),
    };
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM entities WHERE kind=$1 AND id=$2)")
            .bind(&kind)
            .bind(&id)
            .fetch_one(&app.db)
            .await?;
    if !exists {
        return Err(ApiError::absent());
    }
    let mut query = QueryBuilder::<Postgres>::new(format!(
        "SELECT * FROM relationship_records WHERE {column}="
    ));
    query.push_bind(&id);
    if let Some((at, key)) = list.cursor()? {
        let (kind, id) = key
            .split_once(':')
            .ok_or_else(|| ApiError::invalid("Invalid relationship cursor."))?;
        table(kind).map_err(|_| ApiError::invalid("Invalid relationship cursor."))?;
        query
            .push(" AND (first_seen,kind,id)<(")
            .push_bind(at)
            .push(",")
            .push_bind(kind.to_owned())
            .push(",")
            .push_bind(id.to_owned())
            .push(")");
    }
    query
        .push(" ORDER BY first_seen DESC,kind DESC,id DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = query.build().fetch_all(&app.db).await?;
    let next = (rows.len() > limit as usize).then(|| {
        admin::cursor(
            rows[limit as usize - 1].get("first_seen"),
            &format!(
                "{}:{}",
                rows[limit as usize - 1].get::<String, _>("kind"),
                rows[limit as usize - 1].get::<String, _>("id")
            ),
        )
    });
    Ok(Json(
        json!({"items":rows.iter().take(limit as usize).map(detail_json).collect::<Vec<_>>(),"next_cursor":next}),
    ))
}

pub async fn detail(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
    query: std::result::Result<Query<Page>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    table(&kind)?;
    let Query(page) = query.map_err(|_| ApiError::invalid("Invalid audit query."))?;
    let list = page.list();
    let limit = list.limit()?;
    let mut tx = app.db.begin().await?;
    let client: String =
        sqlx::query_scalar("SELECT client_id FROM relationship_records WHERE kind=$1 AND id=$2")
            .bind(&kind)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::absent)?;
    lock(&mut tx, &client).await?;
    let row = sqlx::query("SELECT * FROM relationship_records WHERE kind=$1 AND id=$2")
        .bind(&kind)
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::absent)?;
    let mut query = QueryBuilder::<Postgres>::new("SELECT * FROM relationship_audit WHERE kind=");
    query
        .push_bind(&kind)
        .push(" AND relationship_id=")
        .push_bind(&id);
    if let Some((at, id)) = list.cursor()? {
        query
            .push(" AND (at,id)<(")
            .push_bind(at)
            .push(",")
            .push_bind(id)
            .push(")");
    }
    query
        .push(" ORDER BY at DESC,id DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = query.build().fetch_all(&mut *tx).await?;
    let next = (rows.len() > limit as usize).then(|| {
        admin::cursor(
            rows[limit as usize - 1].get("at"),
            rows[limit as usize - 1].get("id"),
        )
    });
    let audit=rows.iter().take(limit as usize).map(|r|json!({"id":r.get::<String,_>("id"),"at":r.get::<i64,_>("at"),"action":r.get::<String,_>("action"),"reason":r.get::<String,_>("reason"),"actor":r.get::<Option<String>,_>("actor"),"actor_identity":r.get::<Option<Value>,_>("actor_identity"),"revision":r.get::<Option<i64>,_>("revision"),"relationship":r.get::<Option<Value>,_>("relationship")})).collect::<Vec<_>>();
    tx.commit().await?;
    Ok(Json(
        json!({"relationship":detail_json(&row),"audit":{"items":audit,"next_cursor":next},"recalculation":"complete"}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Correction {
    revision: i64,
    reason: String,
}
impl Correction {
    fn validate(&self) -> Result<()> {
        if self.revision < 1
            || self.reason.is_empty()
            || self.reason.len() > 512
            || self.reason.trim() != self.reason
            || self.reason.chars().any(char::is_control)
        {
            return Err(ApiError::invalid(
                "Provide a positive revision and a reason of 1–512 bytes without control characters or surrounding whitespace.",
            ));
        }
        Ok(())
    }
}
pub async fn correct(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Correction>,
) -> Result<Json<Value>> {
    change(app, kind, id, headers, input, false).await
}
pub async fn restore(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Correction>,
) -> Result<Json<Value>> {
    change(app, kind, id, headers, input, true).await
}
async fn change(
    app: App,
    kind: String,
    id: String,
    headers: HeaderMap,
    input: Correction,
    restore: bool,
) -> Result<Json<Value>> {
    let table = table(&kind)?;
    util::identifier(&id)?;
    input.validate()?;
    let action = if restore { "restore" } else { "correct" };
    let (mut tx, receipt, replay) = admin::mutation(
        &app,
        &headers,
        &format!("relationships/{kind}/{id}/{action}"),
        &json!(input),
        Capability::Edit,
    )
    .await?;
    if let Some(value) = replay {
        return Ok(Json(value));
    }
    let client: String = sqlx::query_scalar(&format!("SELECT client_id FROM {table} WHERE id=$1"))
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::absent)?;
    lock(&mut tx, &client).await?;
    let row = sqlx::query(&format!("SELECT * FROM {table} WHERE id=$1 FOR UPDATE"))
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::absent)?;
    if row.get::<i64, _>("revision") != input.revision {
        return Err(ApiError::conflict("revision_conflict"));
    }
    if row.get::<Option<i64>, _>("revoked_at").is_some() != restore {
        return Err(ApiError::conflict("relationship_state_conflict"));
    }
    if restore && kind == "observed_ip" {
        let exists:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM observed_ips WHERE client_id=$1 AND session_id=$2 AND ip=$3 AND revoked_at IS NULL)").bind(&client).bind(row.get::<String,_>("session_id")).bind(row.get::<String,_>("ip")).fetch_one(&mut *tx).await?;
        if exists {
            return Err(ApiError::conflict("relationship_active"));
        }
    }
    let at = util::now();
    let preserve = if kind == "observed_ip" {
        ",has_corrections=true"
    } else {
        ""
    };
    sqlx::query(&format!("UPDATE {table} SET revision=revision+1,revoked_at=$2,revocation_reason=$3,revoked_by=$4{preserve} WHERE id=$1"))
        .bind(&id).bind((!restore).then_some(at)).bind((!restore).then_some(&input.reason)).bind((!restore).then_some(&receipt.actor.actor_id)).execute(&mut *tx).await?;
    let row = sqlx::query("SELECT * FROM relationship_records WHERE kind=$1 AND id=$2")
        .bind(&kind)
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    let relationship = detail_json(&row);
    let audit_id = util::token("rac_");
    sqlx::query("INSERT INTO relationship_audit(id,kind,relationship_id,at,action,reason,actor,revision,relationship,actor_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(&audit_id).bind(&kind).bind(&id).bind(at).bind(action).bind(&input.reason).bind(&receipt.actor.actor_id).bind(row.get::<i64,_>("revision")).bind(&relationship).bind(receipt.actor.identity()).execute(&mut *tx).await?;
    admin::finish(
        tx,
        receipt,
        json!({"relationship":relationship,"audit_id":audit_id,"recalculation":"complete"}),
        Audit::new(if restore {"relationship.restore"}else{"relationship.correct"},"relationship",id).reason(&input.reason).changes(json!({"kind":kind,"previous_revision":input.revision,"revision":row.get::<i64,_>("revision")})),
    )
    .await
}

const SUMMARY_COLUMNS: &str = "id,kind,client_id,session_id,user_id,ip,first_seen,last_seen,source,credential_id,last_credential_id,first_source,last_source,first_event_id,last_event_id,revision,revoked_at,revocation_reason,revoked_by,'{}'::jsonb AS metadata";

/// The count is exact; only the explanatory samples have a bounded size.
/// The caller holds the client lock through committing the decision envelope.
pub(crate) async fn snapshot(
    tx: &mut Transaction<'_, Postgres>,
    client: &str,
    session: &str,
    ip: &str,
    at: i64,
) -> Result<(i64, Value)> {
    let row=sqlx::query("SELECT COUNT(DISTINCT user_id) AS users,COUNT(*) AS total FROM associations WHERE client_id=$1 AND revoked_at IS NULL AND created_at>=$2").bind(client).bind(at-2_592_000_000).fetch_one(&mut **tx).await?;
    let total: i64 = row.get("total");
    let rows=sqlx::query(&format!("SELECT {SUMMARY_COLUMNS} FROM relationship_records WHERE kind='backend' AND client_id=$1 AND revoked_at IS NULL AND first_seen>=$2 ORDER BY first_seen DESC,id DESC LIMIT 100")).bind(client).bind(at-2_592_000_000).fetch_all(&mut **tx).await?;
    let observed=sqlx::query("SELECT * FROM relationship_records WHERE kind='observed_ip' AND client_id=$1 AND session_id=$2 AND ip=$3 AND revoked_at IS NULL").bind(client).bind(session).bind(ip).fetch_optional(&mut **tx).await?;
    Ok((
        row.get("users"),
        json!({"items":rows.iter().map(summary_json).collect::<Vec<_>>(),"total":total,"truncated":total>100,"observed_at":at,"observed_ip":observed.as_ref().map(summary_json)}),
    ))
}

fn summary_json(row: &sqlx::postgres::PgRow) -> Value {
    let mut value = detail_json(row);
    value
        .as_object_mut()
        .expect("relationship object")
        .remove("metadata");
    value
}
