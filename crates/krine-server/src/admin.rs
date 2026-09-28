use crate::{
    App,
    auth::header,
    error::{ApiError, Result},
    json::StrictJson,
    util,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use krine_core::{Policy, RuleAction, UnknownAction, ValidatedPolicy};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row, Transaction};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct List {
    pub limit: Option<i64>,
    pub cursor: Option<String>,
    pub q: Option<String>,
}
impl List {
    pub fn limit(&self) -> Result<i64> {
        let n = self.limit.unwrap_or(50);
        if !(1..=100).contains(&n) || self.q.as_ref().is_some_and(|q| q.len() > 128) {
            return Err(ApiError::invalid("Invalid list limit or search."));
        }
        Ok(n)
    }
    pub fn cursor(&self) -> Result<Option<(i64, String)>> {
        self.cursor
            .as_ref()
            .map(|v| {
                if v.len() > 1024 {
                    return Err(ApiError::invalid("Invalid cursor."));
                }
                let bytes = URL_SAFE_NO_PAD
                    .decode(v)
                    .map_err(|_| ApiError::invalid("Invalid cursor."))?;
                serde_json::from_slice(&bytes).map_err(|_| ApiError::invalid("Invalid cursor."))
            })
            .transpose()
    }
}
pub fn cursor(at: i64, id: &str) -> String {
    URL_SAFE_NO_PAD.encode(serde_json::to_vec(&(at, id)).expect("cursor serializes"))
}
// JSONB comparison ignores object key order and numeric spelling, but preserves
// policy structure. An unpublished draft has no active policy to match.
const CHECK_COLUMNS: &str = "checks.*, draft IS DISTINCT FROM (SELECT policy FROM policy_versions WHERE check_name=checks.name AND version=checks.active_version) AS has_draft_changes";

