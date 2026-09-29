use crate::{
    App, admin,
    config::Config,
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
use sqlx::{PgPool, Postgres, QueryBuilder, Row};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Browser,
    Server,
}
impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Server => "server",
        }
    }
}

pub(crate) fn validate_bootstrap(config: &Config) -> std::result::Result<(), String> {
    for (value, minimum) in [(&config.public_key, 16), (&config.server_secret, 32)] {
        if !(minimum..=512).contains(&value.len())
            || !value.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err("Application credentials must be printable ASCII without spaces, at most 512 bytes, and meet their minimum lengths".into());
        }
    }
    if util::equal(&config.public_key, &config.server_secret)
        || util::equal(&config.public_key, &config.admin_password)
        || util::equal(&config.server_secret, &config.admin_password)
    {
        return Err("Browser, server and administrator credentials must be distinct".into());
    }
    Ok(())
}

pub(crate) async fn bootstrap(db: &PgPool, config: &Config) -> Result<()> {
    let mut tx = db.begin().await?;
    let now = util::now();
    // The permanent marker, not the presence of active keys, defines first boot.
    // Concurrent startups wait for the same transaction; a failed import rolls back.
    let first = sqlx::query_scalar::<_, bool>(
        "INSERT INTO application_credential_bootstrap(singleton,imported_at) VALUES(true,$1) ON CONFLICT DO NOTHING RETURNING singleton",
    )
    .bind(now)
    .fetch_optional(&mut *tx)
    .await?;
    if first.is_some() {
        for (kind, label, value) in [
            (Kind::Browser, "Initial browser key", &config.public_key),
            (Kind::Server, "Initial server secret", &config.server_secret),
        ] {
            sqlx::query("INSERT INTO application_credentials(id,kind,label,source,digest,public_key,created_at) VALUES($1,$2,$3,'bootstrap',$4,$5,$6)")
                .bind(util::token("cred_"))
                .bind(kind.as_str())
                .bind(label)
                .bind(util::digest(value))
                .bind(matches!(kind, Kind::Browser).then_some(value))
                .bind(now)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn authenticate(
    app: &App,
    kind: Kind,
    value: &str,
) -> Result<crate::ApplicationCredential> {
    if value.is_empty() || value.len() > 512 {
        return Err(ApiError::unauthorized());
    }
    let id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM application_credentials WHERE digest=$1 AND kind=$2 AND revoked_at IS NULL",
    )
    .bind(util::digest(value))
    .bind(kind.as_str())
    .fetch_optional(&app.db)
    .await?;
    Ok(crate::ApplicationCredential {
        id: id.ok_or_else(ApiError::unauthorized)?,
    })
}

fn detail(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": row.get::<String, _>("id"),
        "kind": row.get::<String, _>("kind"),
        "label": row.get::<String, _>("label"),
        "source": row.get::<String, _>("source"),
        "public_key": row.get::<Option<String>, _>("public_key"),
        "created_at": row.get::<i64, _>("created_at"),
        "revoked_at": row.get::<Option<i64>, _>("revoked_at"),
        "revoked_by": row.get::<Option<String>, _>("revoked_by"),
    })
}
const COLUMNS: &str = "id,kind,label,source,public_key,created_at,revoked_at,revoked_by";

