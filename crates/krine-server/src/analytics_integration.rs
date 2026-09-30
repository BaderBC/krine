//! Real HTTP, revision and old-part migration regressions; owned fixture only.
use super::*;

async fn fixture() -> Fixture {
    let f = Fixture::new().await;
    eprintln!("analytics fixture owned schema/tables: {}", f.schema);
    f
}
async fn clock(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(&f.app.db)
        .await
        .unwrap()
}
fn decision(id: &str, at: i64, outcome: &str, check: &str, user: &str) -> Value {
    json!({"decision_id":id,"operation_id":format!("op_{id}"),"check":check,"policy_version":1,
        "outcome":outcome,"reason":if outcome=="CHALLENGE_REQUIRED"{"verification_required"}else{"otherwise"},
        "accepted_at":at,"completed_at":if outcome=="CHALLENGE_REQUIRED"{Value::Null}else{json!(at+100)},
        "client_id":"cli_a","session_id":"ses_a","user_id":user,"ip":"192.0.2.1","source":"evaluation","reason_summary":null})
}
fn event(id: &str, at: i64, user: &str, provenance: &str) -> Value {
    json!({"event_id":id,"name":"activity","accepted_at":at,"user_id":user,"provenance":provenance,"properties":{}})
}
async fn insert(f: &Fixture, kind: &str, id: &str, at: i64, revision: i64, payload: Value) {
    history::clickhouse(&f.app,&format!("INSERT INTO {} (kind,id,at,payload,revision) FORMAT JSONEachRow",history::table(&f.app,true)),vec![],
        Some(format!("{}\n",json!({"kind":kind,"id":format!("{kind}:{id}"),"at":at,"revision":revision,"payload":payload.to_string()})))).await.unwrap();
}
async fn analytics(f: &Fixture, kind: &str, from: i64, to: i64, extra: &[(&str, &str)]) -> Value {
    json_ok(
        f.admin(Method::GET, "/analytics/activity")
            .query(&[
                ("kind", kind),
                ("from", &from.to_string()),
                ("to", &to.to_string()),
            ])
            .query(extra),
    )
    .await
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_old_parts_upgrade_duplicates_and_late_revisions_are_exact() {
    let f = fixture().await;
    let at = clock(&f).await - 600_000;
    history::clickhouse(&f.app,&format!("CREATE TABLE {} (kind LowCardinality(String),id String,at Int64,payload String,revision UInt64) ENGINE=ReplacingMergeTree(revision) ORDER BY(kind,id)",history::table(&f.app,true)),vec![],None).await.unwrap();
    let mut denied = decision("d1", at, "DENY", "..", " Alice\u{a0} ");
    denied["sample_data"] = json!({"dataset_id":"fixture","generator_version":"1"});
    insert(&f, "decision", "d1", at, 3, denied.clone()).await;
    insert(
        &f,
        "decision",
        "d2",
        at + 300_000,
        1,
        decision("d2", at + 300_000, "ALLOW", "check_b", "other"),
    )
    .await;
    // Migration must work on payload-only parts and not schedule row mutations.
    let first = analytics(&f, "decision", at - 1, at + 300_001, &[]).await;
    assert_eq!(first["totals"]["total"], 2);
    assert_eq!(first["totals"]["deny"], 1);
    assert_eq!(first["totals"]["allow"], 1);
    insert(
        &f,
        "decision",
        "d1",
        at,
        1,
        decision("d1", at, "CHALLENGE_REQUIRED", "..", " Alice\u{a0} "),
    )
    .await;
    insert(&f, "decision", "d1", at, 3, denied).await;
    let after = analytics(&f, "decision", at - 1, at + 300_001, &[]).await;
    assert_eq!(after["totals"], first["totals"]);
    let filtered = analytics(
        &f,
        "decision",
        at - 1,
        at + 300_001,
        &[
            ("entity_kind", "user"),
            ("entity", " Alice\u{a0} "),
            ("outcome", "DENY"),
            ("reason", "otherwise"),
        ],
    )
    .await;
    assert_eq!(filtered["totals"]["total"], 1);
    assert_eq!(filtered["scope"]["entity"], " Alice\u{a0} ");
    assert_eq!(
        analytics(
            &f,
            "decision",
            at - 1,
            at + 300_001,
            &[("outcome", "CHALLENGE_REQUIRED")]
        )
        .await["totals"]["total"],
        0
    );
    let page = json_ok(
        f.admin(Method::GET, "/activity/decisions")
            .query(&[("reason", "otherwise"), ("outcome", "DENY")]),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["sample_data"]["dataset_id"], "fixture");
    let absent = json_ok(
        f.admin(Method::GET, "/activity/decisions")
            .query(&[("outcome", "ALLOW")]),
    )
    .await;
    assert!(absent["items"][0].get("sample_data").is_none());
    sqlx::query("DELETE FROM analytical_migrations WHERE name='activity_scalars_v1'")
        .execute(&f.app.db)
        .await
        .unwrap();
    assert_eq!(
        analytics(&f, "decision", at - 1, at + 300_001, &[]).await["totals"],
        first["totals"]
    );
    let mutations=history::clickhouse(&f.app,"SELECT count() AS n FROM system.mutations WHERE database='krine' AND table={table:String} FORMAT JSONEachRow",vec![("param_table",history::table(&f.app,true))],None).await.unwrap();
    assert!(
        mutations.contains("\"0\"") || mutations.contains(":0"),
        "{mutations}"
    );
    eprintln!("contract example: {after}");
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_reused_event_identity_and_typed_filters_match_lists() {
    let f = fixture().await;
    history::initialize(&f.app).await.unwrap();
    let at = clock(&f).await - 600_000;
    insert(
        &f,
        "event",
        "same",
        at,
        1,
        event("same", at, "old", "backend"),
    )
    .await;
    insert(
        &f,
        "event",
        "same",
        at + 300_000,
        1,
        event("same", at + 300_000, "new", "browser"),
    )
    .await;
    let old = analytics(&f, "event", at, at + 1, &[]).await;
    assert_eq!(
        old["totals"]["total"], 0,
        "later timestamp must win before time filtering"
    );
    let current = analytics(&f, "event", at, at + 300_000, &[("provenance", "browser")]).await;
    assert_eq!(
        current["totals"],
        json!({"total":1,"backend":0,"browser":1,"unknown":0})
    );
    let page = json_ok(f.admin(Method::GET, "/activity/events").query(&[
        ("provenance", "browser"),
        ("entity_kind", "user"),
        ("entity", "new"),
    ]))
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    let mut collision = event("collision", at + 300_000, "someone", "backend");
    collision["client_id"] = json!("new");
    insert(&f, "event", "collision", at + 300_000, 1, collision).await;
    assert_eq!(
        analytics(&f, "event", at, at + 300_000, &[("entity", "new")]).await["totals"]["total"],
        2
    );
    assert_eq!(
        analytics(
            &f,
            "event",
            at,
            at + 300_000,
            &[("entity", "new"), ("entity_kind", "user")]
        )
        .await["totals"]["total"],
        1
    );
    let first = json_ok(f.admin(Method::GET, "/activity/events?limit=1")).await;
    let cursor = first["next_cursor"].as_str().unwrap();
    rejected(
        f.admin(Method::GET, "/activity/events")
            .query(&[("cursor", cursor), ("provenance", "browser")]),
        "invalid_input",
    )
    .await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_unknown_dimensions_and_top_ties_reconcile_exactly() {
    let f = fixture().await;
    history::initialize(&f.app).await.unwrap();
    let at = clock(&f).await - 1000;
    for index in 0..16 {
        let id = format!("dimension_{index}");
        let mut value = decision(&id, at, "ALLOW", &format!("c{index:02}"), "u");
        if (12..14).contains(&index) {
            value["check"] = json!("hot");
            value["outcome"] = json!("DENY");
        } else if index >= 14 {
            value["check"] = json!({"unreadable":true});
            value["outcome"] = if index == 14 {
                json!("unrecognized")
            } else {
                Value::Null
            };
            value["reason"] = json!("unrecognized");
        }
        insert(&f, "decision", &id, at, 1, value).await;
    }
    let observed = analytics(&f, "decision", at, at, &[]).await;
    assert_eq!(
        observed["totals"],
        json!({"total":16,"allow":12,"deny":2,"awaiting_verification":0,"unknown":2})
    );
    let checks = &observed["breakdowns"]["checks"];
    assert_eq!(checks["items"].as_array().unwrap().len(), 10);
    assert_eq!(checks["items"][0], json!({"value":"hot","count":2}));
    assert_eq!(checks["items"][1], json!({"value":null,"count":2}));
    assert_eq!(checks["items"][2]["value"], "c00");
    assert_eq!(checks["items"][9]["value"], "c07");
    assert_eq!(checks["other_count"], 4);
    assert_eq!(
        observed["breakdowns"]["reasons"],
        json!({"items":[{"value":"otherwise","count":14},{"value":null,"count":2}],"other_count":0})
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn clickhouse_parameters_round_trip_escaped_values_and_transport_settings() {
    let f = fixture().await;
    let values = [
        r"tenant\x41".to_owned(),
        r"tenant\\x41".into(),
        r"\N".into(),
        r"\n\t\0\b\f\r".into(),
        "trailing\\".into(),
        "'\"`/%2F?&=+;-- café 界".into(),
        "".into(),
        "界".repeat(85) + "a",
        (0..=127).map(char::from).collect(),
        "\u{80}\u{85}\u{9f}\u{a0}\u{2028}".into(),
    ];
    let mut observed = Vec::new();
    for value in &values {
        let raw = history::clickhouse(&f.app,
            "SELECT {text:String} AS text,{signed:Int64} AS signed,{count:UInt64} AS count,queryID() AS query_id FORMAT JSONEachRow",
            vec![("param_text",value.clone()),("param_signed","-42".into()),("param_count","17".into()),
                ("query_id",r"analytics\N\query".into()),("wait_end_of_query","1".into()),("buffer_size","1048576".into())],None).await;
        observed.push(
            raw.ok()
                .and_then(|raw| serde_json::from_str::<Value>(raw.trim()).ok()),
        );
    }
    f.finish().await;
    for (value, row) in values.iter().zip(observed) {
        let row = row.unwrap_or_else(|| panic!("parameter round trip failed for {value:?}"));
        assert_eq!(row["text"], *value);
        assert!(row["signed"] == -42 || row["signed"] == "-42");
        assert!(row["count"] == 17 || row["count"] == "17");
        assert_eq!(row["query_id"], r"analytics\N\query");
    }
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn escaped_subjects_keep_exact_accepted_history_and_cursor_scope() {
    let f = fixture().await;
    let users = [
        r"tenant\x41".to_owned(),
        "tenantA".into(),
        r"\N".into(),
        r"\n".into(),
        r"\t".into(),
        r"\0".into(),
        r"single\slash".into(),
        r"doubled\\slash".into(),
        "trailing\\".into(),
        "'\"`/%2F?&=+;-- café 界".into(),
        "界".repeat(85) + "a",
    ];
    for (index, user) in users.iter().enumerate() {
        for record in 0..if index == 1 { 3 } else { 2 } {
            json_ok(f.http.post(format!("{}/v1/events",f.url)).bearer_auth(&f.app.config.server_secret)
                .json(&json!({"event_id":format!("exact_{index}_{record}"),"name":"exact_subject","user_id":user,"properties":{}}))).await;
        }
    }
    // A null-like selector must not match an otherwise valid unassociated event.
    json_ok(
        f.http
            .post(format!("{}/v1/events", f.url))
            .bearer_auth(&f.app.config.server_secret)
            .json(&json!({"event_id":"unassociated","name":"exact_subject","ip":"192.0.2.1","properties":{}})),
    )
    .await;
    // The isolated VM clock trails this host. Move only this owned fixture's
    // accepted cohort into the database observation interval; identities and
    // live ingestion/export behavior remain untouched.
    let at = clock(&f).await - 1000;
    sqlx::query("UPDATE delivery_outbox SET at=$1,payload=jsonb_set(payload,'{accepted_at}',to_jsonb($1::bigint))")
        .bind(at).execute(&f.app.db).await.unwrap();
    history::export(&f.app).await.unwrap();
    for (index, user) in users.iter().enumerate() {
        let expected = if index == 1 { 3 } else { 2 };
        let counts = analytics(
            &f,
            "event",
            at,
            at,
            &[("entity_kind", "user"), ("entity", user)],
        )
        .await;
        assert_eq!(counts["scope"]["entity"], *user);
        assert_eq!(counts["totals"]["total"], expected, "user {user:?}");
        let profile = json_ok(
            f.admin(Method::GET, "/lookup/entities")
                .query(&[("kind", "user"), ("id", user)]),
        )
        .await;
        assert_eq!(profile["id"], *user);
        assert_eq!(
            profile["recent_events"].as_array().unwrap().len(),
            expected as usize
        );
        assert!(
            profile["recent_events"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| event["user_id"] == *user)
        );
        let mut cursor = None;
        let mut ids = std::collections::BTreeSet::new();
        loop {
            let mut request = f.admin(Method::GET, "/activity/events").query(&[
                ("entity_kind", "user"),
                ("entity", user.as_str()),
                ("limit", "1"),
                ("from", &at.to_string()),
                ("to", &at.to_string()),
            ]);
            if let Some(cursor) = &cursor {
                request = request.query(&[("cursor", cursor)]);
            }
            let page = json_ok(request).await;
            let event = &page["items"][0];
            assert_eq!(page["items"].as_array().unwrap().len(), 1);
            assert_eq!(event["user_id"], *user);
            assert!(ids.insert(event["event_id"].as_str().unwrap().to_owned()));
            cursor = page["next_cursor"].as_str().map(str::to_owned);
            let Some(next) = &cursor else { break };
            if index == 0 {
                rejected(
                    f.admin(Method::GET, "/activity/events").query(&[
                        ("entity_kind", "user"),
                        ("entity", "tenantA"),
                        ("limit", "1"),
                        ("from", &at.to_string()),
                        ("to", &at.to_string()),
                        ("cursor", next),
                    ]),
                    "invalid_input",
                )
                .await;
            }
        }
        assert_eq!(ids.len(), expected as usize);
    }
    // Controls cannot be admitted as user IDs. Existing exact filter semantics
    // still accept them and must return empty results, never alias or 503.
    for control in [
        '\0', '\t', '\n', '\r', '\u{8}', '\u{c}', '\u{1b}', '\u{7f}', '\u{85}',
    ] {
        let user = format!("tenant{control}A");
        let counts = analytics(
            &f,
            "event",
            at,
            at,
            &[("entity_kind", "user"), ("entity", &user)],
        )
        .await;
        assert_eq!(counts["totals"]["total"], 0);
        let page = json_ok(
            f.admin(Method::GET, "/activity/events")
                .query(&[("entity_kind", "user"), ("entity", &user)]),
        )
        .await;
        assert!(page["items"].as_array().unwrap().is_empty());
    }
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn escaped_legacy_boundaries_detail_receipts_and_pagination_remain_exact() {
    let f = fixture().await;
    let at = clock(&f).await - 1000;
    history::clickhouse(&f.app,&format!("CREATE TABLE {} (kind LowCardinality(String),id String,at Int64,payload String) ENGINE=ReplacingMergeTree ORDER BY(kind,id)",history::table(&f.app,false)),vec![],None).await.unwrap();
    let mut rows = Vec::new();
    for index in 0..102 {
        // The 100th row ends in a backslash and becomes both the backfill's
        // inclusive boundary and durable resume cursor. These are legacy facts,
        // not an expansion of the current event-ID ingress grammar.
        let id = format!("legacy_{index:03}\\");
        rows.push(json!({"kind":"event","id":format!("event:{id}"),"at":at,"payload":event(&id,at,r"legacy\N","backend").to_string()}).to_string());
    }
    history::clickhouse(
        &f.app,
        &format!(
            "INSERT INTO {} FORMAT JSONEachRow",
            history::table(&f.app, false)
        ),
        vec![],
        Some(rows.join("\n") + "\n"),
    )
    .await
    .unwrap();
    assert!(!history::initialize(&f.app).await.unwrap());
    let checkpoint: String =
        sqlx::query_scalar("SELECT cursor_id FROM analytical_migrations WHERE name='history_v2'")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(checkpoint, "event:legacy_099\\");
    // Repeat the same migration call from the durable checkpoint.
    assert!(!history::initialize(&f.app).await.unwrap());
    assert!(history::initialize(&f.app).await.unwrap());
    assert_eq!(
        analytics(&f, "event", at, at, &[]).await["totals"]["total"],
        102
    );
    let detail = json_ok(f.admin(Method::GET, "/activity/events/legacy_099%5C")).await;
    assert_eq!(detail["event_id"], "legacy_099\\");
    let available = history::available_records(
        &f.app,
        &["event:legacy_099\\".into(), "event:legacy_099".into()],
        at,
    )
    .await
    .unwrap();
    assert_eq!(available, vec!["event:legacy_099\\"]);
    let first = json_ok(
        f.admin(Method::GET, "/activity/events")
            .query(&[("limit", "1")]),
    )
    .await;
    assert_eq!(first["items"][0]["event_id"], "legacy_101\\");
    let second = json_ok(f.admin(Method::GET, "/activity/events").query(&[
        ("limit", "1"),
        ("cursor", first["next_cursor"].as_str().unwrap()),
    ]))
    .await;
    assert_eq!(second["items"][0]["event_id"], "legacy_100\\");
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_retention_empty_coverage_delivery_and_scope_errors_are_honest() {
    let f = fixture().await;
    history::initialize(&f.app).await.unwrap();
    let now = clock(&f).await;
    let floor = now - 600_000;
    sqlx::query("UPDATE analytical_retention SET expired_before=$1")
        .bind(floor)
        .execute(&f.app.db)
        .await
        .unwrap();
    for (id, at) in [
        ("expired", floor - 1),
        ("edge", floor),
        ("later", floor + 1),
    ] {
        insert(&f, "event", id, at, 1, event(id, at, "u", "backend")).await;
    }
    sqlx::query("INSERT INTO delivery_outbox(id,logical_id,kind,at,payload) VALUES('event:pending','event:pending','event',$1,'{}')").bind(floor-1000).execute(&f.app.db).await.unwrap();
    let mixed = analytics(&f, "event", floor - 1, floor + 1, &[]).await;
    assert_eq!(mixed["totals"]["total"], 2);
    assert_eq!(mixed["range"]["effective_from"], floor);
    assert_eq!(mixed["buckets"][0]["from"], floor);
    assert_eq!(mixed["delivery"]["pending_records"], 1);
    assert_eq!(mixed["delivery"]["oldest_record_accepted_at"], floor - 1000);
    assert!(mixed["as_of"].as_i64().unwrap() >= now);
    let expired = analytics(&f, "event", floor - 100, floor - 1, &[]).await;
    assert!(expired["totals"].is_null());
    assert!(expired["range"]["effective_from"].is_null());
    assert_eq!(expired["buckets"], json!([]));
    let future = analytics(&f, "event", now + 60_000, now + 120_000, &[]).await;
    assert!(future["totals"].is_null());
    let empty = analytics(&f, "event", floor + 2, floor + 20, &[]).await;
    assert_eq!(empty["totals"]["total"], 0);
    for query in [
        "kind=event&from=0&from=0&to=1",
        "kind=event&from=0&to=1&reason=otherwise",
        "kind=decision&from=0&to=1&provenance=backend",
        "kind=event&from=0&to=2678400000",
    ] {
        rejected(
            f.admin(Method::GET, &format!("/analytics/activity?{query}")),
            "invalid_input",
        )
        .await;
    }
    let unauth = f
        .http
        .get(format!(
            "{}/v1/admin/analytics/activity?kind=event&from=0&to=1",
            f.url
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(unauth.status(), StatusCode::UNAUTHORIZED);
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_concurrency_and_storage_failure_do_not_return_partial_success() {
    let f = fixture().await;
    history::initialize(&f.app).await.unwrap();
    let at = clock(&f).await - 1000;
    let held = f.app.analytics_queries.acquire_many(2).await.unwrap();
    let response = f
        .admin(Method::GET, "/analytics/activity")
        .query(&[
            ("kind", "event"),
            ("from", &at.to_string()),
            ("to", &(at + 1).to_string()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    drop(held);
    assert_eq!(
        analytics(&f, "event", at, at + 1, &[]).await["totals"]["total"],
        0
    );
    // Remove only this fixture's table after successful initialization.
    history::clickhouse(
        &f.app,
        &format!("DROP TABLE {}", history::table(&f.app, true)),
        vec![],
        None,
    )
    .await
    .unwrap();
    let response = f
        .admin(Method::GET, "/analytics/activity")
        .query(&[
            ("kind", "event"),
            ("from", &at.to_string()),
            ("to", &(at + 1).to_string()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(
        response
            .json::<Value>()
            .await
            .unwrap()
            .get("totals")
            .is_none()
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn analytics_migration_rejects_wrong_definition_and_resumes_partial_metadata() {
    let f = fixture().await;
    let table = history::table(&f.app, true);
    history::clickhouse(&f.app,&format!("CREATE TABLE {table} (kind LowCardinality(String),id String,at Int64,payload String,revision UInt64,activity_check Nullable(String) MATERIALIZED JSONExtractString(payload,'check')) ENGINE=ReplacingMergeTree(revision) ORDER BY(kind,id)"),vec![],None).await.unwrap();
    assert!(history::initialize(&f.app).await.unwrap());
    let at = clock(&f).await - 1000;
    let response = f
        .admin(Method::GET, "/analytics/activity")
        .query(&[
            ("kind", "event"),
            ("from", &at.to_string()),
            ("to", &(at + 60_000).to_string()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let completed: Option<bool> = sqlx::query_scalar(
        "SELECT completed FROM analytical_migrations WHERE name='activity_scalars_v1'",
    )
    .fetch_optional(&f.app.db)
    .await
    .unwrap();
    assert_ne!(completed, Some(true));
    // A failed read-only analytical migration must not block live acceptance,
    // ordinary delivery, or the existing record investigation surfaces.
    let accepted = json_ok(f.http.post(format!("{}/v1/events", f.url))
        .bearer_auth(&f.app.config.server_secret)
        .json(&json!({"event_id":"still-delivered","name":"purchase","user_id":"backend-known","properties":{}}))).await;
    assert_eq!(accepted["event_id"], "still-delivered");
    history::export(&f.app).await.unwrap();
    let pending: i64 =
        sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(pending, 0);
    let page = json_ok(f.admin(Method::GET, "/activity/events")).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["event_id"], "still-delivered");
    // Remove only the exported fixture outbox copy so detail proves it can
    // read ClickHouse, rather than the durable-delivery fallback.
    sqlx::query("DELETE FROM delivery_outbox WHERE exported_at IS NOT NULL")
        .execute(&f.app.db)
        .await
        .unwrap();
    let detail = json_ok(f.admin(Method::GET, "/activity/events/still-delivered")).await;
    assert_eq!(detail["event_id"], "still-delivered");
    // The failed ADD already installed the remaining metadata. Repair only the
    // deliberately mismatched owned-fixture column, then replay the whole step.
    history::clickhouse(
        &f.app,
        &format!("ALTER TABLE {table} DROP COLUMN activity_check"),
        vec![],
        None,
    )
    .await
    .unwrap();
    insert(
        &f,
        "decision",
        "safe",
        at,
        1,
        decision("safe", at, "DENY", "safe", "u"),
    )
    .await;
    let observed = analytics(&f, "decision", at, at, &[]).await;
    assert_eq!(observed["totals"]["deny"], 1);
    assert_eq!(
        observed["breakdowns"]["checks"]["items"][0]["value"],
        "safe"
    );
    f.finish().await;
}

async fn generate_rows(f: &Fixture, count: u64, offset: u64, at: i64, unique_checks: bool) {
    let checks = if unique_checks { "number" } else { "number%7" };
    for start in (0..count).step_by(2000) {
        let batch = (count - start).min(2000);
        let sql = format!(
            r#"INSERT INTO {} (kind,id,at,payload,revision)
        SELECT 'decision',concat('decision:d_',toString(number+{offset})),{at}+number,
        concat('{{"decision_id":"d_',toString(number+{offset}),'","operation_id":"op_',toString(number+{offset}),
            '","check":"c_',toString({checks}),'","policy_version":1,"outcome":"',if(number%5=0,'DENY','ALLOW'),
            '","reason":"otherwise","user_id":"u_',toString(number%100),
            '","client_id":"cli_',toString(number%150),'","session_id":"ses_',toString(number%200),
            '","ip":"192.0.2.1","source":"evaluation","accepted_at":',toString({at}+number),
            ',"completed_at":',toString({at}+number+100),',"reason_summary":null,"snapshot":{{"inputs":{{"context":"',repeat('x',512),'"}}}}}}'),1
        FROM numbers({start},{batch}) SETTINGS max_threads=1,max_memory_usage=134217728"#,
            history::table(&f.app, true)
        );
        history::clickhouse(&f.app, &sql, vec![], None)
            .await
            .unwrap();
    }
}
async fn measure(f: &Fixture, from: i64, to: i64, label: &str) {
    let filters = history::Filters {
        from: Some(from),
        to: Some(to),
        ..Default::default()
    };
    let (sql, mut params) = crate::analytics::query_sql(&f.app, "decision", &filters, None);
    params.extend([
        ("param_kind", "decision".into()),
        ("param_bucket", "300000".into()),
        ("wait_end_of_query", "1".into()),
        ("buffer_size", "1048576".into()),
    ]);
    for iteration in 0..3 {
        let start = Instant::now();
        let response = f
            .http
            .post(&f.app.config.clickhouse_url)
            .basic_auth(
                &f.app.config.clickhouse_user,
                Some(&f.app.config.clickhouse_password),
            )
            .query(&[("database", "krine"), ("query", sql.as_str())])
            .query(&params)
            .header("content-length", "0")
            .body("")
            .send()
            .await
            .unwrap();
        let status = response.status();
        let summary = response
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unavailable")
            .to_owned();
        let bytes = response.bytes().await.unwrap();
        assert_eq!(
            status,
            StatusCode::OK,
            "fixture measurement status; body bytes={}",
            bytes.len()
        );
        eprintln!(
            "analytics characterization {label} iteration={iteration} wall_ms={} response_bytes={} summary={summary}",
            start.elapsed().as_millis(),
            bytes.len()
        );
    }
}

#[tokio::test]
#[ignore = "requires guarded isolated stores; sequential development characterization"]
async fn analytics_old_and_typed_parts_characterization_and_group_budget_failure() {
    let f = fixture().await;
    let at = clock(&f).await - 86_400_000;
    history::clickhouse(&f.app,&format!("CREATE TABLE {} (kind LowCardinality(String),id String,at Int64,payload String,revision UInt64) ENGINE=ReplacingMergeTree(revision) ORDER BY(kind,id)",history::table(&f.app,true)),vec![],None).await.unwrap();
    generate_rows(&f, 20_000, 0, at, false).await;
    let before = analytics(&f, "decision", at, at + 86_399_999, &[]).await;
    assert_eq!(
        before["totals"],
        json!({"total":20000,"allow":16000,"deny":4000,"awaiting_verification":0,"unknown":0})
    );
    measure(
        &f,
        at,
        at + 86_399_999,
        "20000 old payload-only rows after metadata ADD",
    )
    .await;
    generate_rows(&f, 20_000, 20_000, at, false).await;
    let after = analytics(&f, "decision", at, at + 86_399_999, &[]).await;
    assert_eq!(after["totals"]["total"], 40000);
    measure(&f, at, at + 86_399_999, "40000 mixed old/new typed rows").await;
    let stats=history::clickhouse(&f.app,&format!("SELECT count() AS physical_rows,avg(length(payload)) AS average_payload_bytes FROM {} FORMAT JSONEachRow",history::table(&f.app,true)),vec![],None).await.unwrap();
    eprintln!("analytics characterization logical_rows=40000 {stats}");
    f.finish().await;
    // A separate sequential owned fixture exercises the actual server-side
    // cardinality budget. Never silently truncate aggregation to a partial sum.
    let f = fixture().await;
    history::initialize(&f.app).await.unwrap();
    crate::analytics::initialize(&f.app).await.unwrap();
    generate_rows(&f, 100_001, 0, at, true).await;
    let response = f
        .admin(Method::GET, "/analytics/activity")
        .query(&[
            ("kind", "decision"),
            ("from", &at.to_string()),
            ("to", &(at + 86_399_999).to_string()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["error"]["code"], "unavailable");
    assert!(body.get("totals").is_none());
    assert_eq!(
        analytics(&f, "decision", at, at + 86_399_999, &[("check", "c_42")]).await["totals"]["total"],
        1
    );
    let stats=history::clickhouse(&f.app,&format!("SELECT count() AS physical_rows,avg(length(payload)) AS average_payload_bytes FROM {} FORMAT JSONEachRow",history::table(&f.app,true)),vec![],None).await.unwrap();
    eprintln!("analytics group budget logical_rows=100001 {stats}");
    f.finish().await;
}
