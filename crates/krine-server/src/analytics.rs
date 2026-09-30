//! Bounded analytical reads over the latest delivered logical history records.
use crate::{
    App,
    error::{ApiError, Result},
    history,
};
use axum::{
    Json,
    extract::{Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

const SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const MAX_RANGE: i64 = 31 * 86_400_000;
const MAX_BUCKETS: i64 = 400;
const SCALARS: &[&str] = &[
    "check",
    "operation_id",
    "outcome",
    "name",
    "reason",
    "provenance",
    "client_id",
    "session_id",
    "user_id",
    "ip",
];
// Never move a mutable time/subject/outcome predicate ahead of replacement.
const QUERY_SETTINGS: &str = "optimize_move_to_prewhere=0,optimize_move_to_prewhere_if_final=0,\
max_execution_time=3,timeout_before_checking_execution_speed=0,timeout_overflow_mode='throw',max_memory_usage=268435456,max_threads=2,\
max_rows_to_read=20000000,max_bytes_to_read=2147483648,read_overflow_mode='throw',\
max_rows_to_group_by=100000,group_by_overflow_mode='throw',\
max_rows_to_sort=100000,sort_overflow_mode='throw',\
max_result_rows=1620,max_result_bytes=1048576,result_overflow_mode='throw',\
output_format_json_quote_64bit_integers=0";

fn scalar_expression(field: &str) -> String {
    // Canonical AST formatting from pinned ClickHouse 26.8. An existing column
    // must have exactly this meaning; a matching function name is insufficient.
    format!(
        "if((JSONType(payload, '{field}') = 'String') AND (length(JSONExtractString(payload, '{field}')) <= 256), JSONExtractString(payload, '{field}'), NULL)"
    )
}

pub(crate) async fn initialize(app: &App) -> Result<()> {
    let mut tx = app.db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('history-activity-scalars-v1',0))")
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO analytical_migrations(name) VALUES('activity_scalars_v1') ON CONFLICT DO NOTHING")
        .execute(&mut *tx).await?;
    let completed: bool = sqlx::query_scalar(
        "SELECT completed FROM analytical_migrations WHERE name='activity_scalars_v1'",
    )
    .fetch_one(&mut *tx)
    .await?;
    if !completed {
        // ADD changes metadata only. In particular, do not issue MATERIALIZE:
        // row-rewrite mutations belong to the retention recovery protocol.
        let additions = SCALARS
            .iter()
            .map(|field| {
                format!(
                    "ADD COLUMN IF NOT EXISTS activity_{field} Nullable(String) MATERIALIZED {}",
                    scalar_expression(field)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        history::clickhouse(
            app,
            &format!("ALTER TABLE {} {additions}", history::table(app, true)),
            vec![],
            None,
        )
        .await?;
        let definition = history::clickhouse(
            app,
            &format!(
                "DESCRIBE TABLE {} FORMAT JSONEachRow",
                history::table(app, true)
            ),
            vec![],
            None,
        )
        .await?;
        let columns = definition
            .lines()
            .map(serde_json::from_str::<Value>)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| ApiError::unavailable())?;
        for field in SCALARS {
            let name = format!("activity_{field}");
            let valid = columns.iter().any(|column| {
                column["name"] == name
                    && column["type"] == "Nullable(String)"
                    && column["default_type"] == "MATERIALIZED"
                    && column["default_expression"] == scalar_expression(field)
            });
            if !valid {
                return Err(ApiError::unavailable());
            }
        }
        sqlx::query(
            "UPDATE analytical_migrations SET completed=true WHERE name='activity_scalars_v1'",
        )
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivityQuery {
    kind: String,
    from: i64,
    to: i64,
    bucket: Option<String>,
    check: Option<String>,
    operation_id: Option<String>,
    outcome: Option<String>,
    entity: Option<String>,
    entity_kind: Option<String>,
    name: Option<String>,
    reason: Option<String>,
    provenance: Option<String>,
}
impl ActivityQuery {
    fn prepare(self) -> Result<(String, history::Filters, i64)> {
        if !["decision", "event"].contains(&self.kind.as_str())
            || self.from < 0
            || self.to > SAFE_INTEGER
            || self.to < self.from
            || self.to - self.from >= MAX_RANGE
        {
            return Err(ApiError::invalid(
                "Analytics requires an inclusive range of at most 31 days.",
            ));
        }
        if (self.kind == "decision" && (self.name.is_some() || self.provenance.is_some()))
            || (self.kind == "event"
                && (self.check.is_some()
                    || self.operation_id.is_some()
                    || self.outcome.is_some()
                    || self.reason.is_some()))
        {
            return Err(ApiError::invalid(
                "The filter does not apply to this Activity view.",
            ));
        }
        let count = |width| self.to / width - self.from / width + 1;
        let width = match self.bucket.as_deref() {
            Some("5m") => 300_000,
            Some("1h") => 3_600_000,
            Some("1d") => 86_400_000,
            None => [300_000, 3_600_000, 86_400_000]
                .into_iter()
                .find(|width| count(*width) <= MAX_BUCKETS)
                .ok_or_else(ApiError::unavailable)?,
            _ => return Err(ApiError::invalid("Invalid analytics bucket.")),
        };
        if count(width) > MAX_BUCKETS {
            return Err(ApiError::invalid(
                "The range exceeds 400 buckets at this interval.",
            ));
        }
        let filters = history::Filters {
            check: self.check,
            operation_id: self.operation_id,
            outcome: self.outcome,
            entity: self.entity,
            entity_kind: self.entity_kind,
            name: self.name,
            reason: self.reason,
            provenance: self.provenance,
            from: Some(self.from),
            to: Some(self.to),
            ..Default::default()
        };
        filters.validate(None)?;
        Ok((self.kind, filters, width))
    }
}

pub async fn activity(
    State(app): State<App>,
    query: std::result::Result<Query<ActivityQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>> {
    let Query(query) = query.map_err(|_| ApiError::invalid("Invalid analytics query."))?;
    let (kind, mut filters, width) = query.prepare()?;
    let _permit = app
        .analytics_queries
        .try_acquire()
        .map_err(|_| ApiError::unavailable())?;
    let retention = history::retention(&app).await?;
    let delivery = sqlx::query("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS observed_at, COUNT(*) AS pending_records, MIN(at) AS oldest_record_accepted_at FROM delivery_outbox WHERE exported_at IS NULL")
        .fetch_one(&app.db).await?;
    let as_of: i64 = delivery.get("observed_at");
    let pending: i64 = delivery.get("pending_records");
    if !(0..=SAFE_INTEGER).contains(&as_of) || !(0..=SAFE_INTEGER).contains(&pending) {
        return Err(ApiError::unavailable());
    }
    let from = filters.from.ok_or_else(ApiError::unavailable)?;
    let to = filters.to.ok_or_else(ApiError::unavailable)?;
    let effective_from = from.max(retention.cutoff);
    let effective_to = to.min(as_of);
    let scope = json!({"kind":kind,"check":filters.check,"operation_id":filters.operation_id,
        "outcome":filters.outcome,"entity":filters.entity,"entity_kind":filters.entity_kind,
        "name":filters.name,"reason":filters.reason,"provenance":filters.provenance});
    let mut response = json!({"schema_version":1,"scope":scope,
        "range":{"from":from,"to":to,"time_basis":"accepted_at","effective_from":null,"effective_to":null,"bucket_ms":width},
        "as_of":as_of,"retention":retention.description(),"visibility":"asynchronous",
        "delivery":{"scope":"installation","observed_at":as_of,"pending_records":pending,
            "oldest_record_accepted_at":delivery.get::<Option<i64>,_>("oldest_record_accepted_at")},
        "totals":null,"buckets":[],"breakdowns":{}});
    if effective_from > effective_to {
        return Ok(Json(response));
    }
    if !history::initialize(&app).await? {
        return Err(ApiError::unavailable());
    }
    initialize(&app).await?;
    filters.from = Some(effective_from);
    filters.to = Some(effective_to);
    let field = filters.validate(None)?;
    let mut params = vec![
        ("param_kind", kind.clone()),
        ("param_bucket", width.to_string()),
    ];
    let (sql, extra) = query_sql(&app, &kind, &filters, field);
    params.extend(extra);
    params.push(("wait_end_of_query", "1".into()));
    params.push(("buffer_size", "1048576".into()));
    let raw = history::clickhouse(&app, &sql, params, None).await?;
    let (totals, buckets, breakdowns) = result(&raw, &kind, effective_from, effective_to, width)?;
    response["range"]["effective_from"] = json!(effective_from);
    response["range"]["effective_to"] = json!(effective_to);
    response["totals"] = totals;
    response["buckets"] = buckets;
    response["breakdowns"] = breakdowns;
    Ok(Json(response))
}

pub(crate) fn query_sql(
    app: &App,
    kind: &str,
    filters: &history::Filters,
    field: Option<&'static str>,
) -> (String, Vec<(&'static str, String)>) {
    let category = if kind == "decision" {
        "if(activity_outcome IN ('ALLOW','DENY','CHALLENGE_REQUIRED'),activity_outcome,NULL)"
    } else {
        "if(activity_provenance IN ('backend','browser'),activity_provenance,NULL)"
    };
    let mut dimensions =
        format!("('bucket',intDiv(at,{{bucket:Int64}})*{{bucket:Int64}},{category})");
    if kind == "decision" {
        dimensions.push_str(",('check',toInt64(0),nullIf(activity_check,'')),('reason',toInt64(0),if(activity_reason IN ('rule_matched','unknown_denied','otherwise','verification_required','verification_failed','verification_expired','verification_unavailable'),activity_reason,NULL))");
    }
    let mut sql = format!(
        "SELECT item.1 AS section,item.2 AS bucket,item.3 AS value,count() AS n \
        FROM (SELECT arrayJoin([{dimensions}]) AS item FROM {} FINAL WHERE kind={{kind:String}}",
        history::table(app, true)
    );
    let mut params = vec![];
    filters.predicates(&mut sql, &mut params, field, true);
    sql.push_str(" ) GROUP BY section,bucket,value \
        QUALIFY section='bucket' OR row_number() OVER (PARTITION BY section ORDER BY n DESC,value ASC NULLS LAST)<=10 \
        ORDER BY section,bucket,n DESC,value ASC NULLS LAST SETTINGS ");
    sql.push_str(QUERY_SETTINGS);
    sql.push_str(" FORMAT JSONEachRow");
    (sql, params)
}

#[derive(Deserialize)]
struct CountRow {
    section: String,
    bucket: i64,
    value: Option<String>,
    n: u64,
}
fn add(target: &mut u64, value: u64) -> Result<()> {
    *target = target
        .checked_add(value)
        .filter(|n| *n <= SAFE_INTEGER as u64)
        .ok_or_else(ApiError::unavailable)?;
    Ok(())
}
fn counts(kind: &str, values: &[u64; 4]) -> Result<Value> {
    let mut total = 0;
    for n in values {
        add(&mut total, *n)?;
    }
    Ok(if kind == "decision" {
        json!({"total":total,"allow":values[0],"deny":values[1],"awaiting_verification":values[2],"unknown":values[3]})
    } else {
        json!({"total":total,"backend":values[0],"browser":values[1],"unknown":values[3]})
    })
}
fn result(raw: &str, kind: &str, from: i64, to: i64, width: i64) -> Result<(Value, Value, Value)> {
    if raw.len() > 1_048_576 {
        return Err(ApiError::unavailable());
    }
    let mut series = BTreeMap::new();
    let mut at = from / width * width;
    while at <= to {
        series.insert(at, [0_u64; 4]);
        at += width;
    }
    let mut total = [0_u64; 4];
    let mut checks = Vec::new();
    let mut reasons = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, line) in raw.lines().enumerate() {
        if index >= 1620 {
            return Err(ApiError::unavailable());
        }
        let row: CountRow = serde_json::from_str(line).map_err(|_| ApiError::unavailable())?;
        if row.n == 0
            || row.n > SAFE_INTEGER as u64
            || !seen.insert((row.section.clone(), row.bucket, row.value.clone()))
        {
            return Err(ApiError::unavailable());
        }
        match row.section.as_str() {
            "bucket" => {
                let index = match (kind, row.value.as_deref()) {
                    (_, None) => 3,
                    ("decision", Some("ALLOW")) | ("event", Some("backend")) => 0,
                    ("decision", Some("DENY")) | ("event", Some("browser")) => 1,
                    ("decision", Some("CHALLENGE_REQUIRED")) => 2,
                    _ => return Err(ApiError::unavailable()),
                };
                let bucket = series
                    .get_mut(&row.bucket)
                    .ok_or_else(ApiError::unavailable)?;
                add(&mut bucket[index], row.n)?;
                add(&mut total[index], row.n)?;
            }
            "check" | "reason" if kind == "decision" && row.bucket == 0 => {
                let items = if row.section == "check" {
                    &mut checks
                } else {
                    &mut reasons
                };
                if items.len() >= 10 || row.value.as_ref().is_some_and(|v| v.len() > 256) {
                    return Err(ApiError::unavailable());
                }
                items.push(row);
            }
            _ => return Err(ApiError::unavailable()),
        }
    }
    let total = counts(kind, &total)?;
    let total_n = total["total"].as_u64().ok_or_else(ApiError::unavailable)?;
    let breakdown = |mut rows: Vec<CountRow>| -> Result<Value> {
        rows.sort_by(|a, b| {
            b.n.cmp(&a.n).then_with(|| match (&a.value, &b.value) {
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (Some(_), None) => std::cmp::Ordering::Less,
                _ => a.value.cmp(&b.value),
            })
        });
        let mut sum = 0;
        for row in &rows {
            add(&mut sum, row.n)?;
        }
        let other = total_n.checked_sub(sum).ok_or_else(ApiError::unavailable)?;
        if (rows.len() < 10 && other != 0) || (total_n != 0 && rows.is_empty()) {
            return Err(ApiError::unavailable());
        }
        Ok(
            json!({"items":rows.into_iter().map(|row|json!({"value":row.value,"count":row.n})).collect::<Vec<_>>(),"other_count":other}),
        )
    };
    let breakdowns = if kind == "decision" {
        json!({"checks":breakdown(checks)?,"reasons":breakdown(reasons)?})
    } else {
        json!({})
    };
    let buckets = series.into_iter().map(|(at, values)| Ok(json!({"from":at.max(from),"to":(at+width-1).min(to),"counts":counts(kind,&values)?})))
        .collect::<Result<Vec<_>>>()?;
    Ok((total, json!(buckets), breakdowns))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn prepare(query: &str) -> Result<(String, history::Filters, i64)> {
        let uri = format!("/v1/admin/analytics/activity?{query}")
            .parse()
            .unwrap();
        Query::<ActivityQuery>::try_from_uri(&uri)
            .map_err(|_| ApiError::invalid("query"))?
            .0
            .prepare()
    }
    #[test]
    fn inclusive_ranges_choose_bounded_aligned_buckets() {
        assert_eq!(
            prepare("kind=decision&from=1&to=120000000").unwrap().2,
            3_600_000
        );
        assert_eq!(
            prepare("kind=event&from=0&to=119999999&bucket=5m")
                .unwrap()
                .2,
            300_000
        );
        assert!(prepare("kind=event&from=1&to=120000000&bucket=5m").is_err());
        assert!(prepare("kind=event&from=0&to=2678399999").is_ok());
        assert!(prepare("kind=event&from=0&to=2678400000").is_err());
        for query in [
            "kind=event&from=-1&to=0",
            "kind=event&from=2&to=1",
            "kind=event&from=9007199254740992&to=9007199254740992",
            "kind=event&from=0&to=1&bucket=second",
            "kind=other&from=0&to=1",
        ] {
            assert!(prepare(query).is_err(), "{query}");
        }
    }
    #[test]
    fn selectors_are_unique_applicable_and_preserve_exact_identifiers() {
        for query in [
            "kind=event&from=0&to=1&from=0",
            "kind=event&kind=decision&from=0&to=1",
            "kind=event&from=0&to=1&entity=x&entity=y",
            "kind=event&from=0&to=1&extra=x",
            "kind=event&from=0&to=1&entity_kind=user",
            "kind=event&from=0&to=1&check=a",
            "kind=decision&from=0&to=1&provenance=backend",
            "kind=event&from=0&to=1&provenance=other",
        ] {
            assert!(prepare(query).is_err(), "{query}");
        }
        let (_, filters, _) =
            prepare("kind=event&from=0&to=1&entity_kind=user&entity=%20%2E%2E%2F%252e%C2%A0%20")
                .unwrap();
        assert_eq!(filters.entity.as_deref(), Some(" ../%2e\u{a0} "));
    }
    #[test]
    fn result_zero_fills_only_observed_buckets_and_preserves_edge_bounds() {
        let raw = "{\"section\":\"bucket\",\"bucket\":300000,\"value\":\"backend\",\"n\":2}\n";
        let (totals, buckets, breakdowns) = result(raw, "event", 299999, 600000, 300000).unwrap();
        assert_eq!(totals["total"], 2);
        assert_eq!(buckets.as_array().unwrap().len(), 3);
        assert_eq!(
            buckets[0],
            json!({"from":299999,"to":299999,"counts":{"total":0,"backend":0,"browser":0,"unknown":0}})
        );
        assert_eq!(buckets[2]["to"], 600000);
        assert_eq!(breakdowns, json!({}));
    }
    #[test]
    fn exact_totals_reconcile_unknown_and_top_breakdowns() {
        let mut rows = vec![
            json!({"section":"bucket","bucket":0,"value":"DENY","n":10}),
            json!({"section":"bucket","bucket":0,"value":null,"n":3}),
            json!({"section":"reason","bucket":0,"value":null,"n":13}),
        ];
        for n in 0..10 {
            rows.push(json!({"section":"check","bucket":0,"value":format!("c{n}"),"n":1}));
        }
        let raw = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let (totals, _, breakdowns) = result(&raw, "decision", 0, 0, 300000).unwrap();
        assert_eq!(
            totals,
            json!({"total":13,"allow":0,"deny":10,"awaiting_verification":0,"unknown":3})
        );
        assert_eq!(breakdowns["checks"]["other_count"], 3);
        assert_eq!(breakdowns["reasons"]["items"][0]["value"], Value::Null);
    }
    #[test]
    fn malformed_or_partial_aggregates_never_become_successful_zeroes() {
        let bucket = json!({"section":"bucket","bucket":0,"value":"DENY","n":2}).to_string();
        for raw in [
            "garbage".into(),
            bucket.clone(),
            format!("{bucket}\n{bucket}"),
            json!({"section":"bucket","bucket":0,"value":"made_up","n":2}).to_string(),
            json!({"section":"bucket","bucket":900000,"value":"backend","n":2}).to_string(),
            json!({"section":"bucket","bucket":0,"value":"backend","n":9007199254740992_u64})
                .to_string(),
        ] {
            assert!(result(&raw, "decision", 0, 100, 300000).is_err(), "{raw}");
        }
    }
}
