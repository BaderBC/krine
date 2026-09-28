use crate::{
    App,
    auth::Peer,
    error::{ApiError, Result},
    json::StrictJson,
    util,
};
use axum::{Extension, Json, extract::State};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Default, Deserialize, Serialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct Signals {
    pub language: Option<String>,
    pub timezone: Option<String>,
    pub platform: Option<String>,
    pub fingerprint: Option<String>,
    pub screen_width: Option<u32>,
    pub screen_height: Option<u32>,
    pub hardware_concurrency: Option<u32>,
    pub webdriver: Option<bool>,
}
impl Signals {
    fn validate(&self) -> Result<()> {
        if [
            &self.language,
            &self.timezone,
            &self.platform,
            &self.fingerprint,
        ]
        .iter()
        .any(|s| s.as_ref().is_some_and(|s| s.len() > 1024))
            || [self.screen_width, self.screen_height]
                .into_iter()
                .flatten()
                .any(|n| n == 0 || n > 32768)
            || self
                .hardware_concurrency
                .is_some_and(|n| n == 0 || n > 1024)
        {
            return Err(ApiError::invalid("Browser signals exceed their limits."));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextRequest {
    client_token: Option<String>,
    session_token: Option<String>,
    signals: Option<Signals>,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Context {
    pub client_id: String,
    pub session_id: Option<String>,
    pub issued_at: i64,
    pub expires_at: i64,
    pub signals: Signals,
}
async fn load(app: &App, kind: &str, token: &str) -> Result<Option<Context>> {
    if token.len() > 128 {
        return Ok(None);
    }
    let value: Option<String> = app
        .redis
        .clone()
        .get(format!("krine:{kind}:{}", util::digest(token)))
        .await?;
    let Some(value) = value else { return Ok(None) };
    let context: Context = serde_json::from_str(&value).map_err(|_| ApiError::unavailable())?;
    Ok((context.expires_at > util::now()).then_some(context))
}
async fn save(app: &App, kind: &str, token: &str, context: &Context) -> Result<()> {
    let ttl = (context.expires_at - util::now()).max(1) as u64;
    let _: () = app
        .redis
        .clone()
        .set_options(
            format!("krine:{kind}:{}", util::digest(token)),
            serde_json::to_string(context).map_err(|_| ApiError::unavailable())?,
            redis::SetOptions::default().with_expiration(redis::SetExpiry::PX(ttl)),
        )
        .await?;
    Ok(())
}
pub async fn context(
    State(app): State<App>,
    Extension(peer): Extension<Peer>,
    StrictJson(input): StrictJson<ContextRequest>,
) -> Result<Json<serde_json::Value>> {
    if let Some(signals) = &input.signals {
        signals.validate()?;
    }
    let now = util::now();
    let existing_client = match &input.client_token {
        Some(token) => load(&app, "client", token).await?,
        None => None,
    };
    let (client_token, client) = match existing_client {
        Some(c) => (input.client_token.unwrap_or_default(), c),
        None => (
            util::token("ct_"),
            Context {
                client_id: util::token("cli_"),
                session_id: None,
                issued_at: now,
                expires_at: now + 2_592_000_000,
                signals: Signals::default(),
            },
        ),
    };
    let existing_session = match &input.session_token {
        Some(token) => load(&app, "session", token)
            .await?
            .filter(|s| s.client_id == client.client_id),
        None => None,
    };
    let (session_token, mut session) = match existing_session {
        Some(s) => (input.session_token.unwrap_or_default(), s),
        None => (
            util::token("st_"),
            Context {
                client_id: client.client_id.clone(),
                session_id: Some(util::token("ses_")),
                issued_at: now,
                expires_at: now + 86_400_000,
                signals: Signals::default(),
            },
        ),
    };
    if let Some(signals) = input.signals {
        session.signals = signals;
    }
    let mut tx = app.db.begin().await?;
    sqlx::query(
        "INSERT INTO entities(kind,id,first_seen) VALUES('client',$1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(&client.client_id)
    .bind(client.issued_at)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO entities(kind,id,client_id,first_seen) VALUES('session',$1,$2,$3) ON CONFLICT DO NOTHING").bind(&session.session_id).bind(&client.client_id).bind(session.issued_at).execute(&mut *tx).await?;
    sqlx::query("SELECT singleton FROM projection_state WHERE singleton=true FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    crate::events::capacity(&app, &mut tx).await?;
    sqlx::query("UPDATE entities SET metadata=$1 WHERE kind='session' AND id=$2")
        .bind(json!({"signals":session.signals,"provenance":"browser","observed_at":now}))
        .bind(&session.session_id)
        .execute(&mut *tx)
        .await?;
    observe_ip(
        &mut tx,
        &client.client_id,
        session
            .session_id
            .as_deref()
            .ok_or_else(ApiError::unavailable)?,
        &peer.0.to_string(),
        now,
    )
    .await?;
    let observation_id = util::token("obs_");
    crate::events::outbox(&mut tx,&observation_id,"event",now,&json!({"event_id":observation_id,"name":"browser.context","client_id":client.client_id,"session_id":session.session_id,"ip":peer.0.to_string(),"properties":session.signals,"accepted_at":now,"provenance":"browser"})).await?;
    tx.commit().await?;
    save(&app, "client", &client_token, &client).await?;
    save(&app, "session", &session_token, &session).await?;
    Ok(Json(
        json!({"client_id":client.client_id,"session_id":session.session_id,"client_token":client_token,"session_token":session_token,"expires_at":session.expires_at}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProofRequest {
    client_token: String,
    session_token: String,
    check: String,
}
#[derive(Deserialize, Serialize)]
pub struct Proof {
    pub client_id: String,
    pub session_id: String,
    pub check: String,
    pub ip: String,
    pub issued_at: i64,
    pub expires_at: i64,
    pub session_issued_at: i64,
    pub signals: Signals,
}
pub async fn proof(
    State(app): State<App>,
    Extension(peer): Extension<Peer>,
    StrictJson(input): StrictJson<ProofRequest>,
) -> Result<Json<serde_json::Value>> {
    util::identifier(&input.check)?;
    let client = load(&app, "client", &input.client_token)
        .await?
        .ok_or_else(invalid_context)?;
    let session = load(&app, "session", &input.session_token)
        .await?
        .filter(|s| s.client_id == client.client_id)
        .ok_or_else(invalid_context)?;
    let published: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM checks WHERE name=$1 AND active_version IS NOT NULL)",
    )
    .bind(&input.check)
    .fetch_one(&app.db)
    .await?;
    if !published {
        return Err(ApiError::absent());
    }
    let mut tx = app.db.begin().await?;
    observe_ip(
        &mut tx,
        &client.client_id,
        session
            .session_id
            .as_deref()
            .ok_or_else(ApiError::unavailable)?,
        &peer.0.to_string(),
        util::now(),
    )
    .await?;
    tx.commit().await?;
    let proof = util::token("prf_");
    let issued_at = util::now();
    let data = Proof {
        client_id: client.client_id,
        session_id: session.session_id.ok_or_else(ApiError::unavailable)?,
        check: input.check,
        ip: peer.0.to_string(),
        issued_at,
        expires_at: issued_at + 60_000,
        session_issued_at: session.issued_at,
        signals: session.signals,
    };
    let _: () = app
        .redis
        .clone()
        .set_options(
            format!("krine:proof:{}", util::digest(&proof)),
            serde_json::to_string(&data).map_err(|_| ApiError::unavailable())?,
            redis::SetOptions::default().with_expiration(redis::SetExpiry::PX(60_000)),
        )
        .await?;
    Ok(Json(
        json!({"proof":proof,"expires_at":data.expires_at,"client_id":data.client_id,"session_id":data.session_id}),
    ))
}

fn invalid_context() -> ApiError {
    ApiError::new(
        axum::http::StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_context",
        "Browser context is invalid, expired, or mismatched.",
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveRequest {
    client_token: String,
    session_token: String,
}
pub async fn resolve(
    State(app): State<App>,
    StrictJson(input): StrictJson<ResolveRequest>,
) -> Result<Json<serde_json::Value>> {
    let client = load(&app, "client", &input.client_token)
        .await?
        .ok_or_else(invalid_context)?;
    let session = load(&app, "session", &input.session_token)
        .await?
        .filter(|s| s.client_id == client.client_id)
        .ok_or_else(invalid_context)?;
    Ok(Json(
        json!({"client_id":client.client_id,"session_id":session.session_id.ok_or_else(invalid_context)?,"expires_at":session.expires_at}),
    ))
}

async fn observe_ip(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    client: &str,
    session: &str,
    ip: &str,
    at: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO entities(kind,id,first_seen) VALUES('ip',$1,$2) ON CONFLICT DO NOTHING",
    )
    .bind(ip)
    .bind(at)
    .execute(&mut **tx)
    .await?;
    sqlx::query("INSERT INTO observed_ips(client_id,session_id,ip,first_seen,last_seen) VALUES($1,$2,$3,$4,$4) ON CONFLICT(client_id,session_id,ip) DO UPDATE SET last_seen=EXCLUDED.last_seen").bind(client).bind(session).bind(ip).bind(at).execute(&mut **tx).await?;
    Ok(())
}