pub async fn list(
    State(app): State<App>,
    query: std::result::Result<Query<admin::List>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(list) = query.map_err(|_| ApiError::invalid("Invalid list query."))?;
    let limit = list.limit()?;
    let mut query = QueryBuilder::<Postgres>::new(format!(
        "SELECT {COLUMNS} FROM application_credentials WHERE true"
    ));
    if let Some(q) = &list.q {
        query
            .push(" AND position(")
            .push_bind(q)
            .push(" in label)>0");
    }
    if let Some((at, id)) = list.cursor()? {
        query
            .push(" AND (created_at,id)<(")
            .push_bind(at)
            .push(",")
            .push_bind(id)
            .push(")");
    }
    query
        .push(" ORDER BY created_at DESC,id DESC LIMIT ")
        .push_bind(limit + 1);
    let rows = query.build().fetch_all(&app.db).await?;
    let next = (rows.len() > limit as usize).then(|| {
        let row = &rows[limit as usize - 1];
        admin::cursor(row.get("created_at"), row.get("id"))
    });
    let items = rows
        .iter()
        .take(limit as usize)
        .map(detail)
        .collect::<Vec<_>>();
    Ok(Json(json!({"items":items,"next_cursor":next})))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Create {
    kind: Kind,
    label: String,
}
pub async fn create(
    State(app): State<App>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Create>,
) -> Result<Json<Value>> {
    if input.label.is_empty()
        || input.label.len() > 128
        || input.label.trim() != input.label
        || input.label.chars().any(char::is_control)
    {
        return Err(ApiError::invalid(
            "A label must contain 1–128 bytes without control characters or surrounding whitespace.",
        ));
    }
    let (mut tx, key, digest, replay) =
        admin::mutation(&app, &headers, "credentials", &json!(input)).await?;
    if let Some(replay) = replay {
        let id = replay["credential_id"]
            .as_str()
            .ok_or_else(ApiError::unavailable)?;
        let row = sqlx::query(&format!(
            "SELECT {COLUMNS} FROM application_credentials WHERE id=$1"
        ))
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        return Ok(Json(json!({
            "credential": detail(&row),
            "secret": null,
            "secret_status": if matches!(input.kind, Kind::Server) {"unrecoverable"} else {"not_applicable"},
        })));
    }
    let value = util::token(match input.kind {
        Kind::Browser => "pk_",
        Kind::Server => "sk_",
    });
    let id = util::token("cred_");
    let row = sqlx::query(&format!(
        "INSERT INTO application_credentials(id,kind,label,source,digest,public_key,created_at) VALUES($1,$2,$3,'administrator',$4,$5,$6) RETURNING {COLUMNS}"
    ))
    .bind(&id)
    .bind(input.kind.as_str())
    .bind(input.label)
    .bind(util::digest(&value))
    .bind(matches!(input.kind, Kind::Browser).then_some(&value))
    .bind(util::now())
    .fetch_one(&mut *tx)
    .await?;
    // Commit only a reference for retries. A response lost after this commit
    // cannot reveal the server secret again, even to the original administrator.
    let _ = admin::finish(tx, key, digest, json!({"credential_id":id})).await?;
    Ok(Json(json!({
        "credential": detail(&row),
        "secret": matches!(input.kind, Kind::Server).then_some(value),
        "secret_status": if matches!(input.kind, Kind::Server) {"revealed"} else {"not_applicable"},
    })))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Revoke {}
pub async fn revoke(
    State(app): State<App>,
    Path(id): Path<String>,
    headers: HeaderMap,
    StrictJson(input): StrictJson<Revoke>,
) -> Result<Json<Value>> {
    util::identifier(&id)?;
    let (mut tx, key, digest, replay) = admin::mutation(
        &app,
        &headers,
        &format!("credentials/{id}/revocations"),
        &json!(input),
    )
    .await?;
    if let Some(response) = replay {
        return Ok(Json(response));
    }
    let row = sqlx::query(&format!(
        "UPDATE application_credentials SET revoked_at=COALESCE(revoked_at,$1),revoked_by='administrator' WHERE id=$2 RETURNING {COLUMNS}"
    ))
    .bind(util::now())
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(ApiError::absent)?;
    admin::finish(tx, key, digest, detail(&row)).await
}

pub(crate) async fn setup(app: &App) -> Result<Value> {
    let row = sqlx::query("SELECT (SELECT public_key FROM application_credentials WHERE kind='browser' AND revoked_at IS NULL ORDER BY created_at,id LIMIT 1) AS public_key,(SELECT id FROM application_credentials WHERE kind='browser' AND revoked_at IS NULL ORDER BY created_at,id LIMIT 1) AS browser_credential_id,COUNT(*) FILTER (WHERE kind='browser') AS browser_count,COUNT(*) FILTER (WHERE kind='server') AS server_count FROM application_credentials WHERE revoked_at IS NULL")
        .fetch_one(&app.db)
        .await?;
    Ok(json!({
        "public_key":row.get::<Option<String>,_>("public_key"),
        "browser_credential_id":row.get::<Option<String>,_>("browser_credential_id"),
        "active_credentials":{"browser":row.get::<i64,_>("browser_count"),"server":row.get::<i64,_>("server_count")},
        "browser_url":app.config.public_url,
        "server_url":app.config.public_url,
        "allowed_origins":app.config.allowed_origins,
        "sdk":{"browser_package":"@krine/browser","server_package":"@krine/server"},
    }))
}
