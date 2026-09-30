use crate::operators::{Audit, Capability};
use crate::{
    App, admin,
    error::{ApiError, Result},
    json::StrictJson,
    provider_http::{self, ConnectionStatus, IpObservation},
    util,
};
use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use krine_core::{Condition, Observation, Policy, Reference, RuleAction, Snapshot, UnknownAction};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, Row, Transaction};
use std::{net::IpAddr, time::Duration};

const CONFIGURATION_CHECKED: &str = "Configuration format checked. Live site-key and secret pairing has not been tested; verify it through your application.";

// Never derive Debug: immutable revisions contain provider credentials.
pub(crate) struct Revision {
    pub secret: Option<String>,
}
fn provider(capability: &str) -> Result<&'static str> {
    match capability {
        "ip_intelligence" => Ok("proxycheck"),
        "verification" => Ok("turnstile"),
        _ => Err(ApiError::absent()),
    }
}
pub(crate) async fn revision(
    app: &App,
    capability: &str,
    revision: i64,
) -> Result<Option<Revision>> {
    Ok(
        sqlx::query("SELECT secret FROM provider_revisions WHERE capability=$1 AND revision=$2")
            .bind(capability)
            .bind(revision)
            .fetch_optional(&app.db)
            .await?
            .map(|r| Revision {
                secret: r.get("secret"),
            }),
    )
}
pub(crate) fn needs(policy: &Policy, capability: &str) -> bool {
    if capability == "verification" {
        return policy
            .rules
            .iter()
            .any(|r| r.then == RuleAction::Challenge || r.on_unknown == UnknownAction::Challenge);
    }
    policy.rules.iter().any(|r| needs_ip(&r.condition))
}
fn needs_ip(condition: &Condition) -> bool {
    match condition {
        Condition::Compare { left, .. }
        | Condition::In { left, .. }
        | Condition::Between { left, .. }
        | Condition::Known { value: left } => {
            matches!(left,Reference::Metric{name,..} if matches!(name.as_str(),"ip.risk"|"ip.country"|"ip.is_proxy"|"ip.high_risk"))
        }
        Condition::All { conditions } | Condition::Any { conditions } => {
            conditions.iter().any(needs_ip)
        }
        Condition::Not { condition } => needs_ip(condition),
    }
}
pub(crate) async fn pin(tx: &mut Transaction<'_, Postgres>, policy: &Policy) -> Result<Value> {
    let mut pinned = json!({});
    for capability in ["ip_intelligence", "verification"] {
        if !needs(policy, capability) {
            continue;
        }
        let revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM provider_current WHERE capability=$1 FOR SHARE",
        )
        .bind(capability)
        .fetch_one(&mut **tx)
        .await?;
        // A lock wait may select a revision committed after this statement's
        // snapshot. Read its immutable state with a fresh statement, not a join.
        let enabled = if revision == 0 {
            false
        } else {
            sqlx::query_scalar(
                "SELECT enabled FROM provider_revisions WHERE capability=$1 AND revision=$2",
            )
            .bind(capability)
            .bind(revision)
            .fetch_one(&mut **tx)
            .await?
        };
        pinned[capability] = json!({"revision":revision,"enabled":enabled});
    }
    Ok(pinned)
}
pub(crate) async fn validate_publication(
    tx: &mut Transaction<'_, Postgres>,
    check: &str,
    policy: &Policy,
) -> Result<()> {
    let previous: Option<Value> = sqlx::query_scalar("SELECT p.policy FROM checks c JOIN policy_versions p ON p.check_name=c.name AND p.version=c.active_version WHERE c.name=$1")
        .bind(check).fetch_optional(&mut **tx).await?;
    let previous: Option<Policy> = previous
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| ApiError::unavailable())?;
    // Save/disconnect takes these rows exclusively before checking dependents.
    // A fixed order also matches attempt pinning when both capabilities are used.
    for capability in ["ip_intelligence", "verification"] {
        // Removing a dependency changes the reviewed set too.
        if !needs(policy, capability) && !previous.as_ref().is_some_and(|p| needs(p, capability)) {
            continue;
        }
        let revision: i64 = sqlx::query_scalar(
            "SELECT revision FROM provider_current WHERE capability=$1 FOR SHARE",
        )
        .bind(capability)
        .fetch_one(&mut **tx)
        .await?;
        // IP evidence can remain explicitly unknown. Only a challenge requires
        // configured verification before publication.
        if capability == "verification" && needs(policy, capability) {
            let enabled:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM provider_revisions WHERE capability=$1 AND revision=$2 AND enabled)").bind(capability).bind(revision).fetch_one(&mut **tx).await?;
            if !enabled {
                return Err(ApiError::new(
                    axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                    "capability_unconfigured",
                    "Configure verification before publishing a challenge policy.",
                ));
            }
        }
    }
    Ok(())
}
struct Dependents {
    names: Vec<String>,
    versions: Vec<Value>,
    token: String,
}
async fn dependents(tx: &mut Transaction<'_, Postgres>, capability: &str) -> Result<Dependents> {
    let rows=sqlx::query("SELECT c.name,p.version,p.policy FROM checks c JOIN policy_versions p ON p.check_name=c.name AND p.version=c.active_version ORDER BY c.name").fetch_all(&mut **tx).await?;
    let mut names = Vec::new();
    let mut versions = Vec::new();
    for row in rows {
        let policy: Policy =
            serde_json::from_value(row.get("policy")).map_err(|_| ApiError::unavailable())?;
        if needs(&policy, capability) {
            let name: String = row.get("name");
            versions.push(json!({"check":name,"version":row.get::<i64,_>("version")}));
            names.push(name);
        }
    }
    let token = util::canonical_digest(&json!({"capability":capability,"versions":versions}));
    Ok(Dependents {
        names,
        versions,
        token,
    })
}
async fn summary(tx: &mut Transaction<'_, Postgres>, capability: &str) -> Result<Value> {
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM provider_current WHERE capability=$1")
            .bind(capability)
            .fetch_one(&mut **tx)
            .await?;
    let row = sqlx::query("SELECT * FROM provider_revisions WHERE capability=$1 AND revision=$2")
        .bind(capability)
        .bind(current)
        .fetch_optional(&mut **tx)
        .await?;
    let dependent_checks = dependents(tx, capability).await?;
    Ok(match row {
        Some(row) => {
            json!({"capability":capability,"provider":provider(capability)?,"revision":current,"enabled":row.get::<bool,_>("enabled"),"created_by":row.get::<Option<Value>,_>("created_by"),"config":row.get::<Value,_>("config"),"has_secret":row.get::<Option<String>,_>("secret").is_some(),"status":row.get::<String,_>("status"),"message":row.get::<String,_>("message"),"checked_at":row.get::<Option<i64>,_>("checked_at"),"dependent_checks":dependent_checks.names,"dependent_versions":dependent_checks.versions,"dependents_token":dependent_checks.token})
        }
        None => {
            json!({"capability":capability,"provider":provider(capability)?,"revision":0,"enabled":false,"created_by":null,"config":{},"has_secret":false,"status":"unconfigured","message":"Provider is not configured.","checked_at":null,"dependent_checks":dependent_checks.names,"dependent_versions":dependent_checks.versions,"dependents_token":dependent_checks.token})
        }
    })
}
pub async fn list(State(app): State<App>) -> Result<Json<Value>> {
    let mut tx = app.db.begin().await?;
    let ip = summary(&mut tx, "ip_intelligence").await?;
    let verification = summary(&mut tx, "verification").await?;
    Ok(Json(json!({"items":[ip,verification]})))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    revision: i64,
    provider: String,
    enabled: bool,
    config: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Save {
    revision: i64,
    provider: String,
    enabled: bool,
    config: Value,
    test_token: Option<String>,
    #[serde(default)]
    acknowledge_dependents: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reviewed_dependents_token: Option<String>,
}
impl Save {
    fn candidate(&self) -> Candidate {
        Candidate {
            revision: self.revision,
            provider: self.provider.clone(),
            enabled: self.enabled,
            config: self.config.clone(),
        }
    }
}
struct Resolved {
    config: Value,
    secret: Option<String>,
    digest: String,
}
async fn resolve(
    tx: &mut Transaction<'_, Postgres>,
    capability: &str,
    input: &Candidate,
) -> Result<Resolved> {
    if input.provider != provider(capability)? || input.revision < 0 {
        return Err(ApiError::invalid("Invalid provider or revision."));
    }
    let current: i64 =
        sqlx::query_scalar("SELECT revision FROM provider_current WHERE capability=$1 FOR UPDATE")
            .bind(capability)
            .fetch_one(&mut **tx)
            .await?;
    if current != input.revision {
        return Err(ApiError::conflict("revision_conflict"));
    }
    let old = sqlx::query(
        "SELECT config,secret FROM provider_revisions WHERE capability=$1 AND revision=$2",
    )
    .bind(capability)
    .bind(current)
    .fetch_optional(&mut **tx)
    .await?;
    let old_config = old
        .as_ref()
        .map(|r| r.get::<Value, _>("config"))
        .unwrap_or(json!({}));
    let old_secret = old
        .as_ref()
        .and_then(|r| r.get::<Option<String>, _>("secret"));
    let config = input
        .config
        .as_object()
        .ok_or_else(|| ApiError::invalid("Provider config must be an object."))?;
    if config
        .keys()
        .any(|k| k != "secret" && !(capability == "verification" && k == "site_key"))
    {
        return Err(ApiError::invalid("Unknown provider configuration field."));
    }
    let secret = match config.get("secret") {
        None => old_secret,
        Some(Value::Null) => None,
        Some(Value::String(s))
            if !s.is_empty() && s.len() <= 1024 && s.bytes().all(|b| b.is_ascii_graphic()) =>
        {
            Some(s.clone())
        }
        _ => return Err(ApiError::invalid("Invalid provider secret.")),
    };
    let public = if capability == "verification" {
        let site = config
            .get("site_key")
            .or_else(|| old_config.get("site_key"));
        match site {
            Some(Value::String(s))
                if !s.is_empty()
                    && s.len() <= 256
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') =>
            {
                json!({"site_key":s})
            }
            None if !input.enabled => json!({}),
            _ => return Err(ApiError::invalid("A valid Turnstile site key is required.")),
        }
    } else {
        json!({})
    };
    if input.enabled && capability == "verification" && secret.is_none() {
        return Err(ApiError::invalid("A Turnstile secret is required."));
    }
    let digest = util::canonical_digest(
        &json!({"capability":capability,"provider":input.provider,"enabled":input.enabled,"config":public,"secret":secret}),
    );
    Ok(Resolved {
        config: public,
        secret,
        digest,
    })
}
pub async fn test(
    State(app): State<App>,
    Path(capability): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Candidate>,
) -> Result<Json<Value>> {
    let path = format!("providers/{capability}/tests");
    let (mut tx, _, replay) =
        admin::mutation(&app, &headers, &path, &json!(input), Capability::Administer).await?;
    if let Some(value) = replay {
        return Ok(Json(value));
    }
    let candidate = resolve(&mut tx, &capability, &input).await?;
    tx.rollback().await?;
    // Candidate testing is read-only external work. No database lock spans a provider request.
    let (status, message) = if !input.enabled {
        ("invalid", "Enable the candidate before testing.".to_owned())
    } else if capability == "verification" {
        ("configuration_checked", CONFIGURATION_CHECKED.to_owned())
    } else {
        let observation = lookup(
            &app,
            candidate.secret.as_deref(),
            "1.1.1.1".parse().expect("fixed public IP"),
        )
        .await;
        match observation.status {
            ConnectionStatus::Connected => {
                ("ready", "Lookup succeeded for the test IP.".to_owned())
            }
            ConnectionStatus::Partial
                if [
                    &observation.risk,
                    &observation.is_proxy,
                    &observation.country,
                ]
                .iter()
                .any(|field| matches!(field, Observation::Known { .. })) =>
            {
                (
                    "configuration_checked",
                    format!(
                        "The test IP returned usable evidence with {}. Missing or invalid fields remain unknown; evidence for other IPs may differ.",
                        if observation.detail == "provider_warning" {
                            "a provider warning"
                        } else {
                            "incomplete fields"
                        }
                    ),
                )
            }
            ConnectionStatus::Partial => (
                "invalid",
                "The provider returned no usable evidence for the test IP.".to_owned(),
            ),
            ConnectionStatus::Invalid => (
                "invalid",
                "The provider rejected the credentials or returned invalid evidence.".to_owned(),
            ),
            ConnectionStatus::Unavailable => (
                "unavailable",
                "The provider could not complete the test.".to_owned(),
            ),
        }
    };
    #[cfg(test)]
    if let Some(pause) = &app.provider_test.after_operator_provider_test {
        pause.arrived.notify_one();
        pause.resume.notified().await;
    }
    let (mut tx, receipt, replay) =
        admin::mutation(&app, &headers, &path, &json!(input), Capability::Administer).await?;
    if let Some(value) = replay {
        return Ok(Json(value));
    }
    let fresh = resolve(&mut tx, &capability, &input).await?;
    if fresh.digest != candidate.digest {
        return Err(ApiError::conflict("revision_conflict"));
    }
    let now = util::now();
    let token = matches!(status, "ready" | "configuration_checked").then(|| util::token("pt_"));
    if let Some(token) = &token {
        sqlx::query("INSERT INTO provider_tests(digest,capability,candidate_digest,revision,status,message,checked_at,expires_at,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)").bind(util::digest(token)).bind(&capability).bind(candidate.digest).bind(input.revision).bind(status).bind(&message).bind(now).bind(now+600_000).bind(&receipt.actor.actor_id).execute(&mut *tx).await?;
    }
    let dependent_checks = dependents(&mut tx, &capability).await?;
    admin::finish(tx,receipt,json!({"status":status,"checked_at":now,"message":message,"test_token":token,"dependent_checks":dependent_checks.names,"dependent_versions":dependent_checks.versions,"dependents_token":dependent_checks.token}),Audit::new("provider.test","provider",&capability).changes(json!({"revision":input.revision,"status":status}))).await
}
pub async fn save(
    State(app): State<App>,
    Path(capability): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Save>,
) -> Result<Json<Value>> {
    let (mut tx, receipt, replay) = admin::mutation(
        &app,
        &headers,
        &format!("providers/{capability}"),
        &json!(input),
        Capability::Administer,
    )
    .await?;
    if let Some(value) = replay {
        return Ok(Json(value));
    }
    let candidate = resolve(&mut tx, &capability, &input.candidate()).await?;
    let dependents = dependents(&mut tx, &capability).await?;
    if input.revision > 0 && !dependents.names.is_empty() && !input.acknowledge_dependents {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "dependent_checks",
            "Acknowledge the affected published checks before changing this provider.",
        ));
    }
    if input.revision > 0
        && input.acknowledge_dependents
        && input.reviewed_dependents_token.as_deref() != Some(dependents.token.as_str())
    {
        return Err(ApiError::conflict("dependent_checks_changed"));
    }
    let (status, message, checked_at) = if input.enabled {
        let token = input
            .test_token
            .as_deref()
            .filter(|v| v.len() <= 128)
            .ok_or_else(|| ApiError::invalid("A fresh matching provider test is required."))?;
        let test=sqlx::query("SELECT status,message,checked_at FROM provider_tests WHERE digest=$1 AND capability=$2 AND candidate_digest=$3 AND revision=$4 AND expires_at>$5 AND actor_id=$6").bind(util::digest(token)).bind(&capability).bind(&candidate.digest).bind(input.revision).bind(util::now()).bind(&receipt.actor.actor_id).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::invalid("A fresh matching provider test is required."))?;
        (
            test.get::<String, _>("status"),
            test.get::<String, _>("message"),
            Some(test.get::<i64, _>("checked_at")),
        )
    } else {
        (
            "disabled".into(),
            "Provider is disconnected for new attempts.".into(),
            None,
        )
    };
    let next = input.revision + 1;
    sqlx::query("INSERT INTO provider_revisions(capability,revision,provider,enabled,config,secret,status,message,checked_at,created_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").bind(&capability).bind(next).bind(&input.provider).bind(input.enabled).bind(candidate.config).bind(candidate.secret).bind(status).bind(message).bind(checked_at).bind(util::now()).bind(receipt.actor.identity()).execute(&mut *tx).await?;
    sqlx::query("UPDATE provider_current SET revision=$1 WHERE capability=$2")
        .bind(next)
        .bind(&capability)
        .execute(&mut *tx)
        .await?;
    let response = summary(&mut tx, &capability).await?;
    admin::finish(
        tx,
        receipt,
        response,
        Audit::new("provider.save", "provider", capability).changes(
            json!({"previous_revision":input.revision,"revision":next,"enabled":input.enabled}),
        ),
    )
    .await
}
async fn lookup(app: &App, secret: Option<&str>, ip: IpAddr) -> IpObservation {
    #[cfg(test)]
    if let Some(endpoint) = &app.provider_test.ip_endpoint {
        return provider_http::lookup_ip_at(&app.http, secret, ip, endpoint).await;
    }
    provider_http::lookup_ip(&app.http, secret, ip).await
}
pub(crate) async fn enrich(app: &App, envelope: &mut Value) -> Result<()> {
    let pinned = &envelope["provider_revisions"]["ip_intelligence"];
    if pinned["enabled"] != true {
        return Ok(());
    }
    let number = pinned["revision"]
        .as_i64()
        .ok_or_else(ApiError::unavailable)?;
    let revision = revision(app, "ip_intelligence", number)
        .await?
        .ok_or_else(ApiError::unavailable)?;
    let ip = util::ip(envelope["ip"].as_str().ok_or_else(ApiError::unavailable)?)?;
    let key = format!("krine:ip:{number}:{ip}");
    #[cfg(test)]
    let key = format!("{key}:{}", app.provider_test.history_suffix);
    let cached = tokio::time::timeout(
        Duration::from_millis(50),
        app.redis.clone().get::<_, Option<String>>(&key),
    )
    .await
    .ok()
    .and_then(std::result::Result::ok)
    .flatten()
    .and_then(|s| serde_json::from_str::<IpObservation>(&s).ok())
    .filter(|o| o.observed_at_ms <= util::now() && util::now() - o.observed_at_ms < 60_000);
    let observation = if let Some(observation) = cached {
        observation
    } else {
        let observation = lookup(app, revision.secret.as_deref(), ip).await;
        if let Ok(encoded) = serde_json::to_string(&observation) {
            let _ = tokio::time::timeout(
                Duration::from_millis(50),
                app.redis.clone().set_options::<_, _, ()>(
                    &key,
                    encoded,
                    redis::SetOptions::default().with_expiration(redis::SetExpiry::EX(60)),
                ),
            )
            .await;
        }
        observation
    };
    let mut snapshot: Snapshot = serde_json::from_value(envelope["snapshot"].clone())
        .map_err(|_| ApiError::unavailable())?;
    for (name, state) in [
        ("ip.risk", observation.risk),
        ("ip.is_proxy", observation.is_proxy),
        ("ip.country", observation.country),
    ] {
        if let Some(metric) = snapshot.metrics.get_mut(name) {
            metric.state = state;
            metric.provenance.source = format!("proxycheck@{number}");
            metric.provenance.observed_at = observation.observed_at_ms as u64;
        }
    }
    krine_core::derive_metrics(&mut snapshot, util::now() as u64);
    envelope["snapshot"] = json!(snapshot);
    envelope["provider_observations"] = json!({"ip_intelligence":{"revision":number,"status":observation.status,"detail":observation.detail,"observed_at":observation.observed_at_ms}});
    Ok(())
}
pub(crate) async fn verify(
    app: &App,
    request: &provider_http::VerificationRequest<'_>,
) -> provider_http::VerificationResult {
    #[cfg(test)]
    if let Some(endpoint) = &app.provider_test.verify_endpoint {
        return provider_http::verify_turnstile_at(&app.http, request, endpoint).await;
    }
    provider_http::verify_turnstile(&app.http, request).await
}
