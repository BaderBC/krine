//! Installation operators are separate from customer identities. Authority is
//! read from PostgreSQL; access changes serialize with privileged effects.
use crate::{
    App, admin,
    auth::{self, header},
    config::Config,
    error::{ApiError, Result},
    json::StrictJson,
    util,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};

pub const SESSION_MILLIS: i64 = 8 * 3_600_000;
pub const RECOVERY_MILLIS: i64 = 30 * 60_000;
const AUDIT_DAYS: i64 = 365;
const COLUMNS: &str = "id,name,sign_in_name,role,state,revision,created_at,last_sign_in_at";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Viewer,
    Editor,
    Admin,
}
impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Admin => "admin",
        }
    }
    fn parse(s: &str) -> Result<Self> {
        match s {
            "viewer" => Ok(Self::Viewer),
            "editor" => Ok(Self::Editor),
            "admin" => Ok(Self::Admin),
            _ => Err(ApiError::unavailable()),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capability {
    Session,
    Investigate,
    Edit,
    Administer,
    Operators,
    Audit,
}
impl Capability {
    fn name(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Investigate => "investigate",
            Self::Edit => "edit",
            Self::Administer => "administer",
            Self::Operators => "manage_operators",
            Self::Audit => "audit",
        }
    }
}
#[derive(Clone)]
pub struct Admin {
    pub csrf: String,
    pub expires_at: i64,
    pub session_id: String,
    pub actor_id: String,
    pub actor_name: String,
    pub actor_type: &'static str,
    pub role: Option<Role>,
    pub operator: Option<Value>,
    pub recovery_reason: Option<String>,
}
impl Admin {
    pub fn allows(&self, capability: Capability) -> bool {
        match (self.role, capability) {
            (_, Capability::Session) => true,
            (None, Capability::Operators) => self.actor_type == "installation_recovery",
            (Some(_), Capability::Investigate) => true,
            (Some(Role::Editor | Role::Admin), Capability::Edit) => true,
            (Some(Role::Admin), _) => true,
            _ => false,
        }
    }
    pub fn require(&self, capability: Capability) -> Result<()> {
        if self.allows(capability) {
            Ok(())
        } else {
            Err(insufficient())
        }
    }
    pub fn identity(&self) -> Value {
        json!({"id":self.actor_id,"type":self.actor_type,"name":self.actor_name})
    }
    pub fn response(&self) -> Value {
        let capabilities = [
            Capability::Session,
            Capability::Investigate,
            Capability::Edit,
            Capability::Administer,
            Capability::Operators,
            Capability::Audit,
        ]
        .into_iter()
        .filter(|c| self.allows(*c))
        .map(Capability::name)
        .collect::<Vec<_>>();
        json!({"operator":self.operator,"actor_id":self.actor_id,"session_id":self.session_id,
            "authentication_method":if self.role.is_some(){"local"}else{"installation_recovery"},
            "capabilities":capabilities,"csrf_token":self.csrf,"expires_at":self.expires_at,"recovery_reason":self.recovery_reason})
    }
}
pub fn insufficient() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "insufficient_privilege",
        "Your current access does not permit this action.",
    )
}

