use crate::{
    App, credentials,
    error::{ApiError, Result},
    history, util,
};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};

pub(crate) async fn observe(
    tx: &mut Transaction<'_, Postgres>,
    kind: &str,
    check: &str,
    id: &str,
    at: i64,
) -> Result<()> {
    // The first transaction claiming a receipt commits it with the actual fact.
    // Retries and later traffic cannot manufacture another first receipt.
    sqlx::query("INSERT INTO application_observations(kind,check_name,record_id,received_at,basis) VALUES($1,$2,$3,$4,'tracked') ON CONFLICT DO NOTHING")
        .bind(kind).bind(check).bind(id).bind(at).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetupQuery {
    check: Option<String>,
}
pub async fn setup(
    State(app): State<App>,
    query: std::result::Result<Query<SetupQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid connection query."))?;
    if let Some(check) = &query.check {
        util::identifier(check)?;
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM checks WHERE name=$1)")
            .bind(check)
            .fetch_one(&app.db)
            .await?;
        if !exists {
            return Err(ApiError::absent());
        }
    }
    let mut result = credentials::setup(&app).await?;
    let retention = history::retention(&app).await?;
    let tracked_since: i64 = sqlx::query_scalar(
        "SELECT tracked_since FROM application_observation_state WHERE singleton",
    )
    .fetch_one(&app.db)
    .await?;
    let rows=sqlx::query("SELECT o.*,EXISTS(SELECT 1 FROM delivery_outbox d WHERE d.logical_id=(CASE WHEN o.kind='check_attempt' THEN 'decision:' ELSE 'event:' END)||o.record_id) AS stored,EXISTS(SELECT 1 FROM operations p WHERE o.kind='check_attempt' AND p.envelope->>'decision_id'=o.record_id AND p.response IS NULL) AS awaiting_evaluation FROM application_observations o WHERE (kind IN ('client_evidence','backend_event') AND check_name='') OR (kind='check_attempt' AND check_name=$1)")
        .bind(query.check.as_deref().unwrap_or("")).fetch_all(&app.db).await?;
    let missing = rows
        .iter()
        .filter(|row| {
            row.get::<i64, _>("received_at") >= retention.cutoff
                && !row.get::<bool, _>("stored")
                && !row.get::<bool, _>("awaiting_evaluation")
        })
        .map(|row| {
            format!(
                "{}:{}",
                if row.get::<String, _>("kind") == "check_attempt" {
                    "decision"
                } else {
                    "event"
                },
                row.get::<String, _>("record_id")
            )
        })
        .collect::<Vec<_>>();
    let available = if missing.is_empty() {
        Ok(Vec::new())
    } else {
        history::available_records(&app, &missing, retention.cutoff).await
    };
    let mut observations = json!({"tracked_since":tracked_since,"check":query.check,"client_evidence":null,"backend_event":null,"check_attempt":null});
    for row in rows {
        let kind: String = row.get("kind");
        let record_kind = if kind == "check_attempt" {
            "decision"
        } else {
            "event"
        };
        let id: String = row.get("record_id");
        let at: i64 = row.get("received_at");
        let availability = if at < retention.cutoff {
            "not_retained"
        } else if row.get::<bool, _>("stored") {
            "available"
        } else if row.get::<bool, _>("awaiting_evaluation") {
            "pending"
        } else {
            match &available {
                Ok(ids) if ids.contains(&format!("{record_kind}:{id}")) => "available",
                Ok(_) => "not_retained",
                Err(_) => "unavailable",
            }
        };
        observations[&kind] = json!({"received_at":at,"basis":row.get::<String,_>("basis"),"record":{"kind":record_kind,"id":id,"availability":availability}});
    }
    result["observations"] = observations;
    result["history_retention"] = retention.description();
    result["history_retention"]["visibility"] = json!("asynchronous");
    Ok(Json(result))
}
