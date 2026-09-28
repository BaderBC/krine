use crate::{
    App, admin,
    error::{ApiError, Result},
    events, history, projection, util,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use krine_core::{MetricObservation, Observation, Provenance, Scalar, Snapshot, UnknownReason};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{Postgres, QueryBuilder, Row};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EntityQuery {
    associations_cursor: Option<String>,
}
pub async fn detail(
    State(app): State<App>,
    Path((kind, id)): Path<(String, String)>,
    query: std::result::Result<Query<EntityQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    if !["client", "session", "user", "ip"].contains(&kind.as_str()) {
        return Err(ApiError::absent());
    }
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid entity query."))?;
    let cursor = admin::List {
        cursor: query.associations_cursor,
        ..Default::default()
    }
    .cursor()?;
    let mut tx = app.db.begin().await?;
    let entity =
        sqlx::query("SELECT first_seen,client_id,metadata FROM entities WHERE kind=$1 AND id=$2")
            .bind(&kind)
            .bind(&id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or_else(ApiError::absent)?;
    let first_seen: i64 = entity.get("first_seen");
    let metadata: Value = entity.get("metadata");
    let client = if kind == "client" {
        Some(id.clone())
    } else {
        entity.get::<Option<String>, _>("client_id")
    };
    let ready = match projection::locked_ready(&app, &mut tx).await {
        Ok(ready) => Some(ready),
        Err(error) if error.dependency == Some("valkey") => None,
        Err(error) => return Err(error),
    };
    let started = std::time::Instant::now();
    let at = util::now();
    let mut snapshot = Snapshot::default();
    for metric in krine_core::METRICS {
        snapshot.metrics.insert(
            metric.name.into(),
            MetricObservation {
                version: metric.version,
                state: Observation::unknown(UnknownReason::Missing),
                provenance: Provenance {
                    source: metric.source.into(),
                    observed_at: at as u64,
                },
            },
        );
    }
    if let Some(client) = &client {
        let client_first: i64 =
            sqlx::query_scalar("SELECT first_seen FROM entities WHERE kind='client' AND id=$1")
                .bind(client)
                .fetch_one(&mut *tx)
                .await?;
        known(
            &mut snapshot,
            "client.age_seconds",
            Scalar::Number(((at - client_first).max(0) / 1000) as f64),
        );
        let users:i64=sqlx::query_scalar("SELECT COUNT(DISTINCT user_id) FROM associations WHERE client_id=$1 AND revoked_at IS NULL AND created_at>=$2").bind(client).bind(at-2_592_000_000).fetch_one(&mut *tx).await?;
        known(
            &mut snapshot,
            "client.user_count_30d",
            Scalar::Number(users as f64),
        );
    }
    if kind == "session" && at - first_seen <= 86_400_000 {
        known(
            &mut snapshot,
            "session.age_seconds",
            Scalar::Number(((at - first_seen).max(0) / 1000) as f64),
        );
        if let Some(value) = metadata["signals"]["webdriver"].as_bool() {
            known(
                &mut snapshot,
                "browser.automation_observed",
                Scalar::Boolean(value),
            );
        }
    }
    let hot = match kind.as_str() {
        "session" => Some(("session.event_count_5m", "session_id")),
        "ip" => Some(("ip.event_count_5m", "ip")),
        _ => None,
    };
    if let Some((metric, key)) = hot {
        let value = match &ready {
            Some(ready) => projection::count(&app, ready, key, &id, at).await,
            None => Err(ApiError::valkey()),
        };
        let valid = match &ready {
            Some(ready) => projection::validate(&app, ready).await.is_ok(),
            None => false,
        };
        if let Ok(value) = value
            && valid
            && started.elapsed()
                <= std::time::Duration::from_millis(projection::SNAPSHOT_BUDGET_MS as u64)
        {
            known(&mut snapshot, metric, Scalar::Number(value as f64));
        } else if let Some(observation) = snapshot.metrics.get_mut(metric) {
            observation.state = Observation::unknown(UnknownReason::Unavailable);
        }
    }
    krine_core::derive_metrics(&mut snapshot, at as u64);
    let mut relations = QueryBuilder::<Postgres>::new("SELECT * FROM associations WHERE ");
    if let Some(client) = &client {
        relations.push("client_id=").push_bind(client);
    } else if kind == "user" {
        relations.push("user_id=").push_bind(&id);
    } else if kind == "ip" {
        relations
            .push("client_id IN (SELECT client_id FROM observed_ips WHERE ip=")
            .push_bind(&id)
            .push(" AND last_seen>=")
            .push_bind(at - 2_592_000_000)
            .push(")");
    } else {
        relations.push("false");
    }
    if let Some((at, id)) = cursor {
        relations
            .push(" AND (created_at,id)<(")
            .push_bind(at)
            .push(",")
            .push_bind(id)
            .push(")");
    }
    relations.push(" ORDER BY created_at DESC,id DESC LIMIT 101");
    let rows = relations.build().fetch_all(&mut *tx).await?;
    let next =
        (rows.len() > 100).then(|| admin::cursor(rows[99].get("created_at"), rows[99].get("id")));
    let associations = rows
        .iter()
        .take(100)
        .map(events::association_json)
        .collect::<Vec<_>>();
    tx.commit().await?;
    let (decisions, events) = tokio::try_join!(
        history::recent(&app, "decision", &kind, &id),
        history::recent(&app, "event", &kind, &id)
    )?;
    Ok(Json(
        json!({"kind":kind,"id":id,"first_seen":first_seen,"metadata":metadata,"metrics":snapshot.metrics,"associations":associations,"associations_next_cursor":next,"recent_decisions":decisions,"recent_events":events}),
    ))
}
fn known(snapshot: &mut Snapshot, name: &str, value: Scalar) {
    if let Some(metric) = snapshot.metrics.get_mut(name) {
        metric.state = Observation::Known { value };
    }
}