/// The registry uses Axum's matched templates, never user-controlled substrings.
/// Unregistered routes and methods receive no authority (including implicit HEAD).
pub fn route_capability(template: &str, method: &Method) -> Option<Capability> {
    let read = method == Method::GET || method == Method::HEAD;
    use Capability::*;
    match (template, method.as_str(), read) {
        ("/v1/admin/session", "DELETE", _) | ("/v1/admin/session", _, true) => Some(Session),
        ("/v1/admin/operators/{id}/sessions", _, true) => Some(Session),
        ("/v1/admin/operators/{id}/sessions/{session_id}/revocations", "POST", _)
        | ("/v1/admin/operators/{id}/session-revocations", "POST", _) => Some(Session),
        ("/v1/admin/operators", "POST", _)
        | ("/v1/admin/operators/{id}", "PUT", _)
        | ("/v1/admin/operators/{id}/credential-rotations", "POST", _) => Some(Operators),
        ("/v1/admin/operators" | "/v1/admin/operators/{id}", _, true) => Some(Operators),
        ("/v1/admin/audit", _, true) => Some(Audit),
        ("/v1/admin/credentials", _, true)
        | ("/v1/admin/credentials", "POST", _)
        | ("/v1/admin/credentials/{id}/revocations", "POST", _)
        | ("/v1/admin/providers/{capability}", "PUT", _)
        | ("/v1/admin/providers/{capability}/tests", "POST", _) => Some(Administer),
        ("/v1/admin/checks", "POST", _)
        | ("/v1/admin/checks/{name}/draft" | "/v1/admin/lookup/checks/draft", "PUT", _)
        | (
            "/v1/admin/checks/{name}/publications"
            | "/v1/admin/checks/{name}/restorations"
            | "/v1/admin/lookup/checks/publications"
            | "/v1/admin/lookup/checks/restorations"
            | "/v1/admin/relationships/{kind}/{id}/corrections"
            | "/v1/admin/relationships/{kind}/{id}/restorations"
            | "/v1/admin/lookup/relationships/corrections"
            | "/v1/admin/lookup/relationships/restorations",
            "POST",
            _,
        ) => Some(Edit),
        (
            "/v1/admin/checks"
            | "/v1/admin/checks/{name}"
            | "/v1/admin/checks/{name}/versions"
            | "/v1/admin/checks/{name}/versions/{version}"
            | "/v1/admin/lookup/checks"
            | "/v1/admin/lookup/checks/versions"
            | "/v1/admin/lookup/checks/versions/{version}"
            | "/v1/admin/metrics"
            | "/v1/admin/metrics/{name}/versions/{version}"
            | "/v1/admin/entities/{kind}/{id}"
            | "/v1/admin/entities/{kind}/{id}/relationships"
            | "/v1/admin/relationships/{kind}/{id}"
            | "/v1/admin/lookup/entities"
            | "/v1/admin/lookup/entities/relationships"
            | "/v1/admin/lookup/relationships"
            | "/v1/admin/setup"
            | "/v1/admin/providers"
            | "/v1/admin/activity/events"
            | "/v1/admin/activity/events/{id}"
            | "/v1/admin/lookup/events"
            | "/v1/admin/activity/decisions"
            | "/v1/admin/activity/decisions/{id}"
            | "/v1/admin/analytics/activity"
            | "/v1/admin/installation"
            | "/v1/admin/lookup/entities/context"
            | "/v1/admin/lookup/entities/timeline",
            _,
            true,
        ) => Some(Investigate),
        _ => None,
    }
}
pub fn public_route(path: &str, method: &Method) -> bool {
    (method == Method::POST
        && matches!(
            path,
            "/v1/admin/session" | "/v1/admin/auth/bootstrap" | "/v1/admin/auth/recovery/session"
        ))
        || ((method == Method::GET || method == Method::HEAD) && path == "/v1/admin/auth/methods")
}
pub fn routes() -> Router<App> {
    Router::new()
        .route("/v1/admin/auth/methods", get(methods))
        .route("/v1/admin/auth/bootstrap", post(bootstrap))
        .route("/v1/admin/auth/recovery/session", post(redeem))
        .route("/v1/admin/operators", get(list).post(create))
        .route("/v1/admin/operators/{id}", get(detail).put(update))
        .route(
            "/v1/admin/operators/{id}/credential-rotations",
            post(rotate),
        )
        .route("/v1/admin/operators/{id}/sessions", get(sessions))
        .route(
            "/v1/admin/operators/{id}/sessions/{session_id}/revocations",
            post(revoke_session),
        )
        .route(
            "/v1/admin/operators/{id}/session-revocations",
            post(revoke_sessions),
        )
        .route("/v1/admin/audit", get(audit_list))
}
fn operator(row: &sqlx::postgres::PgRow) -> Value {
    json!({"id":row.get::<String,_>("id"),"name":row.get::<String,_>("name"),
        "sign_in_name":row.get::<String,_>("sign_in_name"),"role":row.get::<String,_>("role"),
        "state":row.get::<String,_>("state"),"revision":row.get::<i64,_>("revision"),
        "authentication_method":"local","created_at":row.get::<i64,_>("created_at"),"last_sign_in_at":row.get::<Option<i64>,_>("last_sign_in_at")})
}
pub(crate) async fn now(tx: &mut Transaction<'_, Postgres>) -> Result<i64> {
    Ok(
        sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&mut **tx)
            .await?,
    )
}
pub(crate) async fn gate(tx: &mut Transaction<'_, Postgres>, exclusive: bool) -> Result<()> {
    let query = if exclusive {
        "SELECT singleton FROM operator_access WHERE singleton FOR UPDATE"
    } else {
        "SELECT singleton FROM operator_access WHERE singleton FOR SHARE"
    };
    sqlx::query(query).fetch_one(&mut **tx).await?;
    Ok(())
}
pub(crate) async fn configure(db: &PgPool, config: &Config) -> Result<()> {
    let mut tx = db.begin().await?;
    gate(&mut tx, true).await?;
    let row = sqlx::query("SELECT * FROM operator_access WHERE singleton")
        .fetch_one(&mut *tx)
        .await?;
    // OIDC is added as a separate reviewed authentication unit. Until then every
    // ordinary Admin uses local authentication, so disabling it would lock out all.
    if !config.local_sign_in {
        return Err(ApiError::invalid(
            "Local sign-in cannot be disabled without another eligible Admin authentication method.",
        ));
    }
    let digest = util::digest(format!("krine.installation.v1\0{}", config.admin_password));
    if row.get::<String, _>("installation_secret_digest") != digest
        || row.get::<bool, _>("local_enabled") != config.local_sign_in
    {
        let at = now(&mut tx).await?;
        sqlx::query("UPDATE operator_access SET installation_secret_digest=$1,local_enabled=$2,generation=generation+1 WHERE singleton").bind(digest).bind(config.local_sign_in).execute(&mut *tx).await?;
        sqlx::query("UPDATE operator_sessions SET revoked_at=COALESCE(revoked_at,$1)")
            .bind(at)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE operator_recovery_grants SET revoked_at=COALESCE(revoked_at,$1)")
            .bind(at)
            .execute(&mut *tx)
            .await?;
        record(
            &mut tx,
            &host_actor(),
            Audit::new(
                "access.configuration",
                "installation",
                row.get::<String, _>("installation_id"),
            )
            .changes(json!({"local_enabled":config.local_sign_in})),
            None,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub(crate) fn host_actor() -> Identity {
    Identity {
        id: "installation_configuration".into(),
        kind: "installation_configuration".into(),
        name: "Installation configuration".into(),
    }
}

pub fn cookie_digest(headers: &HeaderMap) -> Result<String> {
    let all = header(headers, "cookie").ok_or_else(ApiError::unauthorized)?;
    let mut found = None;
    for part in all.split(';') {
        if let Some(value) = part.trim().strip_prefix("krine_operator=") {
            if found.is_some()
                || value.len() != 43
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(ApiError::unauthorized());
            }
            found = Some(value);
        }
    }
    found
        .map(|v| util::digest(format!("krine.session.v1\0{v}")))
        .ok_or_else(ApiError::unauthorized)
}
const SESSION_QUERY: &str = "SELECT s.id AS session_id,s.digest,s.csrf,s.expires_at,s.recovery_grant_id,o.id,o.name,o.sign_in_name,o.role,o.state,o.revision,o.created_at,o.last_sign_in_at,g.reason FROM operator_sessions s JOIN operator_access a ON a.singleton LEFT JOIN operators o ON o.id=s.operator_id LEFT JOIN operator_recovery_grants g ON g.id=s.recovery_grant_id WHERE s.digest=$1 AND s.revoked_at IS NULL AND s.expires_at>(extract(epoch FROM clock_timestamp())*1000)::bigint AND s.generation=a.generation AND ((o.state='active' AND a.local_enabled) OR (s.recovery_grant_id IS NOT NULL AND g.consumed_at IS NOT NULL AND g.revoked_at IS NULL))";
fn from_session(row: sqlx::postgres::PgRow) -> Result<Admin> {
    let recovery: Option<String> = row.get("recovery_grant_id");
    let (actor_id, actor_name, actor_type, role, operator) = if let Some(id) = recovery {
        (
            format!("recovery:{id}"),
            "Installation recovery".into(),
            "installation_recovery",
            None,
            None,
        )
    } else {
        (
            row.get("id"),
            row.get("name"),
            "operator",
            Some(Role::parse(row.get("role"))?),
            Some(operator(&row)),
        )
    };
    Ok(Admin {
        csrf: row.get("csrf"),
        expires_at: row.get("expires_at"),
        session_id: row.get("session_id"),
        actor_id,
        actor_name,
        actor_type,
        role,
        operator,
        recovery_reason: row.get("reason"),
    })
}
pub async fn session(app: &App, headers: &HeaderMap) -> Result<Admin> {
    let row = sqlx::query(SESSION_QUERY)
        .bind(cookie_digest(headers)?)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    from_session(row)
}
pub(crate) async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    headers: &HeaderMap,
    capability: Capability,
) -> Result<Admin> {
    let row = sqlx::query(SESSION_QUERY)
        .bind(cookie_digest(headers)?)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::unauthorized)?;
    let actor = from_session(row)?;
    actor.require(capability)?;
    check_intent(headers, &actor)?;
    Ok(actor)
}
pub fn check_intent(headers: &HeaderMap, actor: &Admin) -> Result<()> {
    if !header(headers, "x-csrf-token").is_some_and(|s| util::equal(s, &actor.csrf)) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "csrf_failed",
            "The request verification token is missing or invalid.",
        ));
    }
    if header(headers, "x-krine-operator-id") != Some(actor.actor_id.as_str()) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "actor_changed",
            "This action belongs to a different operator. Inspect the original result before creating another action.",
        ));
    }
    Ok(())
}
fn label(value: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > max
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        Err(ApiError::invalid(
            "Use nonempty text without surrounding whitespace or control characters.",
        ))
    } else {
        Ok(())
    }
}
fn sign_in(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    {
        Err(ApiError::invalid(
            "A sign-in name uses 1–64 ASCII letters, digits, dots, underscores or dashes.",
        ))
    } else {
        Ok(())
    }
}
fn credential_digest(id: &str, credential: &str) -> String {
    util::digest(format!("krine.local-credential.v1\0{id}\0{credential}"))
}
async fn methods(State(app): State<App>) -> Result<Json<Value>> {
    let row=sqlx::query("SELECT installation_id,local_enabled,bootstrap_consumed_at IS NULL AS bootstrap FROM operator_access WHERE singleton").fetch_one(&app.db).await?;
    Ok(Json(
        json!({"installation_id":row.get::<String,_>("installation_id"),"local":row.get::<bool,_>("local_enabled"),"bootstrap":row.get::<bool,_>("bootstrap"),"recovery":true,"oidc":false}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    installation_secret: String,
    sign_in_name: String,
    name: String,
}
async fn bootstrap(
    State(app): State<App>,
    StrictJson(input): StrictJson<Bootstrap>,
) -> Result<Json<Value>> {
    if input.installation_secret.len() > 1024
        || !util::equal(&input.installation_secret, &app.config.admin_password)
    {
        return Err(ApiError::unauthorized());
    }
    sign_in(&input.sign_in_name)?;
    label(&input.name, 128)?;
    let mut tx = app.db.begin().await?;
    gate(&mut tx, true).await?;
    let expected: String = sqlx::query_scalar(
        "SELECT installation_secret_digest FROM operator_access WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !util::equal(
        &expected,
        &util::digest(format!(
            "krine.installation.v1\0{}",
            input.installation_secret
        )),
    ) {
        return Err(ApiError::unauthorized());
    }
    let consumed: bool = sqlx::query_scalar(
        "SELECT bootstrap_consumed_at IS NOT NULL FROM operator_access WHERE singleton",
    )
    .fetch_one(&mut *tx)
    .await?;
    if consumed {
        return Err(ApiError::conflict("bootstrap_consumed"));
    }
    let at = now(&mut tx).await?;
    let (op, secret) =
        insert_operator(&mut tx, &input.name, &input.sign_in_name, Role::Admin, at).await?;
    sqlx::query("UPDATE operator_access SET bootstrap_consumed_at=$1 WHERE singleton")
        .bind(at)
        .execute(&mut *tx)
        .await?;
    record(
        &mut tx,
        &host_actor(),
        Audit::new(
            "operator.bootstrap",
            "operator",
            op["id"].as_str().ok_or_else(ApiError::unavailable)?,
        )
        .changes(json!({"role":"admin","state":"active"})),
        None,
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"operator":op,"credential":secret,"secret_status":"revealed"}),
    ))
}
async fn insert_operator(
    tx: &mut Transaction<'_, Postgres>,
    name: &str,
    sign_in_name: &str,
    role: Role,
    at: i64,
) -> Result<(Value, String)> {
    let id = util::token("op_");
    let secret = util::token("ok_");
    let row=sqlx::query(&format!("INSERT INTO operators(id,name,sign_in_name,role,credential_digest,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(sign_in_name) DO NOTHING RETURNING {COLUMNS}"))
        .bind(&id).bind(name).bind(sign_in_name).bind(role.name()).bind(credential_digest(&id,&secret)).bind(at).fetch_optional(&mut **tx).await?.ok_or_else(||ApiError::conflict("sign_in_name_taken"))?;
    Ok((operator(&row), secret))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    sign_in_name: String,
    credential: String,
}
pub async fn login(
    State(app): State<App>,
    StrictJson(input): StrictJson<Login>,
) -> Result<Response> {
    if sign_in(&input.sign_in_name).is_err()
        || input.credential.len() != 46
        || !input.credential.starts_with("ok_")
    {
        return Err(ApiError::unauthorized());
    }
    // Fixed hash buckets bound attacker-created keys while retaining per-account
    // throttling; collisions can only make login more restrictive.
    let account = util::digest(&input.sign_in_name);
    auth::rate(
        &app,
        &format!("operator-login:{}", &account[..3]),
        app.config.login_rate,
        60,
    )
    .await?;
    let mut tx = app.db.begin().await?;
    gate(&mut tx, false).await?;
    let row=sqlx::query("SELECT o.*,a.local_enabled FROM operators o CROSS JOIN operator_access a WHERE o.sign_in_name=$1 AND a.singleton").bind(&input.sign_in_name).fetch_optional(&mut *tx).await?;
    let expected = row
        .as_ref()
        .map(|r| r.get::<String, _>("credential_digest"))
        .unwrap_or_else(|| credential_digest("absent", ""));
    let id = row
        .as_ref()
        .map(|r| r.get::<String, _>("id"))
        .unwrap_or_default();
    let matches = util::equal(&expected, &credential_digest(&id, &input.credential));
    let row = row
        .filter(|r| {
            matches && r.get::<String, _>("state") == "active" && r.get::<bool, _>("local_enabled")
        })
        .ok_or_else(ApiError::unauthorized)?;
    let at = now(&mut tx).await?;
    sqlx::query("UPDATE operators SET last_sign_in_at=$2 WHERE id=$1")
        .bind(&id)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    let (token, actor) = new_session(&mut tx, Some(&id), None, at, SESSION_MILLIS).await?;
    record(
        &mut tx,
        &Identity::from(&actor),
        Audit::new("session.sign_in", "session", &actor.session_id),
        None,
    )
    .await?;
    drop(row);
    tx.commit().await?;
    session_response(&app, &token, actor)
}
async fn new_session(
    tx: &mut Transaction<'_, Postgres>,
    id: Option<&str>,
    grant: Option<&str>,
    at: i64,
    duration: i64,
) -> Result<(String, Admin)> {
    let token = util::token("");
    let digest = util::digest(format!("krine.session.v1\0{token}"));
    sqlx::query("INSERT INTO operator_sessions(id,digest,csrf,operator_id,recovery_grant_id,generation,created_at,expires_at) SELECT $1,$2,$3,$4,$5,generation,$6,$7 FROM operator_access WHERE singleton")
        .bind(util::token("os_" )).bind(&digest).bind(util::token("")).bind(id).bind(grant).bind(at).bind(at+duration).execute(&mut **tx).await?;
    let actor = from_session(
        sqlx::query(SESSION_QUERY)
            .bind(digest)
            .fetch_one(&mut **tx)
            .await?,
    )?;
    Ok((token, actor))
}
fn session_response(app: &App, token: &str, actor: Admin) -> Result<Response> {
    let age = if actor.role.is_some() {
        SESSION_MILLIS
    } else {
        RECOVERY_MILLIS
    } / 1000;
    let mut response = Json(actor.response()).into_response();
    response.headers_mut().insert(
        "set-cookie",
        format!(
            "krine_operator={token}; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age={age}{}",
            if app.config.development {
                ""
            } else {
                "; Secure"
            }
        )
        .parse()
        .map_err(|_| ApiError::unavailable())?,
    );
    Ok(response)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Redeem {
    token: String,
}
async fn redeem(State(app): State<App>, StrictJson(input): StrictJson<Redeem>) -> Result<Response> {
    if input.token.len() != 46 || !input.token.starts_with("rg_") {
        return Err(ApiError::unauthorized());
    }
    let mut tx = app.db.begin().await?;
    gate(&mut tx, true).await?;
    let at = now(&mut tx).await?;
    let grant:String=sqlx::query_scalar("UPDATE operator_recovery_grants SET consumed_at=$2 WHERE digest=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>$2 RETURNING id").bind(util::digest(format!("krine.recovery.v1\0{}",input.token))).bind(at).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::unauthorized)?;
    let (token, actor) = new_session(&mut tx, None, Some(&grant), at, RECOVERY_MILLIS).await?;
    record(
        &mut tx,
        &Identity::from(&actor),
        Audit::new("recovery.redeem", "session", &actor.session_id)
            .reason(actor.recovery_reason.as_deref().unwrap_or("Recovery")),
        None,
    )
    .await?;
    tx.commit().await?;
    session_response(&app, &token, actor)
}
pub async fn current(axum::Extension(actor): axum::Extension<Admin>) -> Json<Value> {
    Json(actor.response())
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<Response> {
    let mut tx = app.db.begin().await?;
    gate(&mut tx, true).await?;
    let actor = authorize(&mut tx, &headers, Capability::Session).await?;
    let at = now(&mut tx).await?;
    sqlx::query("UPDATE operator_sessions SET revoked_at=$2 WHERE id=$1")
        .bind(&actor.session_id)
        .bind(at)
        .execute(&mut *tx)
        .await?;
    record(
        &mut tx,
        &Identity::from(&actor),
        Audit::new("session.sign_out", "session", &actor.session_id),
        None,
    )
    .await?;
    tx.commit().await?;
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        "set-cookie",
        format!(
            "krine_operator=; HttpOnly; SameSite=Strict; Path=/v1/admin; Max-Age=0{}",
            if app.config.development {
                ""
            } else {
                "; Secure"
            }
        )
        .parse()
        .map_err(|_| ApiError::unavailable())?,
    );
    Ok(response)
}

