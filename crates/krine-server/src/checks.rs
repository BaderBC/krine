use crate::{
    App,
    browser::Proof,
    error::{ApiError, Result},
    events,
    json::StrictJson,
    projection, util,
};
use axum::{Json, extract::State};
use krine_core::{
    METRICS, MetricObservation, Observation, Policy, Provenance, Scalar, Snapshot, UnknownReason,
    ValidatedPolicy, derive_metrics,
};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::collections::BTreeMap;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Verification {
    challenge_id: String,
    token: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    operation_id: String,
    check: String,
    proof: String,
    ip: String,
    user_id: Option<String>,
    #[serde(default)]
    inputs: BTreeMap<String, Scalar>,
    verification: Option<Verification>,
}
pub async fn evaluate(
    State(app): State<App>,
    StrictJson(mut input): StrictJson<CheckRequest>,
) -> Result<Json<Value>> {
    util::identifier(&input.operation_id)?;
    util::identifier(&input.check)?;
    if input.proof.is_empty() || input.proof.len() > 128 {
        return Err(invalid_proof());
    }
    input.ip = util::ip(&input.ip)?.to_string();
    if let Some(user) = &input.user_id {
        util::user_identifier(user)?;
    }
    if let Some(v) = &input.verification {
        util::identifier(&v.challenge_id)?;
        if v.token.is_empty() || v.token.len() > 2048 {
            return Err(ApiError::invalid("Invalid verification token."));
        }
    }
    let proof_digest = util::digest(&input.proof);
    let digest = util::canonical_digest(
        &json!({"check":input.check,"proof_digest":proof_digest,"ip":input.ip,"user_id":input.user_id,"inputs":input.inputs}),
    );
    let mut tx = app.db.begin().await?;
    operation_lock(&mut tx, &input.operation_id).await?;
    let existing =
        sqlx::query("SELECT digest,retry_until,response,envelope FROM operations WHERE id=$1")
            .bind(&input.operation_id)
            .fetch_optional(&mut *tx)
            .await?;
    let envelope = if let Some(row) = existing {
        if row.get::<String, _>("digest") != digest {
            return Err(ApiError::conflict("input_conflict"));
        }
        if util::now() > row.get::<i64, _>("retry_until") {
            return Err(ApiError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                "operation_expired",
                "The operation retry window has expired.",
            ));
        }
        if let Some(response) = row.get::<Option<Value>, _>("response") {
            return Ok(Json(response));
        }
        row.get::<Value, _>("envelope")
    } else {
        if input.verification.is_some() {
            return Err(ApiError::invalid(
                "Verification requires an existing pending challenge.",
            ));
        }
        let proof_lock: bool =
            sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
                .bind(format!("proof:{proof_digest}"))
                .fetch_one(&mut *tx)
                .await?;
        if !proof_lock {
            return Err(ApiError::conflict("proof_used"));
        }
        let used: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operations WHERE proof_digest=$1)")
                .bind(&proof_digest)
                .fetch_one(&mut *tx)
                .await?;
        if used {
            return Err(ApiError::conflict("proof_used"));
        }
        let encoded: Option<String> = app
            .redis
            .clone()
            .get(format!("krine:proof:{proof_digest}"))
            .await?;
        let proof: Proof = serde_json::from_str(&encoded.ok_or_else(invalid_proof)?)
            .map_err(|_| ApiError::unavailable())?;
        let now = util::now();
        if proof.expires_at <= now || proof.check != input.check || proof.ip != input.ip {
            return Err(invalid_proof());
        }
        let published=sqlx::query("SELECT p.policy,p.version FROM checks c JOIN policy_versions p ON p.check_name=c.name AND p.version=c.active_version WHERE c.name=$1").bind(&input.check).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::absent)?;
        let policy: Policy =
            serde_json::from_value(published.get("policy")).map_err(|_| ApiError::unavailable())?;
        let validated = ValidatedPolicy::try_from(policy.clone())?;
        validated.validate_inputs(&input.inputs)?;
        let (snapshot, relationships, now) = snapshot(&app, &mut tx, &proof, &input).await?;
        if proof.expires_at <= now {
            return Err(invalid_proof());
        }
        events::capacity(&app, &mut tx).await?;
        let envelope = json!({"decision_id":util::token("dec_"),"operation_id":input.operation_id,"check":input.check,"policy_version":published.get::<i64,_>("version"),"accepted_at":now,"retry_until":now+86_400_000,"client_id":proof.client_id,"session_id":proof.session_id,"user_id":input.user_id,"ip":input.ip,"policy":policy,"snapshot":snapshot,"relationship_ids":relationships,"provider_revisions":{}});
        sqlx::query("INSERT INTO operations(id,digest,proof_digest,accepted_at,retry_until,envelope) VALUES($1,$2,$3,$4,$5,$6)").bind(&input.operation_id).bind(digest).bind(proof_digest).bind(now).bind(now+86_400_000).bind(&envelope).execute(&mut *tx).await?;
        envelope
    };
    // Commit ownership and all evidence before evaluation. If cancellation or a
    // crash follows, an exact retry resumes this envelope without a fresh proof.
    tx.commit().await?;
    finalize(&app, &input.operation_id, envelope)
        .await
        .map(Json)
}
async fn operation_lock(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<()> {
    let locked: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("operation:{id}"))
            .fetch_one(&mut **tx)
            .await?;
    if !locked {
        return Err(ApiError::conflict("operation_in_progress"));
    }
    Ok(())
}
fn invalid_proof() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_proof",
        "The proof is invalid, expired, or bound to another action or IP.",
    )
}
async fn snapshot(
    app: &App,
    tx: &mut Transaction<'_, Postgres>,
    proof: &Proof,
    input: &CheckRequest,
) -> Result<(Snapshot, Vec<String>, i64)> {
    // Capture the evaluation time only after coordinated projection recovery.
    // Earlier request timestamps can refer to an event window already pruned.
    let ready = match projection::locked_ready(app, tx).await {
        Ok(ready) => Some(ready),
        Err(error) if error.dependency == Some("valkey") => None,
        Err(error) => return Err(error),
    };
    let snapshot_started = std::time::Instant::now();
    let at = util::now();
    let mut snapshot = Snapshot {
        inputs: input.inputs.clone(),
        ..Snapshot::default()
    };
    for definition in METRICS {
        snapshot.metrics.insert(
            definition.name.into(),
            MetricObservation {
                version: definition.version,
                state: Observation::unknown(UnknownReason::Missing),
                provenance: Provenance {
                    source: definition.source.into(),
                    observed_at: at as u64,
                },
            },
        );
    }
    let client_first: i64 =
        sqlx::query_scalar("SELECT first_seen FROM entities WHERE kind='client' AND id=$1")
            .bind(&proof.client_id)
            .fetch_one(&mut **tx)
            .await?;
    known(
        &mut snapshot,
        "client.age_seconds",
        Scalar::Number(((at - client_first).max(0) / 1000) as f64),
    );
    known(
        &mut snapshot,
        "session.age_seconds",
        Scalar::Number(((at - proof.session_issued_at).clamp(0, 86_400_000) / 1000) as f64),
    );
    if let Some(automation) = proof.signals.webdriver {
        known(
            &mut snapshot,
            "browser.automation_observed",
            Scalar::Boolean(automation),
        );
    }
    let relationships=sqlx::query("SELECT id,user_id FROM associations WHERE client_id=$1 AND revoked_at IS NULL AND created_at>=$2 ORDER BY id").bind(&proof.client_id).bind(at-2_592_000_000).fetch_all(&mut **tx).await?;
    let users = relationships
        .iter()
        .map(|r| r.get::<String, _>("user_id"))
        .collect::<std::collections::BTreeSet<_>>();
    known(
        &mut snapshot,
        "client.user_count_30d",
        Scalar::Number(users.len() as f64),
    );
    for (metric, kind, id) in [
        (
            "session.event_count_5m",
            "session_id",
            proof.session_id.as_str(),
        ),
        ("ip.event_count_5m", "ip", input.ip.as_str()),
    ] {
        match match &ready {
            Some(ready) => projection::count(app, ready, kind, id, at).await,
            None => Err(ApiError::valkey()),
        } {
            Ok(n) => known(&mut snapshot, metric, Scalar::Number(n as f64)),
            Err(_) => {
                if let Some(value) = snapshot.metrics.get_mut(metric) {
                    value.state = Observation::unknown(UnknownReason::Unavailable);
                }
            }
        }
    }
    let projection_valid = match &ready {
        Some(ready) => projection::validate(app, ready).await.is_ok(),
        None => false,
    };
    if snapshot_started.elapsed()
        > std::time::Duration::from_millis(projection::SNAPSHOT_BUDGET_MS as u64)
        || !projection_valid
    {
        for name in ["session.event_count_5m", "ip.event_count_5m"] {
            if let Some(value) = snapshot.metrics.get_mut(name) {
                value.state = Observation::unknown(UnknownReason::Unavailable);
            }
        }
    }
    derive_metrics(&mut snapshot, at as u64);
    Ok((
        snapshot,
        relationships.into_iter().map(|r| r.get("id")).collect(),
        at,
    ))
}
fn known(snapshot: &mut Snapshot, name: &str, value: Scalar) {
    if let Some(metric) = snapshot.metrics.get_mut(name) {
        metric.state = Observation::Known { value };
    }
}
async fn finalize(app: &App, id: &str, envelope: Value) -> Result<Value> {
    let policy = ValidatedPolicy::try_from(
        serde_json::from_value::<Policy>(envelope["policy"].clone())
            .map_err(|_| ApiError::unavailable())?,
    )?;
    let snapshot: Snapshot = serde_json::from_value(envelope["snapshot"].clone())
        .map_err(|_| ApiError::unavailable())?;
    let evaluation = krine_core::evaluate(&policy, &snapshot, &BTreeMap::new())?;
    if evaluation.outcome == krine_core::Outcome::ChallengeRequired {
        return Err(ApiError::unavailable());
    }
    let response = json!({"operation_id":id,"decision_id":envelope["decision_id"],"source":"evaluation","outcome":evaluation.outcome,"check":envelope["check"],"policy_version":envelope["policy_version"],"accepted_at":envelope["accepted_at"],"retry_until":envelope["retry_until"],"reason":evaluation.reason});
    let mut detail = envelope.clone();
    for (key, value) in response.as_object().ok_or_else(ApiError::unavailable)? {
        detail[key] = value.clone();
    }
    detail["completed_at"] = json!(util::now());
    detail["evaluation"] = serde_json::to_value(evaluation).map_err(|_| ApiError::unavailable())?;
    detail["requests"] =
        json!([{"at":envelope["accepted_at"],"kind":"initial","result":response["outcome"]}]);
    let mut tx = app.db.begin().await?;
    operation_lock(&mut tx, id).await?;
    let existing: Option<Value> =
        sqlx::query_scalar("SELECT response FROM operations WHERE id=$1 FOR UPDATE")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    if let Some(response) = existing {
        return Ok(response);
    }
    sqlx::query("UPDATE operations SET response=$1,detail=$2 WHERE id=$3")
        .bind(&response)
        .bind(&detail)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    events::outbox(
        &mut tx,
        detail["decision_id"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?,
        "decision",
        envelope["accepted_at"]
            .as_i64()
            .ok_or_else(ApiError::unavailable)?,
        &detail,
    )
    .await?;
    tx.commit().await?;
    Ok(response)
}
