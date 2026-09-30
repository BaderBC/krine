//! Directly attributed activity; relationships never expand this scope implicitly.
use crate::{
    App, addressing, admin, analytics,
    error::{ApiError, Result},
    history, util,
};
use axum::{
    Json,
    extract::{Query, State},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_BYTES: usize = 2_097_152;
const EVENT_FIELDS: &[&str] = &[
    "event_id",
    "name",
    "accepted_at",
    "occurred_at",
    "client_id",
    "session_id",
    "user_id",
    "ip",
    "provenance",
    "sample_data",
];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TimelineQuery {
    kind: String,
    id: String,
    from: i64,
    to: i64,
    limit: Option<i64>,
    cursor: Option<String>,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    at: i64,
    kind: String,
    id: String,
}
impl Position {
    fn encode(&self, scope: &str) -> Result<String> {
        Ok(URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&(1, self.at, &self.kind, &self.id, scope))
                .map_err(|_| ApiError::unavailable())?,
        ))
    }
}

struct Prepared {
    filters: history::Filters,
    field: &'static str,
    limit: i64,
    scope: String,
    after: Option<Position>,
}

impl TimelineQuery {
    fn prepare(&self) -> Result<Prepared> {
        addressing::entity_key(self.kind.clone(), self.id.clone())?;
        if self.from < 0
            || self.to > analytics::SAFE_INTEGER
            || self.to < self.from
            || self.to - self.from >= analytics::MAX_RANGE
        {
            return Err(ApiError::invalid(
                "Timeline requires an inclusive range of at most 31 days.",
            ));
        }
        let limit = admin::List {
            limit: self.limit,
            ..Default::default()
        }
        .limit()?;
        let filters = history::Filters {
            entity: Some(self.id.clone()),
            entity_kind: Some(self.kind.clone()),
            from: Some(self.from),
            to: Some(self.to),
            ..Default::default()
        };
        let field = filters.validate(None)?.ok_or_else(ApiError::unavailable)?;
        let scope = util::digest(
            serde_json::to_vec(&json!({"timeline":1,"kind":self.kind,"id":self.id,
                "from":self.from,"to":self.to}))
            .map_err(|_| ApiError::unavailable())?,
        );
        let after = self.position(&scope)?;
        Ok(Prepared {
            filters,
            field,
            limit,
            scope,
            after,
        })
    }

    fn position(&self, scope: &str) -> Result<Option<Position>> {
        let Some(cursor) = &self.cursor else {
            return Ok(None);
        };
        let invalid = || ApiError::invalid("The cursor does not match this timeline.");
        if cursor.len() > 1024 {
            return Err(invalid());
        }
        let raw = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| invalid())?;
        let (version, at, kind, id, bound): (u8, i64, String, String, String) =
            serde_json::from_slice(&raw).map_err(|_| invalid())?;
        if version != 1
            || bound != scope
            || at < self.from
            || at > self.to
            || !["event", "decision"].contains(&kind.as_str())
            || id.len() > 256
        {
            return Err(invalid());
        }
        let logical_id = id.strip_prefix(&format!("{kind}:")).ok_or_else(invalid)?;
        util::identifier(logical_id).map_err(|_| invalid())?;
        Ok(Some(Position { at, kind, id }))
    }
}

pub(crate) async fn timeline(
    State(app): State<App>,
    query: std::result::Result<Query<TimelineQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid timeline query."))?;
    let prepared = query.prepare()?;
    let permit = app
        .analytics_queries
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::unavailable())?;
    app.analytical_reads
        .clone()
        .run(permit, timeline_read(app, query, prepared))
        .await
}

async fn timeline_read(app: App, query: TimelineQuery, prepared: Prepared) -> Result<Json<Value>> {
    let Prepared {
        mut filters,
        field,
        limit,
        scope,
        after,
    } = prepared;
    let retention = history::retention(&app).await?;
    let (as_of, delivery) = analytics::delivery(&app).await?;
    let from = query.from.max(retention.cutoff);
    let to = query.to.min(as_of);
    let mut response = json!({"schema_version":1,"scope":{"kind":query.kind,"id":query.id},
        "range":{"from":query.from,"to":query.to,"time_basis":"accepted_at","effective_from":null,"effective_to":null},
        "as_of":as_of,"retention":retention.description(),"visibility":"asynchronous","delivery":delivery,
        "items":[],"next_cursor":null});
    if from > to {
        return Ok(Json(response));
    }
    if !history::initialize(&app).await? {
        return Err(ApiError::unavailable());
    }
    analytics::initialize(&app).await?;
    filters.from = Some(from);
    filters.to = Some(to);
    let (sql, params) = query_sql(&app, &filters, field, limit, after.as_ref());
    let raw = history::clickhouse(&app, &sql, params, None).await?;
    let (items, next) = page(&raw, &query, from, to, limit, &scope, after.as_ref())?;
    response["range"]["effective_from"] = json!(from);
    response["range"]["effective_to"] = json!(to);
    response["items"] = json!(items);
    response["next_cursor"] = json!(next);
    Ok(Json(response))
}