#[derive(Clone)]
pub(crate) struct Identity {
    pub id: String,
    pub kind: String,
    pub name: String,
}
impl From<&Admin> for Identity {
    fn from(a: &Admin) -> Self {
        Self {
            id: a.actor_id.clone(),
            kind: a.actor_type.into(),
            name: a.actor_name.clone(),
        }
    }
}
pub(crate) struct Audit {
    action: &'static str,
    resource_type: &'static str,
    resource_id: String,
    reason: Option<String>,
    changes: Value,
}
impl Audit {
    pub fn new(action: &'static str, resource_type: &'static str, id: impl Into<String>) -> Self {
        Self {
            action,
            resource_type,
            resource_id: id.into(),
            reason: None,
            changes: json!({}),
        }
    }
    pub fn reason(mut self, reason: &str) -> Self {
        self.reason = Some(reason.into());
        self
    }
    pub fn changes(mut self, changes: Value) -> Self {
        self.changes = changes;
        self
    }
}
pub(crate) async fn record(
    tx: &mut Transaction<'_, Postgres>,
    actor: &Identity,
    audit: Audit,
    key: Option<&str>,
) -> Result<()> {
    sqlx::query("INSERT INTO administrative_audit(id,at,actor_id,actor_type,actor_name,action,resource_type,resource_id,reason,changes,mutation_key) VALUES($1,(extract(epoch FROM clock_timestamp())*1000)::bigint,$2,$3,$4,$5,$6,$7,$8,$9,$10)")
        .bind(util::token("aud_")).bind(&actor.id).bind(&actor.kind).bind(&actor.name).bind(audit.action).bind(audit.resource_type).bind(audit.resource_id).bind(audit.reason).bind(audit.changes).bind(key).execute(&mut **tx).await?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Create {
    name: String,
    sign_in_name: String,
    role: Role,
    reason: String,
}
async fn create(
    State(app): State<App>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Create>,
) -> Result<Json<Value>> {
    label(&input.name, 128)?;
    sign_in(&input.sign_in_name)?;
    label(&input.reason, 512)?;
    let (mut tx, receipt, replay) = admin::mutation_with_gate(
        &app,
        &headers,
        "operators",
        &json!(input),
        Capability::Operators,
        true,
    )
    .await?;
    if let Some(v) = replay {
        return unrecoverable(&mut tx, v).await;
    }
    let at = now(&mut tx).await?;
    let (op, secret) =
        insert_operator(&mut tx, &input.name, &input.sign_in_name, input.role, at).await?;
    let id = op["id"].as_str().ok_or_else(ApiError::unavailable)?;
    let _ = admin::finish(
        tx,
        receipt,
        json!({"operator_id":id}),
        Audit::new("operator.create", "operator", id)
            .reason(&input.reason)
            .changes(json!({"role":input.role,"state":"active","revision":1})),
    )
    .await?;
    Ok(Json(
        json!({"operator":op,"credential":secret,"secret_status":"revealed"}),
    ))
}
async fn unrecoverable(tx: &mut Transaction<'_, Postgres>, receipt: Value) -> Result<Json<Value>> {
    let id = receipt["operator_id"]
        .as_str()
        .ok_or_else(ApiError::unavailable)?;
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM operators WHERE id=$1"))
        .bind(id)
        .fetch_one(&mut **tx)
        .await?;
    Ok(Json(
        json!({"operator":operator(&row),"credential":null,"secret_status":"unrecoverable"}),
    ))
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum OperatorState {
    Active,
    Disabled,
}
impl OperatorState {
    fn name(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Disabled => "disabled",
        }
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Update {
    revision: i64,
    name: String,
    role: Role,
    state: OperatorState,
    reason: String,
}
async fn update(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Update>,
) -> Result<Json<Value>> {
    util::identifier(&id)?;
    label(&input.name, 128)?;
    label(&input.reason, 512)?;
    let (mut tx, receipt, replay) = admin::mutation_with_gate(
        &app,
        &headers,
        &format!("operators/{id}"),
        &json!(input),
        Capability::Operators,
        true,
    )
    .await?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    let previous = target(&mut tx, &id, input.revision).await?;
    let was_admin = previous.get::<String, _>("role") == "admin"
        && previous.get::<String, _>("state") == "active";
    if was_admin && (input.role != Role::Admin || !matches!(input.state, OperatorState::Active)) {
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM operators WHERE role='admin' AND state='active' AND id<>$1",
        )
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
        if count == 0 {
            return Err(ApiError::conflict("last_admin"));
        }
    }
    let row=sqlx::query(&format!("UPDATE operators SET name=$2,role=$3,state=$4,revision=revision+1 WHERE id=$1 RETURNING {COLUMNS}"))
        .bind(&id).bind(&input.name).bind(input.role.name()).bind(input.state.name()).fetch_one(&mut *tx).await?;
    if previous.get::<String, _>("role") != input.role.name()
        || previous.get::<String, _>("state") != input.state.name()
    {
        revoke_all(&mut tx, &id).await?;
    }
    admin::finish(tx,receipt,operator(&row),Audit::new("operator.update","operator",id).reason(&input.reason).changes(json!({"previous_revision":input.revision,"revision":row.get::<i64,_>("revision"),"previous_role":previous.get::<String,_>("role"),"role":input.role,"previous_state":previous.get::<String,_>("state"),"state":input.state}))).await
}
async fn target(
    tx: &mut Transaction<'_, Postgres>,
    id: &str,
    revision: i64,
) -> Result<sqlx::postgres::PgRow> {
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM operators WHERE id=$1"))
        .bind(id)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or_else(ApiError::absent)?;
    if row.get::<i64, _>("revision") != revision {
        return Err(ApiError::conflict("revision_conflict"));
    }
    Ok(row)
}
async fn revoke_all(tx: &mut Transaction<'_, Postgres>, id: &str) -> Result<u64> {
    Ok(sqlx::query("UPDATE operator_sessions SET revoked_at=(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE operator_id=$1 AND revoked_at IS NULL AND expires_at>(extract(epoch FROM clock_timestamp())*1000)::bigint").bind(id).execute(&mut **tx).await?.rows_affected())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RevisionReason {
    revision: i64,
    reason: String,
}
async fn rotate(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<RevisionReason>,
) -> Result<Json<Value>> {
    util::identifier(&id)?;
    label(&input.reason, 512)?;
    let (mut tx, receipt, replay) = admin::mutation_with_gate(
        &app,
        &headers,
        &format!("operators/{id}/credential-rotations"),
        &json!(input),
        Capability::Operators,
        true,
    )
    .await?;
    if let Some(v) = replay {
        return unrecoverable(&mut tx, v).await;
    }
    target(&mut tx, &id, input.revision).await?;
    let secret = util::token("ok_");
    let row=sqlx::query(&format!("UPDATE operators SET credential_digest=$2,revision=revision+1 WHERE id=$1 RETURNING {COLUMNS}")).bind(&id).bind(credential_digest(&id,&secret)).fetch_one(&mut *tx).await?;
    revoke_all(&mut tx, &id).await?;
    let _ = admin::finish(
        tx,
        receipt,
        json!({"operator_id":id}),
        Audit::new("operator.credential_rotate", "operator", id)
            .reason(&input.reason)
            .changes(
                json!({"previous_revision":input.revision,"revision":row.get::<i64,_>("revision")}),
            ),
    )
    .await?;
    Ok(Json(
        json!({"operator":operator(&row),"credential":secret,"secret_status":"revealed"}),
    ))
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    limit: Option<i64>,
    cursor: Option<String>,
}
impl Page {
    fn page(&self, scope: &str) -> Result<(i64, Option<(i64, String)>)> {
        let list = admin::List {
            limit: self.limit,
            cursor: self.cursor.clone(),
            q: None,
        };
        let limit = list.limit()?;
        let cursor = list
            .cursor()?
            .map(|(at, id)| {
                let (bound, id) = id
                    .split_once('\0')
                    .ok_or_else(|| ApiError::invalid("Invalid cursor."))?;
                if bound != scope || at < 0 {
                    return Err(ApiError::invalid("The cursor belongs to another list."));
                }
                util::identifier(id).map_err(|_| ApiError::invalid("Invalid cursor."))?;
                Ok((at, id.to_owned()))
            })
            .transpose()?;
        Ok((limit, cursor))
    }
}
fn next_cursor(
    rows: &[sqlx::postgres::PgRow],
    limit: i64,
    scope: &str,
    time: &str,
) -> Option<String> {
    (rows.len() > limit as usize).then(|| {
        let r = &rows[limit as usize - 1];
        admin::cursor(
            r.get(time),
            &format!("{scope}\0{}", r.get::<String, _>("id")),
        )
    })
}
type PageQuery = std::result::Result<Query<Page>, axum::extract::rejection::QueryRejection>;
async fn list(State(app): State<App>, query: PageQuery) -> Result<Json<Value>> {
    let Query(page) = query.map_err(|_| ApiError::invalid("Invalid operator list query."))?;
    let (limit, cursor) = page.page("operators")?;
    let (at, id) = cursor.unwrap_or((i64::MAX, String::new()));
    let rows=sqlx::query(&format!("SELECT {COLUMNS} FROM operators WHERE (created_at,id)<($1,$2) ORDER BY created_at DESC,id DESC LIMIT $3"))
        .bind(at).bind(id).bind(limit+1).fetch_all(&app.db).await?;
    Ok(Json(
        json!({"items":rows.iter().take(limit as usize).map(operator).collect::<Vec<_>>(),"next_cursor":next_cursor(&rows,limit,"operators","created_at")}),
    ))
}
async fn detail(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    util::identifier(&id)?;
    let row = sqlx::query(&format!("SELECT {COLUMNS} FROM operators WHERE id=$1"))
        .bind(id)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::absent)?;
    Ok(Json(operator(&row)))
}
fn owns_or_admin(actor: &Admin, id: &str) -> Result<()> {
    if actor.actor_id == id || actor.allows(Capability::Operators) {
        Ok(())
    } else {
        Err(insufficient())
    }
}
async fn sessions(
    State(app): State<App>,
    axum::Extension(actor): axum::Extension<Admin>,
    Path(id): Path<String>,
    query: PageQuery,
) -> Result<Json<Value>> {
    util::identifier(&id)?;
    owns_or_admin(&actor, &id)?;
    let Query(page) = query.map_err(|_| ApiError::invalid("Invalid session list query."))?;
    let scope = format!("operator-sessions:{id}");
    let (limit, cursor) = page.page(&scope)?;
    let (at, after) = cursor.unwrap_or((i64::MAX, String::new()));
    let rows=sqlx::query("SELECT id,created_at,expires_at,revoked_at FROM operator_sessions WHERE operator_id=$1 AND (created_at,id)<($2,$3) ORDER BY created_at DESC,id DESC LIMIT $4")
        .bind(id).bind(at).bind(after).bind(limit+1).fetch_all(&app.db).await?;
    let items=rows.iter().take(limit as usize).map(|r|json!({"id":r.get::<String,_>("id"),"created_at":r.get::<i64,_>("created_at"),"expires_at":r.get::<i64,_>("expires_at"),"revoked_at":r.get::<Option<i64>,_>("revoked_at"),"current":r.get::<String,_>("id")==actor.session_id})).collect::<Vec<_>>();
    Ok(Json(
        json!({"items":items,"next_cursor":next_cursor(&rows,limit,&scope,"created_at")}),
    ))
}
async fn revoke_session(
    State(app): State<App>,
    Path((id, session)): Path<(String, String)>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<RevisionReason>,
) -> Result<Json<Value>> {
    revoke(app, id, Some(session), headers, input).await
}
async fn revoke_sessions(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<RevisionReason>,
) -> Result<Json<Value>> {
    revoke(app, id, None, headers, input).await
}
async fn revoke(
    app: App,
    id: String,
    session: Option<String>,
    headers: HeaderMap,
    input: RevisionReason,
) -> Result<Json<Value>> {
    util::identifier(&id)?;
    if let Some(s) = &session {
        util::identifier(s)?;
    }
    label(&input.reason, 512)?;
    let path = match &session {
        Some(s) => format!("operators/{id}/sessions/{s}/revocations"),
        None => format!("operators/{id}/session-revocations"),
    };
    let (mut tx, receipt, replay) = admin::mutation_with_gate(
        &app,
        &headers,
        &path,
        &json!(input),
        Capability::Session,
        true,
    )
    .await?;
    owns_or_admin(&receipt.actor, &id)?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    target(&mut tx, &id, input.revision).await?;
    let revoked = if let Some(s) = &session {
        sqlx::query("UPDATE operator_sessions SET revoked_at=COALESCE(revoked_at,(extract(epoch FROM clock_timestamp())*1000)::bigint) WHERE operator_id=$1 AND id=$2 RETURNING id").bind(&id).bind(s).fetch_optional(&mut *tx).await?.ok_or_else(ApiError::absent)?;
        1
    } else {
        revoke_all(&mut tx, &id).await?
    };
    admin::finish(
        tx,
        receipt,
        json!({"operator_id":id,"session_id":session,"revoked":revoked}),
        Audit::new("operator.sessions_revoke", "operator", id)
            .reason(&input.reason)
            .changes(json!({"session_id":session,"revoked":revoked})),
    )
    .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AuditQuery {
    limit: Option<i64>,
    cursor: Option<String>,
    actor_id: Option<String>,
    resource_type: Option<String>,
    resource_id: Option<String>,
}
async fn audit_list(
    State(app): State<App>,
    query: std::result::Result<Query<AuditQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(q) = query.map_err(|_| ApiError::invalid("Invalid audit query."))?;
    for value in [&q.actor_id, &q.resource_type, &q.resource_id]
        .into_iter()
        .flatten()
    {
        label(value, 256)?;
    }
    let scope = util::canonical_digest(
        &json!({"audit":1,"actor_id":q.actor_id,"resource_type":q.resource_type,"resource_id":q.resource_id}),
    );
    let (limit, cursor) = Page {
        limit: q.limit,
        cursor: q.cursor,
    }
    .page(&scope)?;
    let (at, id) = cursor.unwrap_or((i64::MAX, String::new()));
    let mut tx = app.db.begin().await?;
    let coverage = audit_coverage(&mut tx).await?;
    tx.commit().await?;
    let rows=sqlx::query("SELECT * FROM administrative_audit WHERE at>=$1 AND (at,id)<($2,$3) AND ($4::text IS NULL OR actor_id=$4) AND ($5::text IS NULL OR resource_type=$5) AND ($6::text IS NULL OR resource_id=$6) ORDER BY at DESC,id DESC LIMIT $7")
        .bind(coverage.1).bind(at).bind(id).bind(q.actor_id).bind(q.resource_type).bind(q.resource_id).bind(limit+1).fetch_all(&app.db).await?;
    let items=rows.iter().take(limit as usize).map(|r|json!({"id":r.get::<String,_>("id"),"at":r.get::<i64,_>("at"),"actor":{"id":r.get::<String,_>("actor_id"),"type":r.get::<String,_>("actor_type"),"name":r.get::<String,_>("actor_name")},"action":r.get::<String,_>("action"),"resource":{"type":r.get::<String,_>("resource_type"),"id":r.get::<String,_>("resource_id")},"reason":r.get::<Option<String>,_>("reason"),"changes":r.get::<Value,_>("changes")})).collect::<Vec<_>>();
    Ok(Json(
        json!({"items":items,"next_cursor":next_cursor(&rows,limit,&scope,"at"),"coverage":{"days":AUDIT_DAYS,"started_at":coverage.0,"available_since":coverage.1}}),
    ))
}
async fn audit_coverage(tx: &mut Transaction<'_, Postgres>) -> Result<(i64, i64)> {
    let row=sqlx::query("UPDATE operator_audit_retention SET expired_before=GREATEST(expired_before,(extract(epoch FROM clock_timestamp())*1000)::bigint-31536000000) WHERE singleton RETURNING started_at,GREATEST(started_at,expired_before) AS available_since").fetch_one(&mut **tx).await?;
    Ok((row.get("started_at"), row.get("available_since")))
}
pub(crate) async fn cleanup(app: &App) -> Result<()> {
    let mut tx = app.db.begin().await?;
    let (_, floor) = audit_coverage(&mut tx).await?;
    sqlx::query("DELETE FROM administrative_audit WHERE id IN (SELECT id FROM administrative_audit WHERE at<$1 ORDER BY at,id LIMIT 1000)").bind(floor).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM operator_sessions WHERE id IN (SELECT id FROM operator_sessions WHERE expires_at<$1 ORDER BY expires_at,id LIMIT 1000)").bind(floor).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM operator_recovery_grants WHERE id IN (SELECT g.id FROM operator_recovery_grants g WHERE expires_at<$1 AND NOT EXISTS(SELECT 1 FROM operator_sessions s WHERE s.recovery_grant_id=g.id) ORDER BY expires_at,id LIMIT 1000)").bind(floor).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_list_cursors_validate_identity_and_preserve_scope() {
        for (scope, prefix) in [
            ("operators", "op_"),
            ("operator-sessions:op_example", "os_"),
            ("audit-filter-digest", "aud_"),
        ] {
            let id = util::token(prefix);
            let page = Page {
                limit: Some(1),
                cursor: Some(admin::cursor(123, &format!("{scope}\0{id}"))),
            };
            assert_eq!(page.page(scope).unwrap(), (1, Some((123, id))));
            assert_eq!(page.page("another-list").unwrap_err().code, "invalid_input");
            for invalid in ["", "id\0suffix", "id\n", "界", &"a".repeat(129)] {
                let page = Page {
                    limit: Some(1),
                    cursor: Some(admin::cursor(123, &format!("{scope}\0{invalid}"))),
                };
                assert_eq!(page.page(scope).unwrap_err().code, "invalid_input");
            }
        }
    }
    #[test]
    fn authorization_registry_denies_unlisted_methods_and_keeps_head_parity() {
        for route in [
            "/v1/admin/checks",
            "/v1/admin/credentials",
            "/v1/admin/operators",
            "/v1/admin/audit",
            "/v1/admin/lookup/entities/context",
            "/v1/admin/lookup/entities/timeline",
        ] {
            assert_eq!(
                route_capability(route, &Method::GET),
                route_capability(route, &Method::HEAD)
            );
            assert_eq!(route_capability(route, &Method::PATCH), None);
        }
        for route in [
            "/v1/admin/unknown",
            "/v1/admin/credentials/../checks",
            "/v1/admin/checks/{name}/oops",
        ] {
            assert_eq!(route_capability(route, &Method::GET), None);
        }
        assert_eq!(
            route_capability("/v1/admin/lookup/checks/draft", &Method::PUT),
            Some(Capability::Edit)
        );
        assert_eq!(
            route_capability("/v1/admin/providers/{capability}/tests", &Method::POST),
            Some(Capability::Administer)
        );
    }
    #[test]
    fn cookie_and_local_credential_boundaries_are_strict() {
        let token = util::token("");
        let mut headers = HeaderMap::new();
        headers.insert(
            "cookie",
            format!("other=1; krine_operator={token}").parse().unwrap(),
        );
        assert!(cookie_digest(&headers).is_ok());
        headers.append("cookie", format!("krine_operator={token}").parse().unwrap());
        assert!(cookie_digest(&headers).is_err());
        headers.clear();
        headers.insert(
            "cookie",
            format!("krine_operator={token}; krine_operator={token}")
                .parse()
                .unwrap(),
        );
        assert!(cookie_digest(&headers).is_err());
        assert_ne!(
            credential_digest("one", &token),
            credential_digest("two", &token)
        );
        assert_ne!(credential_digest("one", &token), util::digest(&token));
        for name in ["admin", "First.Last", "a-b_c", "CaseSensitive"] {
            assert!(sign_in(name).is_ok());
        }
        for name in ["", " name", "name ", "é", "a/b", "a:b"] {
            assert!(sign_in(name).is_err());
        }
    }
}
