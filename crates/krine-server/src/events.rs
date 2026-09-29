use crate::{
    App, ApplicationCredential,
    error::{ApiError, Result},
    json::StrictJson,
    projection, relationships, util,
};
use axum::{Extension, Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
fn empty_object() -> Value {
    json!({})
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub event_id: String,
    pub name: String,
    pub occurred_at: Option<i64>,
    pub user_id: Option<String>,
    pub client_id: Option<String>,
    pub session_id: Option<String>,
    pub ip: Option<String>,
    #[serde(default = "empty_object")]
    pub properties: Value,
}
impl Event {
    fn validate(&mut self) -> Result<()> {
        util::identifier(&self.event_id)?;
        util::identifier(&self.name)?;
        if let Some(v) = &self.user_id {
            util::user_identifier(v)?;
        }
        for v in [&self.client_id, &self.session_id].into_iter().flatten() {
            util::identifier(v)?;
        }
        if let Some(ip) = &mut self.ip {
            *ip = util::ip(ip)?.to_string();
        }
        if self.user_id.is_none() && self.client_id.is_none() && self.ip.is_none() {
            return Err(ApiError::invalid("An event requires an entity."));
        }
        if self.session_id.is_some() && self.client_id.is_none() {
            return Err(ApiError::invalid("A session requires its matching client."));
        }
        if self
            .occurred_at
            .is_some_and(|t| t < 0 || t > util::now() + 300_000)
        {
            return Err(ApiError::invalid("Invalid event occurrence timestamp."));
        }
        util::object_limit(&self.properties)
    }
}
pub async fn entity_exists(
    tx: &mut Transaction<'_, Postgres>,
    client: &str,
    session: Option<&str>,
) -> Result<()> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM entities WHERE kind='client' AND id=$1)")
            .bind(client)
            .fetch_one(&mut **tx)
            .await?;
    if !exists {
        return Err(ApiError::invalid("Unknown client identifier."));
    }
    if let Some(session) = session {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM entities WHERE kind='session' AND id=$1 AND client_id=$2)",
        )
        .bind(session)
        .bind(client)
        .fetch_one(&mut **tx)
        .await?;
        if !exists {
            return Err(ApiError::invalid(
                "The session does not belong to this client.",
            ));
        }
    }
    Ok(())
}
pub async fn capacity(app: &App, tx: &mut Transaction<'_, Postgres>) -> Result<()> {
    // An unfinished attempt keeps one delivery slot reserved even after export.
    // Its next transition or final result replaces that slot instead of growing
    // the queue while admission is already at capacity.
    let pending: i64 = sqlx::query_scalar("SELECT (SELECT COUNT(*) FROM delivery_outbox WHERE exported_at IS NULL) + (SELECT COUNT(*) FROM operations o WHERE state<>'final' AND NOT EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.logical_id='decision:'||(o.envelope->>'decision_id') AND d.exported_at IS NULL))")
        .fetch_one(&mut **tx)
        .await?;
    if pending >= app.config.max_pending_outbox {
        return Err(ApiError::unavailable());
    }
    Ok(())
}
pub async fn outbox(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    kind: &str,
    at: i64,
    payload: &Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO delivery_outbox(id,logical_id,kind,at,payload) VALUES($1,$1,$2,$3,$4) ON CONFLICT DO NOTHING",
    )
    .bind(format!("{kind}:{id}"))
    .bind(kind)
    .bind(at)
    .bind(payload)
    .execute(&mut **tx)
    .await?;
    Ok(())
}
pub async fn ingest(
    State(app): State<App>,
    StrictJson(mut input): StrictJson<Event>,
) -> Result<Json<Value>> {
    input.validate()?;
    let envelope = serde_json::to_value(&input).map_err(|_| ApiError::invalid("Invalid event."))?;
    let digest = util::canonical_digest(&envelope);
    let mut tx = app.db.begin().await?;
    // Claims share the projection lock so a rebuilding generation has a closed
    // set of accepted envelopes and cannot skip a concurrent acceptance.
    sqlx::query("SELECT singleton FROM projection_state WHERE singleton=true FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let existing = sqlx::query("SELECT digest,accepted_at FROM events WHERE id=$1")
        .bind(&input.event_id)
        .fetch_optional(&mut *tx)
        .await?;
    let duplicate = existing.is_some();
    let accepted_at = if let Some(row) = existing {
        if row.get::<String, _>("digest") != digest {
            return Err(ApiError::conflict("input_conflict"));
        }
        let accepted: i64 = row.get("accepted_at");
        if util::now() > accepted + 86_400_000 {
            return Err(ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "event_expired",
                "The event retry window has expired.",
            ));
        }
        accepted
    } else {
        if let Some(client) = &input.client_id {
            entity_exists(&mut tx, client, input.session_id.as_deref()).await?;
        }
        capacity(&app, &mut tx).await?;
        let accepted = util::now();
        sqlx::query("INSERT INTO events(id,digest,envelope,accepted_at) VALUES($1,$2,$3,$4)")
            .bind(&input.event_id)
            .bind(&digest)
            .bind(&envelope)
            .bind(accepted)
            .execute(&mut *tx)
            .await?;
        for (kind, id) in [("user", &input.user_id), ("ip", &input.ip)] {
            if let Some(id) = id {
                sqlx::query("INSERT INTO entities(kind,id,first_seen) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(kind).bind(id).bind(accepted).execute(&mut *tx).await?;
            }
        }
        let mut payload = envelope.clone();
        payload["accepted_at"] = json!(accepted);
        payload["provenance"] = json!("backend");
        outbox(&mut tx, &input.event_id, "event", accepted, &payload).await?;
        crate::connection::observe(&mut tx, "backend_event", "", &input.event_id, accepted).await?;
        accepted
    };
    tx.commit().await?;
    projection::project(&app, &input.event_id).await?;
    Ok(Json(
        json!({"event_id":input.event_id,"accepted_at":accepted_at,"duplicate":duplicate}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Association {
    association_id: String,
    client_id: String,
    user_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default = "empty_object")]
    metadata: Value,
}
pub async fn associate(
    State(app): State<App>,
    Extension(credential): Extension<ApplicationCredential>,
    StrictJson(input): StrictJson<Association>,
) -> Result<Json<Value>> {
    util::identifier(&input.association_id)?;
    util::identifier(&input.client_id)?;
    util::user_identifier(&input.user_id)?;
    if let Some(session) = &input.session_id {
        util::identifier(session)?;
    }
    util::object_limit(&input.metadata)?;
    let digest = util::canonical_digest(
        &serde_json::to_value(&input).map_err(|_| ApiError::invalid("Invalid association."))?,
    );
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("association:{}", input.association_id))
        .execute(&mut *tx)
        .await?;
    relationships::lock(&mut tx, &input.client_id).await?;
    let existing = sqlx::query("SELECT * FROM associations WHERE id=$1")
        .bind(&input.association_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(row) = existing {
        if row.get::<String, _>("digest") != digest {
            return Err(ApiError::conflict("input_conflict"));
        }
        if util::now() > row.get::<i64, _>("created_at") + 86_400_000 {
            return Err(ApiError::invalid(
                "The association retry window has expired.",
            ));
        }
        return Ok(Json(association_json(&row)));
    }
    entity_exists(&mut tx, &input.client_id, input.session_id.as_deref()).await?;
    let at = util::now();
    sqlx::query("INSERT INTO entities(kind,id,first_seen,metadata) VALUES('user',$1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET metadata=EXCLUDED.metadata").bind(&input.user_id).bind(at).bind(&input.metadata).execute(&mut *tx).await?;
    let row=sqlx::query("INSERT INTO associations(id,digest,client_id,user_id,metadata,created_at,session_id,credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *").bind(&input.association_id).bind(digest).bind(&input.client_id).bind(&input.user_id).bind(&input.metadata).bind(at).bind(&input.session_id).bind(&credential.id).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(association_json(&row)))
}
pub fn association_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({"association_id":row.get::<String,_>("id"),"client_id":row.get::<String,_>("client_id"),"user_id":row.get::<String,_>("user_id"),"metadata":row.get::<Value,_>("metadata"),"created_at":row.get::<i64,_>("created_at"),"revoked_at":row.get::<Option<i64>,_>("revoked_at"),"provenance":"backend","session_id":row.get::<Option<String>,_>("session_id"),"credential_id":row.get::<Option<String>,_>("credential_id"),"revision":row.get::<i64,_>("revision"),"revocation_reason":row.get::<Option<String>,_>("revocation_reason"),"revoked_by":row.get::<Option<String>,_>("revoked_by")})
}