fn query_sql(
    app: &App,
    filters: &history::Filters,
    field: &'static str,
    limit: i64,
    after: Option<&Position>,
) -> (String, Vec<(&'static str, String)>) {
    let mut sql = "SELECT at,kind,id".to_owned();
    history::decision_projection(&mut sql);
    for field in ["event_id", "name", "occurred_at", "provenance"] {
        sql.push_str(&format!(
            ",JSONExtractRaw(payload,'{field}') AS summary_{field}"
        ));
    }
    sql.push_str(&format!(
        " FROM {} FINAL WHERE kind IN ('event','decision')",
        history::table(app, true)
    ));
    let mut params = vec![
        ("param_limit", (limit + 1).to_string()),
        ("wait_end_of_query", "1".into()),
        ("buffer_size", MAX_BYTES.to_string()),
    ];
    filters.predicates(&mut sql, &mut params, Some(field), true);
    if let Some(after) = after {
        sql.push_str(
            " AND (at,kind,id)<({cursor_at:Int64},{cursor_kind:String},{cursor_id:String})",
        );
        params.push(("param_cursor_at", after.at.to_string()));
        params.push(("param_cursor_kind", after.kind.clone()));
        params.push(("param_cursor_id", after.id.clone()));
    }
    sql.push_str(" ORDER BY at DESC,kind DESC,id DESC LIMIT {limit:UInt32} SETTINGS ");
    sql.push_str(analytics::QUERY_BUDGET);
    sql.push_str(",max_result_rows=101,max_result_bytes=2097152,result_overflow_mode='throw' FORMAT JSONEachRow");
    (sql, params)
}

fn event_summary(row: &Value) -> Result<Value> {
    let mut summary = serde_json::Map::new();
    for field in EVENT_FIELDS {
        let raw = row[format!("summary_{field}")]
            .as_str()
            .ok_or_else(ApiError::unavailable)?;
        // Browser and older events may omit occurrence, subject or provenance
        // facts. Null preserves that absence without inferring authority.
        let value: Value = if raw.is_empty() {
            Value::Null
        } else {
            serde_json::from_str(raw).map_err(|_| ApiError::unavailable())?
        };
        match *field {
            "accepted_at" | "occurred_at" => {
                if !value.is_null()
                    && !value
                        .as_i64()
                        .is_some_and(|at| (0..=analytics::SAFE_INTEGER).contains(&at))
                {
                    return Err(ApiError::unavailable());
                }
            }
            "sample_data" => {
                if value.is_null() {
                    continue;
                }
                if !value.is_object() {
                    return Err(ApiError::unavailable());
                }
            }
            _ => {
                if !value.is_null() && !value.as_str().is_some_and(|v| v.len() <= 256) {
                    return Err(ApiError::unavailable());
                }
            }
        }
        summary.insert((*field).into(), value);
    }
    Ok(Value::Object(summary))
}

fn page(
    raw: &str,
    query: &TimelineQuery,
    from: i64,
    to: i64,
    limit: i64,
    scope: &str,
    after: Option<&Position>,
) -> Result<(Vec<Value>, Option<String>)> {
    if raw.len() > MAX_BYTES {
        return Err(ApiError::unavailable());
    }
    let mut rows = Vec::new();
    let mut positions = Vec::new();
    for line in raw.lines() {
        if rows.len() > limit as usize {
            return Err(ApiError::unavailable());
        }
        let row: Value = serde_json::from_str(line).map_err(|_| ApiError::unavailable())?;
        let position = Position {
            at: row["at"].as_i64().ok_or_else(ApiError::unavailable)?,
            kind: row["kind"]
                .as_str()
                .ok_or_else(ApiError::unavailable)?
                .into(),
            id: row["id"].as_str().ok_or_else(ApiError::unavailable)?.into(),
        };
        let logical_id = position
            .id
            .strip_prefix(&format!("{}:", position.kind))
            .ok_or_else(ApiError::unavailable)?;
        let summary = match position.kind.as_str() {
            "decision" => history::summary(&row)?,
            "event" => event_summary(&row)?,
            _ => return Err(ApiError::unavailable()),
        };
        let id_field = if position.kind == "decision" {
            "decision_id"
        } else {
            "event_id"
        };
        let subject_field = match query.kind.as_str() {
            "client" => "client_id",
            "session" => "session_id",
            "user" => "user_id",
            "ip" => "ip",
            _ => return Err(ApiError::unavailable()),
        };
        if util::identifier(logical_id).is_err()
            || position.at < from
            || position.at > to
            || after.is_some_and(|after| position >= *after)
            || positions.last().is_some_and(|last| position >= *last)
            || summary[id_field] != logical_id
            || summary["accepted_at"] != position.at
            || summary[subject_field] != query.id
        {
            return Err(ApiError::unavailable());
        }
        rows.push(json!({"kind":position.kind,"id":logical_id,"accepted_at":position.at,"summary":summary}));
        positions.push(position);
    }
    let next = if rows.len() > limit as usize {
        rows.truncate(limit as usize);
        Some(positions[limit as usize - 1].encode(scope)?)
    } else {
        None
    };
    Ok((rows, next))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> TimelineQuery {
        TimelineQuery {
            kind: "user".into(),
            id: " Alice\\x41 /%2e 界 ".into(),
            from: 100,
            to: 200,
            limit: Some(1),
            cursor: None,
        }
    }
    fn event_row(id: &str, at: i64, subject: &str) -> Value {
        let mut row = json!({"at":at,"kind":"event","id":format!("event:{id}")});
        for field in EVENT_FIELDS {
            row[format!("summary_{field}")] = json!(
                match *field {
                    "event_id" => json!(id),
                    "name" => json!("login"),
                    "accepted_at" => json!(at),
                    "user_id" => json!(subject),
                    _ => Value::Null,
                }
                .to_string()
            );
        }
        row
    }
    fn page_for(raw: &str, query: &TimelineQuery) -> Result<(Vec<Value>, Option<String>)> {
        let prepared = query.prepare()?;
        page(
            raw,
            query,
            query.from,
            query.to,
            prepared.limit,
            &prepared.scope,
            prepared.after.as_ref(),
        )
    }

    #[test]
    fn selectors_preserve_exact_subject_and_reject_ambiguous_or_unbounded_requests() {
        let parsed = Query::<TimelineQuery>::try_from_uri(
            &"/x?kind=user&id=%20Alice%5Cx41%20%2F%252e%20%E7%95%8C%20&from=100&to=200&limit=1"
                .parse()
                .unwrap(),
        )
        .unwrap()
        .0;
        assert_eq!(parsed.id, query().id);
        let prepared = parsed.prepare().unwrap();
        assert_eq!(prepared.field, "user_id");
        assert_eq!(
            prepared.filters.entity.as_deref(),
            Some(query().id.as_str())
        );
        for suffix in [
            "&kind=client",
            "&id=other",
            "&from=100",
            "&to=200",
            "&limit=2",
            "&unknown=x",
        ] {
            assert!(
                Query::<TimelineQuery>::try_from_uri(
                    &format!("/x?kind=user&id=u&from=100&to=200&limit=1{suffix}")
                        .parse()
                        .unwrap()
                )
                .is_err()
            );
        }
        for (from, to) in [
            (-1, 100),
            (200, 100),
            (0, analytics::MAX_RANGE),
            (analytics::SAFE_INTEGER, analytics::SAFE_INTEGER + 1),
        ] {
            assert!(
                TimelineQuery {
                    from,
                    to,
                    ..query()
                }
                .prepare()
                .is_err()
            );
        }
        for limit in [0, 101, i64::MAX] {
            assert!(
                TimelineQuery {
                    limit: Some(limit),
                    ..query()
                }
                .prepare()
                .is_err()
            );
        }
        for (kind, id) in [
            ("users", "u"),
            ("user", ""),
            ("user", "a\nb"),
            ("client", "a/b"),
            ("ip", "unparseable"),
        ] {
            assert!(
                TimelineQuery {
                    kind: kind.into(),
                    id: id.into(),
                    ..query()
                }
                .prepare()
                .is_err()
            );
        }
        assert!(
            TimelineQuery {
                from: 0,
                to: analytics::MAX_RANGE - 1,
                ..query()
            }
            .prepare()
            .is_ok()
        );
    }

    #[test]
    fn cursor_binds_requested_subject_interval_version_and_validated_position() {
        let original = query();
        let scope = original.prepare().unwrap().scope;
        let cursor = Position {
            at: 150,
            kind: "event".into(),
            id: "event:e".into(),
        }
        .encode(&scope)
        .unwrap();
        assert!(
            TimelineQuery {
                cursor: Some(cursor.clone()),
                limit: Some(100),
                ..query()
            }
            .prepare()
            .is_ok()
        );
        for altered in [
            TimelineQuery {
                id: "AliceA".into(),
                ..query()
            },
            TimelineQuery {
                kind: "session".into(),
                id: "s".into(),
                ..query()
            },
            TimelineQuery {
                from: 101,
                ..query()
            },
            TimelineQuery { to: 201, ..query() },
        ] {
            assert!(
                TimelineQuery {
                    cursor: Some(cursor.clone()),
                    ..altered
                }
                .prepare()
                .is_err()
            );
        }
        for (version, at, kind, id) in [
            (2, 150, "event", "event:e"),
            (1, 99, "event", "event:e"),
            (1, 201, "event", "event:e"),
            (1, 150, "other", "other:e"),
            (1, 150, "event", "decision:e"),
            (1, 150, "event", "event:"),
            (1, 150, "event", "event:a/b"),
        ] {
            let cursor = URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&(version, at, kind, id, &scope)).unwrap());
            assert!(
                TimelineQuery {
                    cursor: Some(cursor),
                    ..query()
                }
                .prepare()
                .is_err()
            );
        }
        for cursor in [
            "bad-base64!".to_owned(),
            "x".repeat(1025),
            URL_SAFE_NO_PAD.encode(b"[150,\"event:e\"]"),
        ] {
            assert!(
                TimelineQuery {
                    cursor: Some(cursor),
                    ..query()
                }
                .prepare()
                .is_err()
            );
        }
    }

    #[test]
    fn page_preserves_unknown_event_facts_and_bounded_lookahead() {
        let query = query();
        let mut first = event_row("z", 150, &query.id);
        first["summary_provenance"] = json!("\"legacy\"");
        first["summary_occurred_at"] = json!("7");
        first["summary_client_id"] = json!("");
        first["summary_sample_data"] = json!(r#"{"dataset_id":"fixture","generator_version":"1"}"#);
        let second = event_row("a", 150, &query.id);
        let (items, next) = page_for(&format!("{first}\n{second}\n"), &query).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["accepted_at"], 150);
        assert_eq!(items[0]["summary"]["occurred_at"], 7);
        assert_eq!(items[0]["summary"]["provenance"], "legacy");
        assert!(items[0]["summary"]["client_id"].is_null());
        assert_eq!(items[0]["summary"]["sample_data"]["dataset_id"], "fixture");
        assert!(items[0]["summary"].get("properties").is_none());
        let (items, next) = page_for(
            &second.to_string(),
            &TimelineQuery {
                cursor: next,
                ..query
            },
        )
        .unwrap();
        assert_eq!(items[0]["id"], "a");
        assert!(items[0]["summary"]["provenance"].is_null());
        assert!(items[0]["summary"].get("sample_data").is_none());
        assert!(next.is_none());
    }

    #[test]
    fn page_rejects_partial_malformed_out_of_scope_and_unordered_results() {
        let query = query();
        let valid = event_row("e", 150, &query.id);
        for (field, value) in [
            ("at", json!(99)),
            ("kind", json!("other")),
            ("id", json!("event:other")),
            ("summary_accepted_at", json!("149")),
            ("summary_user_id", json!("\"other\"")),
            ("summary_provenance", json!("{}")),
            ("summary_occurred_at", json!("-1")),
            ("summary_sample_data", json!("[]")),
            ("summary_name", json!(json!("x".repeat(257)).to_string())),
        ] {
            let mut malformed = valid.clone();
            malformed[field] = value;
            assert!(page_for(&malformed.to_string(), &query).is_err(), "{field}");
        }
        for raw in [
            "not-json".into(),
            format!("{valid}\n{valid}"),
            format!("{valid}\n{{broken"),
            " ".repeat(MAX_BYTES + 1),
        ] {
            assert!(page_for(&raw, &query).is_err());
        }
        let too_many = (0..3)
            .rev()
            .map(|n| event_row(&format!("e{n}"), 150, &query.id).to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(page_for(&too_many, &query).is_err());
        assert!(page_for("", &query).unwrap().0.is_empty());
    }
}