fn detail(row: &sqlx::postgres::PgRow) -> Value {
    json!({"name":row.get::<String,_>("name"),"description":row.get::<String,_>("description"),"active_version":row.get::<Option<i64>,_>("active_version"),"draft_revision":row.get::<i64,_>("draft_revision"),"has_draft_changes":row.get::<bool,_>("has_draft_changes"),"draft":row.get::<Value,_>("draft"),"updated_at":row.get::<i64,_>("updated_at"),"restored_from_version":row.get::<Option<i64>,_>("restored_from_version")})
}
pub async fn get_check(State(app): State<App>, Path(name): Path<String>) -> Result<Json<Value>> {
    let row = sqlx::query(&format!("SELECT {CHECK_COLUMNS} FROM checks WHERE name=$1"))
        .bind(name)
        .fetch_optional(&app.db)
        .await?
        .ok_or_else(ApiError::absent)?;
    Ok(Json(detail(&row)))
}
pub async fn list_checks(
    State(app): State<App>,
    query: std::result::Result<Query<List>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(list) = query.map_err(|_| ApiError::invalid("Invalid list query."))?;
    let limit = list.limit()?;
    let after = list.cursor()?;
    let mut query =
        QueryBuilder::<Postgres>::new(format!("SELECT {CHECK_COLUMNS} FROM checks WHERE true"));
    if let Some(q) = &list.q {
        query
            .push(" AND position(")
            .push_bind(q)
            .push(" in name)>0");
    }
    if let Some((at, id)) = after {
        query
            .push(" AND (created_at,name)<(")
            .push_bind(at)
            .push(",")
            .push_bind(id)
            .push(")");
    }
    query
        .push(" ORDER BY created_at DESC,name DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = query.build().fetch_all(&app.db).await?;
    let next = if rows.len() > limit as usize {
        let r = &rows[limit as usize - 1];
        Some(cursor(r.get("created_at"), r.get("name")))
    } else {
        None
    };
    let items=rows.iter().take(limit as usize).map(|r|json!({"name":r.get::<String,_>("name"),"description":r.get::<String,_>("description"),"active_version":r.get::<Option<i64>,_>("active_version"),"draft_revision":r.get::<i64,_>("draft_revision"),"has_draft_changes":r.get::<bool,_>("has_draft_changes"),"updated_at":r.get::<i64,_>("updated_at"),"recent":null})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
async fn mutation(
    app: &App,
    headers: &HeaderMap,
    path: &str,
    input: &Value,
) -> Result<(
    Transaction<'static, Postgres>,
    String,
    String,
    Option<Value>,
)> {
    let key = header(headers, "idempotency-key")
        .ok_or_else(|| ApiError::invalid("Idempotency-Key is required."))?
        .to_owned();
    util::identifier(&key)?;
    let digest = util::canonical_digest(&json!({"path":path,"input":input}));
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("admin:{key}"))
        .execute(&mut *tx)
        .await?;
    let prior = sqlx::query("SELECT digest,response,created_at FROM admin_mutations WHERE key=$1")
        .bind(&key)
        .fetch_optional(&mut *tx)
        .await?;
    let response = if let Some(row) = prior {
        if row.get::<String, _>("digest") != digest {
            return Err(ApiError::conflict("input_conflict"));
        }
        if util::now() > row.get::<i64, _>("created_at") + 86_400_000 {
            return Err(ApiError::invalid("The mutation retry window has expired."));
        }
        Some(row.get("response"))
    } else {
        None
    };
    Ok((tx, key, digest, response))
}
async fn finish(
    mut tx: Transaction<'_, Postgres>,
    key: String,
    digest: String,
    response: Value,
) -> Result<Json<Value>> {
    sqlx::query("INSERT INTO admin_mutations(key,digest,response,created_at) VALUES($1,$2,$3,$4)")
        .bind(key)
        .bind(digest)
        .bind(&response)
        .bind(util::now())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(response))
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    name: String,
    #[serde(default)]
    description: String,
}
pub async fn create_check(
    State(app): State<App>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Create>,
) -> Result<Json<Value>> {
    util::identifier(&input.name)?;
    description(&input.description)?;
    let (mut tx, key, digest, replay) = mutation(&app, &headers, "checks", &json!(input)).await?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    let now = util::now();
    let row=sqlx::query(&format!("INSERT INTO checks(name,description,draft,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING RETURNING {CHECK_COLUMNS}")).bind(input.name).bind(input.description).bind(json!(Policy::default())).bind(now).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::conflict("input_conflict"))?;
    finish(tx, key, digest, detail(&row)).await
}
fn description(text: &str) -> Result<()> {
    if text.len() > 1024 {
        return Err(ApiError::invalid("Description is limited to 1 KiB."));
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    revision: i64,
    description: String,
    policy: Policy,
}
pub async fn save_draft(
    State(app): State<App>,
    Path(name): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Draft>,
) -> Result<Json<Value>> {
    description(&input.description)?;
    ValidatedPolicy::try_from(input.policy.clone())?;
    let (mut tx, key, digest, replay) = mutation(
        &app,
        &headers,
        &format!("checks/{name}/draft"),
        &json!(input),
    )
    .await?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    let row=sqlx::query(&format!("UPDATE checks SET draft=$1,description=$2,draft_revision=draft_revision+1,updated_at=$3,restored_from_version=NULL WHERE name=$4 AND draft_revision=$5 RETURNING {CHECK_COLUMNS}")).bind(json!(input.policy)).bind(input.description).bind(util::now()).bind(name).bind(input.revision).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::conflict("revision_conflict"))?;
    finish(tx, key, digest, detail(&row)).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Publication {
    revision: i64,
    expected_active_version: Option<i64>,
}
pub async fn publish(
    State(app): State<App>,
    Path(name): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Publication>,
) -> Result<Json<Value>> {
    let (mut tx, key, digest, replay) = mutation(
        &app,
        &headers,
        &format!("checks/{name}/publications"),
        &json!(input),
    )
    .await?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    let row = sqlx::query("SELECT * FROM checks WHERE name=$1 FOR UPDATE")
        .bind(&name)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(ApiError::absent)?;
    if row.get::<i64, _>("draft_revision") != input.revision
        || row.get::<Option<i64>, _>("active_version") != input.expected_active_version
    {
        return Err(ApiError::conflict("revision_conflict"));
    }
    let policy: Policy =
        serde_json::from_value(row.get("draft")).map_err(|_| ApiError::unavailable())?;
    ValidatedPolicy::try_from(policy.clone())?;
    if policy
        .rules
        .iter()
        .any(|r| r.then == RuleAction::Challenge || r.on_unknown == UnknownAction::Challenge)
    {
        return Err(ApiError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "capability_unconfigured",
            "Configure verification before publishing a challenge policy.",
        ));
    }
    let version = row.get::<Option<i64>, _>("active_version").unwrap_or(0) + 1;
    let at = util::now();
    let restored = row.get::<Option<i64>, _>("restored_from_version");
    sqlx::query("INSERT INTO policy_versions(check_name,version,policy,published_at,restored_from_version) VALUES($1,$2,$3,$4,$5)").bind(&name).bind(version).bind(json!(policy)).bind(at).bind(restored).execute(&mut *tx).await?;
    sqlx::query("UPDATE checks SET active_version=$1,updated_at=$2 WHERE name=$3")
        .bind(version)
        .bind(at)
        .bind(name)
        .execute(&mut *tx)
        .await?;
    finish(tx,key,digest,json!({"version":version,"published_at":at,"policy":policy,"restored_from_version":restored})).await
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Restoration {
    version: i64,
    revision: i64,
    replace_draft: bool,
}
pub async fn restore(
    State(app): State<App>,
    Path(name): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Restoration>,
) -> Result<Json<Value>> {
    if !input.replace_draft {
        return Err(ApiError::invalid("Draft replacement must be explicit."));
    }
    let (mut tx, key, digest, replay) = mutation(
        &app,
        &headers,
        &format!("checks/{name}/restorations"),
        &json!(input),
    )
    .await?;
    if let Some(v) = replay {
        return Ok(Json(v));
    }
    let policy: Value =
        sqlx::query_scalar("SELECT policy FROM policy_versions WHERE check_name=$1 AND version=$2")
            .bind(&name)
            .bind(input.version)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::absent)?;
    let row=sqlx::query(&format!("UPDATE checks SET draft=$1,draft_revision=draft_revision+1,restored_from_version=$2,updated_at=$3 WHERE name=$4 AND draft_revision=$5 RETURNING {CHECK_COLUMNS}")).bind(policy).bind(input.version).bind(util::now()).bind(name).bind(input.revision).fetch_optional(&mut *tx).await?.ok_or_else(||ApiError::conflict("revision_conflict"))?;
    finish(tx, key, digest, detail(&row)).await
}
pub async fn versions(
    State(app): State<App>,
    Path(name): Path<String>,
    query: std::result::Result<Query<List>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(list) = query.map_err(|_| ApiError::invalid("Invalid list query."))?;
    let limit = list.limit()?;
    let cursor = list.cursor()?.map(|(n, _)| n).unwrap_or(i64::MAX);
    let rows=sqlx::query("SELECT version,policy,published_at FROM policy_versions WHERE check_name=$1 AND version<$2 ORDER BY version DESC LIMIT $3").bind(name).bind(cursor).bind(limit+1).fetch_all(&app.db).await?;
    let next = if rows.len() > limit as usize {
        Some(self::cursor(rows[limit as usize - 1].get("version"), ""))
    } else {
        None
    };
    let items=rows.iter().take(limit as usize).map(|r|json!({"version":r.get::<i64,_>("version"),"published_at":r.get::<i64,_>("published_at"),"policy":r.get::<Value,_>("policy")})).collect::<Vec<_>>();
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
pub async fn metrics(
    query: std::result::Result<Query<List>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(list) = query.map_err(|_| ApiError::invalid("Invalid list query."))?;
    let limit = list.limit()?;
    let skip = list.cursor()?.map(|(n, _)| n.max(0) as usize).unwrap_or(0);
    let all = krine_core::METRICS
        .iter()
        .filter(|m| list.q.as_ref().is_none_or(|q| m.name.contains(q)))
        .collect::<Vec<_>>();
    let items = all
        .iter()
        .skip(skip)
        .take(limit as usize)
        .collect::<Vec<_>>();
    let next = (skip + items.len() < all.len()).then(|| cursor((skip + items.len()) as i64, ""));
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
pub async fn metric(Path((name, version)): Path<(String, u32)>) -> Result<Json<Value>> {
    Ok(Json(json!(
        krine_core::metric(&name, version).ok_or_else(ApiError::absent)?
    )))
}
pub async fn setup(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"public_key":app.config.public_key,"browser_url":app.config.public_url,"server_url":app.config.public_url,"allowed_origins":app.config.allowed_origins,"sdk":{"browser_package":"@krine/browser","server_package":"@krine/server"}}),
    )
}
pub async fn providers() -> Json<Value> {
    Json(
        json!({"items":[{"capability":"ip_intelligence","provider":"proxycheck","enabled":false,"revision":0,"config":{},"has_secret":false,"status":"unconfigured","checked_at":null,"dependent_checks":[]},{"capability":"verification","provider":"turnstile","enabled":false,"revision":0,"config":{},"has_secret":false,"status":"unconfigured","checked_at":null,"dependent_checks":[]}]}),
    )
}

pub async fn version(
    State(app): State<App>,
    Path((name, version)): Path<(String, i64)>,
) -> Result<Json<Value>> {
    let row=sqlx::query("SELECT version,published_at,policy,restored_from_version FROM policy_versions WHERE check_name=$1 AND version=$2").bind(name).bind(version).fetch_optional(&app.db).await?.ok_or_else(ApiError::absent)?;
    Ok(Json(
        json!({"version":row.get::<i64,_>("version"),"published_at":row.get::<i64,_>("published_at"),"policy":row.get::<Value,_>("policy"),"restored_from_version":row.get::<Option<i64>,_>("restored_from_version")}),
    ))
}
