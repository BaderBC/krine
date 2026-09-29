use crate::{
    App,
    browser::Proof,
    error::{ApiError, Result},
    events,
    json::StrictJson,
    projection, provider_http, providers, relationships, util,
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
        if v.token.is_empty()
            || v.token.len() > 2048
            || !v.token.bytes().all(|b| b.is_ascii_graphic())
        {
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
    if let Some(row) = existing {
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
        if let Some(response) = row.get::<Option<Value>, _>("response")
            && response["outcome"] != "CHALLENGE_REQUIRED"
        {
            return Ok(Json(response));
        }
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
        let provider_revisions = providers::pin(&mut tx, &policy).await?;
        let envelope = json!({"hostname":proof.hostname,"decision_id":util::token("dec_"),"operation_id":input.operation_id,"check":input.check,"policy_version":published.get::<i64,_>("version"),"accepted_at":now,"retry_until":now+86_400_000,"client_id":proof.client_id,"session_id":proof.session_id,"user_id":input.user_id,"ip":input.ip,"policy":policy,"snapshot":snapshot,"relationship_ids":relationships["items"].as_array().map(|items| items.iter().map(|item|item["id"].clone()).collect::<Vec<_>>()).unwrap_or_default(),"relationship_context":relationships,"provider_revisions":provider_revisions});
        sqlx::query("INSERT INTO operations(id,digest,proof_digest,accepted_at,retry_until,envelope) VALUES($1,$2,$3,$4,$5,$6)").bind(&input.operation_id).bind(digest).bind(proof_digest).bind(now).bind(now+86_400_000).bind(&envelope).execute(&mut *tx).await?;
    }
    // Commit ownership and all evidence before evaluation. If cancellation or a
    // crash follows, an exact retry resumes this envelope without a fresh proof.
    tx.commit().await?;
    advance(&app, &input.operation_id, input.verification.as_ref())
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
) -> Result<(Snapshot, Value, i64)> {
    // Capture the evaluation time only after coordinated projection recovery.
    // Earlier request timestamps can refer to an event window already pruned.
    let ready = match projection::locked_ready(app, tx).await {
        Ok(ready) => Some(ready),
        Err(error) if error.dependency == Some("valkey") => None,
        Err(error) => return Err(error),
    };
    relationships::lock(tx, &proof.client_id).await?;
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
    let (users, relationships) =
        relationships::snapshot(tx, &proof.client_id, &proof.session_id, &input.ip, at).await?;
    known(
        &mut snapshot,
        "client.user_count_30d",
        Scalar::Number(users as f64),
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
    Ok((snapshot, relationships, at))
}
fn known(snapshot: &mut Snapshot, name: &str, value: Scalar) {
    if let Some(metric) = snapshot.metrics.get_mut(name) {
        metric.state = Observation::Known { value };
    }
}

const LEASE_MS: i64 = 5000;
const ATTEMPT_MS: i64 = 300_000;

async fn advance(app: &App, id: &str, verification: Option<&Verification>) -> Result<Value> {
    let mut tx = app.db.begin().await?;
    operation_lock(&mut tx, id).await?;
    let row = sqlx::query("SELECT * FROM operations WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    let state: String = row.get("state");
    let response: Option<Value> = row.get("response");
    if state == "final"
        || response
            .as_ref()
            .is_some_and(|v| v["outcome"] != "CHALLENGE_REQUIRED")
    {
        return response.ok_or_else(ApiError::unavailable);
    }
    let mut envelope: Value = row.get("envelope");
    let deadline = row.get::<i64, _>("accepted_at") + ATTEMPT_MS;
    let lease = row.get::<Option<i64>, _>("lease_until").unwrap_or(0);
    if state == "claimed" || state == "enriching" {
        if lease > util::now() {
            return Err(ApiError::conflict("operation_in_progress"));
        }
        let fence = claim(&mut tx, id, "enriching").await?;
        tx.commit().await?;
        providers::enrich(app, &mut envelope).await?;
        let mut tx = app.db.begin().await?;
        operation_lock(&mut tx, id).await?;
        ensure_fence(&mut tx, id, fence, "enriching").await?;
        sqlx::query("UPDATE operations SET envelope=$1,state='ready',lease_until=NULL WHERE id=$2")
            .bind(&envelope)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        let response = evaluate_locked(&mut tx, id, &envelope).await?;
        tx.commit().await?;
        return Ok(response);
    }
    if state == "ready" {
        let response = evaluate_locked(&mut tx, id, &envelope).await?;
        tx.commit().await?;
        return Ok(response);
    }
    let response = response.ok_or_else(ApiError::unavailable)?;
    let challenge = response["challenge"]["challenge_id"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let step = sqlx::query("SELECT * FROM challenge_steps WHERE id=$1 AND operation_id=$2")
        .bind(challenge)
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if util::now() >= deadline {
        complete_step(
            &mut tx,
            id,
            challenge,
            krine_core::Verification::Expired,
            "attempt_expired",
        )
        .await?;
        let result = evaluate_locked(&mut tx, id, &envelope).await?;
        tx.commit().await?;
        return Ok(result);
    }
    let Some(verification) = verification else {
        if state == "verifying" && lease <= util::now() {
            complete_step(
                &mut tx,
                id,
                challenge,
                krine_core::Verification::Unavailable,
                "verification_recovery_requires_original_token",
            )
            .await?;
            let result = evaluate_locked(&mut tx, id, &envelope).await?;
            tx.commit().await?;
            return Ok(result);
        }
        return Ok(response);
    };
    let token_digest = util::digest(&verification.token);
    if verification.challenge_id != challenge {
        let prior = sqlx::query(
            "SELECT token_digest,result FROM challenge_steps WHERE id=$1 AND operation_id=$2",
        )
        .bind(&verification.challenge_id)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        if prior.is_some_and(|r| {
            r.get::<Option<String>, _>("token_digest").as_deref() == Some(&token_digest)
                && r.get::<Option<String>, _>("result").as_deref() == Some("passed")
        }) {
            return Ok(response);
        }
        return Err(ApiError::invalid(
            "The challenge does not belong to the current verification step.",
        ));
    }
    if let Some(recorded) = step.get::<Option<String>, _>("token_digest") {
        if recorded != token_digest {
            return Err(ApiError::conflict("input_conflict"));
        }
        if lease > util::now() {
            return Err(ApiError::conflict("operation_in_progress"));
        }
    } else {
        // The global digest constraint prevents evidence reuse across steps and operations.
        let result = sqlx::query("UPDATE challenge_steps SET token_digest=$1 WHERE id=$2")
            .bind(&token_digest)
            .bind(challenge)
            .execute(&mut *tx)
            .await;
        if let Err(error) = result {
            if error
                .as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return Err(ApiError::conflict("verification_used"));
            }
            return Err(error.into());
        }
    }
    let fence = claim(&mut tx, id, "verifying").await?;
    transition(
        &mut tx,
        id,
        Some(challenge),
        "verifying",
        "verification_started",
    )
    .await?;
    record(&mut tx, id, &envelope, &response, None).await?;
    tx.commit().await?;
    let revision = providers::revision(app, "verification", step.get("provider_revision")).await?;
    let result = match revision.and_then(|r| r.secret) {
        Some(secret) => {
            providers::verify(
                app,
                &provider_http::VerificationRequest {
                    secret: &secret,
                    token: &verification.token,
                    expected_hostname: envelope["hostname"].as_str().unwrap_or_default(),
                    binding: step.get::<&str, _>("binding"),
                    idempotency_key: step.get::<&str, _>("verification_uuid"),
                    ip: util::ip(envelope["ip"].as_str().ok_or_else(ApiError::unavailable)?)?,
                    created_at_ms: step.get("created_at"),
                    deadline_ms: deadline,
                },
            )
            .await
        }
        None => provider_http::VerificationResult {
            outcome: krine_core::Verification::Unavailable,
            detail: "configuration_unavailable",
        },
    };
    #[cfg(test)]
    if let Some(notify) = &app.provider_test.after_verification {
        notify.arrived.notify_one();
        notify.resume.notified().await;
    }
    let mut tx = app.db.begin().await?;
    operation_lock(&mut tx, id).await?;
    ensure_fence(&mut tx, id, fence, "verifying").await?;
    let (outcome, detail) = if util::now() >= deadline {
        (krine_core::Verification::Expired, "attempt_expired")
    } else {
        (result.outcome, result.detail)
    };
    complete_step(&mut tx, id, challenge, outcome, detail).await?;
    let response = evaluate_locked(&mut tx, id, &envelope).await?;
    tx.commit().await?;
    Ok(response)
}
async fn claim(tx: &mut Transaction<'_, Postgres>, id: &str, state: &str) -> Result<i64> {
    Ok(sqlx::query_scalar(
        "UPDATE operations SET state=$1,fence=fence+1,lease_until=$2 WHERE id=$3 RETURNING fence",
    )
    .bind(state)
    .bind(util::now() + LEASE_MS)
    .bind(id)
    .fetch_one(&mut **tx)
    .await?)
}
async fn ensure_fence(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    fence: i64,
    state: &str,
) -> Result<()> {
    let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operations WHERE id=$1 AND fence=$2 AND state=$3 AND lease_until>$4)").bind(id).bind(fence).bind(state).bind(util::now()).fetch_one(&mut **tx).await?;
    if valid {
        Ok(())
    } else {
        Err(ApiError::conflict("operation_in_progress"))
    }
}
async fn transition(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    challenge: Option<&str>,
    state: &str,
    detail: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO verification_transitions(operation_id,sequence,at,challenge_id,state,detail) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,$3,$4,$5 FROM verification_transitions WHERE operation_id=$1").bind(id).bind(util::now()).bind(challenge).bind(state).bind(detail).execute(&mut **tx).await?;
    Ok(())
}
async fn complete_step(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    challenge: &str,
    outcome: krine_core::Verification,
    detail: &str,
) -> Result<()> {
    let status = json!(outcome)
        .as_str()
        .ok_or_else(ApiError::unavailable)?
        .to_owned();
    sqlx::query("UPDATE challenge_steps SET status='completed',result=$1,detail=$2 WHERE id=$3")
        .bind(&status)
        .bind(detail)
        .bind(challenge)
        .execute(&mut **tx)
        .await?;
    transition(tx, id, Some(challenge), &status, detail).await?;
    Ok(())
}
async fn evaluate_locked(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    envelope: &Value,
) -> Result<Value> {
    let policy = ValidatedPolicy::try_from(
        serde_json::from_value::<Policy>(envelope["policy"].clone())
            .map_err(|_| ApiError::unavailable())?,
    )?;
    let snapshot: Snapshot = serde_json::from_value(envelope["snapshot"].clone())
        .map_err(|_| ApiError::unavailable())?;
    let rows = sqlx::query(
        "SELECT rule_id,result FROM challenge_steps WHERE operation_id=$1 AND result IS NOT NULL",
    )
    .bind(id)
    .fetch_all(&mut **tx)
    .await?;
    let mut verified = BTreeMap::new();
    for row in rows {
        verified.insert(
            row.get::<String, _>("rule_id"),
            serde_json::from_value::<krine_core::Verification>(json!(
                row.get::<String, _>("result")
            ))
            .map_err(|_| ApiError::unavailable())?,
        );
    }
    let mut evaluation = krine_core::evaluate(&policy, &snapshot, &verified)?;
    let mut challenge = None;
    if evaluation.outcome == krine_core::Outcome::ChallengeRequired {
        let rule = evaluation
            .rule_id
            .as_deref()
            .ok_or_else(ApiError::unavailable)?;
        let revision = envelope["provider_revisions"]["verification"]["revision"]
            .as_i64()
            .unwrap_or(0);
        let config=sqlx::query("SELECT config,enabled,secret IS NOT NULL AS has_secret FROM provider_revisions WHERE capability='verification' AND revision=$1").bind(revision).fetch_optional(&mut **tx).await?;
        let challenge_id = util::token("ch_");
        let binding = util::token("bind_");
        let created = util::now();
        let deadline = envelope["accepted_at"]
            .as_i64()
            .ok_or_else(ApiError::unavailable)?
            + ATTEMPT_MS;
        sqlx::query("INSERT INTO challenge_steps(id,operation_id,rule_id,provider_revision,binding,created_at,deadline,verification_uuid) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(&challenge_id).bind(id).bind(rule).bind(revision).bind(&binding).bind(created).bind(deadline).bind(uuid::Uuid::new_v4().to_string()).execute(&mut **tx).await?;
        let configured = config
            .as_ref()
            .is_some_and(|r| r.get::<bool, _>("enabled") && r.get::<bool, _>("has_secret"))
            && envelope["hostname"].as_str().is_some_and(|s| !s.is_empty());
        if !configured || created >= deadline {
            let (outcome, detail) = if created >= deadline {
                (krine_core::Verification::Expired, "attempt_expired")
            } else {
                (
                    krine_core::Verification::Unavailable,
                    "configuration_unavailable",
                )
            };
            complete_step(tx, id, &challenge_id, outcome, detail).await?;
            verified.insert(rule.into(), outcome);
            evaluation = krine_core::evaluate(&policy, &snapshot, &verified)?;
        } else {
            let config: Value = config.ok_or_else(ApiError::unavailable)?.get("config");
            challenge = Some(
                json!({"challenge_id":challenge_id,"provider":"turnstile","site_key":config["site_key"],"action":provider_http::VERIFY_ACTION,"binding":binding,"expires_at":deadline}),
            );
            transition(
                tx,
                id,
                Some(&challenge_id),
                "pending",
                "verification_required",
            )
            .await?;
        }
    }
    let mut response = json!({"operation_id":id,"decision_id":envelope["decision_id"],"source":"evaluation","outcome":evaluation.outcome,"check":envelope["check"],"policy_version":envelope["policy_version"],"accepted_at":envelope["accepted_at"],"retry_until":envelope["retry_until"],"reason":evaluation.reason});
    let state = if let Some(challenge) = challenge {
        response["challenge"] = challenge;
        "pending"
    } else {
        "final"
    };
    sqlx::query("UPDATE operations SET state=$1,lease_until=NULL,response=$2 WHERE id=$3")
        .bind(state)
        .bind(&response)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    record(tx, id, envelope, &response, Some(json!(evaluation))).await?;
    Ok(response)
}
async fn record(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    envelope: &Value,
    response: &Value,
    evaluation: Option<Value>,
) -> Result<()> {
    let mut detail = envelope.clone();
    for (key, value) in response.as_object().ok_or_else(ApiError::unavailable)? {
        detail[key] = value.clone();
    }
    detail["completed_at"] = if response["outcome"] == "CHALLENGE_REQUIRED" {
        Value::Null
    } else {
        json!(util::now())
    };
    detail["evaluation"] = match evaluation {
        Some(e) => e,
        None => {
            sqlx::query_scalar::<_, Value>(
                "SELECT detail->'evaluation' FROM operations WHERE id=$1",
            )
            .bind(id)
            .fetch_one(&mut **tx)
            .await?
        }
    };
    let transitions=sqlx::query("SELECT sequence,at,challenge_id,state,detail FROM verification_transitions WHERE operation_id=$1 ORDER BY sequence").bind(id).fetch_all(&mut **tx).await?;
    let transitions=transitions.into_iter().map(|r|json!({"sequence":r.get::<i64,_>("sequence"),"at":r.get::<i64,_>("at"),"challenge_id":r.get::<Option<String>,_>("challenge_id"),"state":r.get::<String,_>("state"),"detail":r.get::<String,_>("detail")})).collect::<Vec<_>>();
    detail["verification_transitions"] = json!(transitions);
    let mut requests = vec![
        json!({"at":envelope["accepted_at"],"kind":"initial","result":if transitions.is_empty(){response["outcome"].clone()}else{json!("CHALLENGE_REQUIRED")}}),
    ];
    for transition in &transitions {
        requests.push(
            json!({"at":transition["at"],"kind":"verification","result":transition["state"]}),
        );
    }
    detail["requests"] = json!(requests);
    let revision:i64=sqlx::query_scalar("UPDATE operations SET detail=$1,history_revision=history_revision+1 WHERE id=$2 RETURNING history_revision").bind(&detail).bind(id).fetch_one(&mut **tx).await?;
    let logical_id = format!(
        "decision:{}",
        envelope["decision_id"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?
    );
    sqlx::query("INSERT INTO delivery_outbox(id,logical_id,revision,kind,at,payload) VALUES($1,$1,$2,'decision',$3,$4) ON CONFLICT(logical_id) DO UPDATE SET revision=EXCLUDED.revision,payload=EXCLUDED.payload,exported_at=NULL WHERE delivery_outbox.revision<EXCLUDED.revision").bind(logical_id).bind(revision).bind(envelope["accepted_at"].as_i64().ok_or_else(ApiError::unavailable)?).bind(detail).execute(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn expire_pending(app: &App) -> Result<()> {
    let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM operations WHERE state IN ('pending','verifying') AND accepted_at<=$1 LIMIT 100").bind(util::now()-ATTEMPT_MS).fetch_all(&app.db).await?;
    for id in ids {
        if let Err(error) = advance(app, &id, None).await
            && error.code != "operation_in_progress"
        {
            return Err(error);
        }
    }
    Ok(())
}
