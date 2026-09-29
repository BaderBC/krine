//! Connection/history contract tests reuse the isolated real HTTP/store fixture.
use super::*;

fn allow_policy() -> Value {
    json!({"schema_version":1,"inputs":{},"rules":[],"otherwise":"ALLOW"})
}
async fn setup(f: &Fixture, check: Option<&str>) -> Value {
    let request = f.admin(Method::GET, "/setup");
    json_ok(if let Some(check) = check {
        request.query(&[("check", check)])
    } else {
        request
    })
    .await
}
async fn event(f: &Fixture, id: &str) -> Value {
    json_ok(f.http.post(format!("{}/v1/events",f.url)).bearer_auth(&f.app.config.server_secret).json(&json!({"event_id":id,"name":"purchase","user_id":"backend-known","properties":{"private":"not in setup"}}))).await
}
async fn replica(
    f: &Fixture,
    days: i64,
    unavailable: bool,
) -> (App, String, tokio::task::JoinHandle<()>) {
    let mut config = Config::load().unwrap();
    config.database_url = f.app.config.database_url.clone();
    config.valkey_url = f.app.config.valkey_url.clone();
    config.history_retention_days = days;
    config.login_rate = 100000;
    config.browser_rate = 100000;
    config.server_rate = 100000;
    if unavailable {
        config.clickhouse_url = "http://127.0.0.1:1".into();
    }
    let mut app = App::connect(config).await.unwrap();
    app.provider_test = f.app.provider_test.clone();
    let (url, server) = Fixture::serve(app.clone()).await;
    (app, url, server)
}
fn replica_admin(f: &Fixture, url: &str, path: &str) -> RequestBuilder {
    f.http
        .get(format!("{url}/v1/admin{path}"))
        .header("cookie", &f.cookie)
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn observations_commit_with_receipts_and_remain_scoped_during_analytics_outage() {
    let f = Fixture::new().await;
    let first = setup(&f, None).await;
    assert_eq!(first["observations"]["check"], Value::Null);
    assert_eq!(first["observations"]["client_evidence"], Value::Null);
    assert_eq!(first["observations"]["backend_event"], Value::Null);
    assert_eq!(first["observations"]["check_attempt"], Value::Null);
    assert_eq!(first["history_retention"]["days"], 30);
    let mut tx = f.app.db.begin().await.unwrap();
    connection::observe(&mut tx, "backend_event", "", "rolled_back", util::now())
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(
        setup(&f, None).await["observations"]["backend_event"],
        Value::Null
    );
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let request = f.browser("context", &json!({}));
        requests.spawn(async move { json_ok(request).await });
    }
    while let Some(result) = requests.join_next().await {
        result.unwrap();
    }
    let evidence = setup(&f, None).await["observations"]["client_evidence"].clone();
    assert_eq!(evidence["basis"], "tracked");
    assert_eq!(evidence["record"]["availability"], "available");
    let source = json_ok(f.admin(
        Method::GET,
        &format!(
            "/activity/events/{}",
            evidence["record"]["id"].as_str().unwrap()
        ),
    ))
    .await;
    assert_eq!(source["name"], "browser.context");
    assert_eq!(source["accepted_at"], evidence["received_at"]);
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM application_observations WHERE kind='client_evidence'",
    )
    .fetch_one(&f.app.db)
    .await
    .unwrap();
    assert_eq!(count, 1);
    let (outage, url, server) = replica(&f, 30, true).await;
    let id = unique();
    let receipt = json_ok(f.http.post(format!("{url}/v1/events")).bearer_auth(&f.app.config.server_secret).json(&json!({"event_id":id,"name":"purchase","user_id":"backend-known","properties":{"private":"not in setup"}}))).await;
    for _ in 0..3 {
        assert_eq!(event(&f, &id).await["accepted_at"], receipt["accepted_at"]);
    }
    let check = unique();
    f.policy(&check, allow_policy()).await;
    let other = unique();
    f.policy(&other, allow_policy()).await;
    rejected(
        f.backend(
            &json!({"operation_id":unique(),"check":check,"proof":"invalid","ip":"127.0.0.1"}),
        ),
        "invalid_proof",
    )
    .await;
    assert_eq!(
        setup(&f, Some(&check)).await["observations"]["check_attempt"],
        Value::Null
    );
    let context = json_ok(f.browser("context", &json!({}))).await;
    let proof = json_ok(f.browser("proofs", &json!({"client_token":context["client_token"],"session_token":context["session_token"],"check":check}))).await;
    let response = json_ok(f.http.post(format!("{url}/v1/checks/evaluate")).bearer_auth(&f.app.config.server_secret).json(&json!({"operation_id":unique(),"check":check,"proof":proof["proof"],"ip":"127.0.0.1"}))).await;
    let observed = setup(&f, Some(&check)).await["observations"].clone();
    assert_eq!(
        observed["check_attempt"]["record"]["id"],
        response["decision_id"]
    );
    assert_eq!(
        observed["check_attempt"]["received_at"],
        response["accepted_at"]
    );
    assert_eq!(observed["backend_event"]["record"]["id"], id);
    assert_eq!(observed["client_evidence"], evidence);
    f.attempt(&check).await;
    assert_eq!(setup(&f, Some(&check)).await["observations"], observed);
    let scoped = setup(&f, Some(&other)).await;
    assert_eq!(scoped["observations"]["check_attempt"], Value::Null);
    assert_eq!(
        scoped["observations"]["backend_event"],
        observed["backend_event"]
    );
    assert_eq!(
        setup(&f, None).await["observations"]["check_attempt"],
        Value::Null
    );
    rejected(
        f.admin(Method::GET, "/setup?check=nonexistent"),
        "not_found",
    )
    .await;
    assert_eq!(
        json_ok(replica_admin(&f, &url, &format!("/setup?check={check}"))).await["observations"],
        observed
    );
    // A retained marker whose record has left PG distinguishes analytics outage
    // from a record no longer retained; the receipt itself remains known.
    sqlx::query("DELETE FROM delivery_outbox WHERE logical_id=$1")
        .bind(format!("event:{id}"))
        .execute(&f.app.db)
        .await
        .unwrap();
    let unavailable = json_ok(replica_admin(&f, &url, "/setup")).await;
    assert_eq!(
        unavailable["observations"]["backend_event"]["record"]["availability"],
        "unavailable"
    );
    assert_eq!(
        unavailable["observations"]["backend_event"]["received_at"],
        receipt["accepted_at"]
    );
    server.abort();
    outage.db.close().await;
    history::export(&f.app).await.unwrap();
    assert_eq!(
        setup(&f, None).await["observations"]["backend_event"]["record"]["availability"],
        "not_retained"
    );
    assert!(
        !serde_json::to_string(&observed)
            .unwrap()
            .contains("private")
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn captured_reasons_survive_export_current_changes_and_legacy_rows() {
    let f = Fixture::new().await;
    let check = unique();
    let policy = json!({"schema_version":1,"inputs":{},"rules":[{"id":"users","condition":{"op":"compare","left":{"source":"metric","name":"client.user_count_30d","version":1},"comparison":"gte","value":1},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
    f.policy(&check, policy).await;
    let (_, response) = f.attempt(&check).await;
    let detail = f.detail(&response).await;
    let summary = detail["reason_summary"].clone();
    assert_eq!(summary["scope"], "otherwise");
    assert_eq!(summary["rules"][0]["evidence"][0]["observed"]["value"], 0.0);
    assert_eq!(summary["rules"][0]["route"], "next");
    history::export(&f.app).await.unwrap();
    let page = json_ok(f.admin(Method::GET, &format!("/activity/decisions?check={check}"))).await;
    assert_eq!(
        util::canonical_digest(&page["items"][0]["reason_summary"]),
        util::canonical_digest(&summary)
    );
    assert!(page["items"][0].get("snapshot").is_none());
    assert_eq!(page["retention"]["days"], 30);
    let client = detail["client_id"].as_str().unwrap();
    json_ok(
        f.http
            .post(format!("{}/v1/associations", f.url))
            .bearer_auth(&f.app.config.server_secret)
            .json(&json!({"association_id":unique(),"client_id":client,"user_id":"later-fact"})),
    )
    .await;
    assert_eq!(f.detail(&response).await["reason_summary"], summary);
    // Old rows have a null summary; no current policy/evidence is substituted.
    let mut legacy = detail.clone();
    legacy.as_object_mut().unwrap().remove("reason_summary");
    let id = unique();
    legacy["decision_id"] = json!(id);
    legacy["operation_id"] = json!(unique());
    let row = json!({"id":format!("decision:{id}"),"revision":1,"kind":"decision","at":util::now(),"payload":legacy.to_string()});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{row}\n")),
    )
    .await
    .unwrap();
    let page = json_ok(f.admin(
        Method::GET,
        &format!(
            "/activity/decisions?operation_id={}",
            legacy["operation_id"].as_str().unwrap()
        ),
    ))
    .await;
    assert_eq!(page["items"][0]["reason_summary"], Value::Null);
    // A malformed oversized historical summary cannot blow up a list response.
    legacy["decision_id"] = json!(unique());
    legacy["operation_id"] = json!(unique());
    legacy["reason_summary"] = json!({"bad":"x".repeat(500_000)});
    let row = json!({"id":format!("decision:{}",legacy["decision_id"].as_str().unwrap()),"revision":1,"kind":"decision","at":util::now(),"payload":legacy.to_string()});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{row}\n")),
    )
    .await
    .unwrap();
    let page = json_ok(f.admin(
        Method::GET,
        &format!(
            "/activity/decisions?operation_id={}",
            legacy["operation_id"].as_str().unwrap()
        ),
    ))
    .await;
    assert_eq!(page["items"][0]["reason_summary"], Value::Null);
    assert!(page.to_string().len() < 4096);
    f.configure("ip_intelligence", 0, "test-secret").await;
    f.mock.lock().unwrap().ip_delay_ms = 1200;
    let risk = unique();
    f.policy(&risk,json!({"schema_version":1,"inputs":{},"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.risk","version":1},"comparison":"gte","value":0.8},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    let (_, response) = f.attempt(&risk).await;
    let detail = f.detail(&response).await;
    assert_eq!(detail["reason_summary"]["reason"], "unknown_denied");
    let leaf = &detail["reason_summary"]["rules"][0]["evidence"][0];
    assert_eq!(leaf["observed"]["reason"], "timeout");
    assert_eq!(leaf["reference"]["version"], 1);
    assert_eq!(leaf["provenance"]["source"], "proxycheck@1");
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn retention_changes_are_shared_and_expired_rows_do_not_resurrect() {
    let f = Fixture::new().await;
    let check = unique();
    f.policy(&check, allow_policy()).await;
    let (input, response) = f.attempt(&check).await;
    history::export(&f.app).await.unwrap();
    super::retention_tests::retire(&f.app).await;
    let id = response["decision_id"].as_str().unwrap();
    let operation = input["operation_id"].as_str().unwrap();
    let old = util::now() - 3 * 86_400_000;
    let mut old_detail = f.detail(&response).await;
    old_detail["accepted_at"] = json!(old);
    let row = json!({"id":format!("decision:{id}"),"revision":100,"kind":"decision","at":old,"payload":old_detail.to_string()});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{row}\n")),
    )
    .await
    .unwrap();
    sqlx::query("UPDATE delivery_outbox SET at=$1,payload=$2,exported_at=NULL WHERE logical_id=$3")
        .bind(old)
        .bind(&old_detail)
        .bind(format!("decision:{id}"))
        .execute(&f.app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE application_observations SET received_at=$1 WHERE kind='check_attempt'")
        .bind(old)
        .execute(&f.app.db)
        .await
        .unwrap();
    let (short, url, server) = replica(&f, 2, false).await;
    // A still-running replica configured with 30 also reads the durable 2-day setting.
    let setup = setup(&f, Some(&check)).await;
    assert_eq!(setup["history_retention"]["days"], 2);
    assert_eq!(
        setup["observations"]["check_attempt"]["record"]["availability"],
        "not_retained"
    );
    let page = json_ok(f.admin(
        Method::GET,
        &format!("/activity/decisions?operation_id={operation}"),
    ))
    .await;
    assert!(page["items"].as_array().unwrap().is_empty());
    rejected(
        f.admin(Method::GET, &format!("/activity/decisions/{id}")),
        "not_found",
    )
    .await;
    assert_eq!(json_ok(f.backend(&input)).await, response); // Security retry is untouched.
    let raw=history::clickhouse(&f.app,&format!("SELECT count() AS n FROM history_v2_{} FINAL WHERE id={{id:String}} FORMAT JSONEachRow",f.schema),vec![("param_id",format!("decision:{id}"))],None).await.unwrap();
    assert!(raw.contains('1'));
    // Simulate a period without history reads, then increase retention. The old
    // window is captured at configuration change, rather than last UI activity.
    sqlx::query("UPDATE analytical_retention SET expired_before=0")
        .execute(&f.app.db)
        .await
        .unwrap();
    history::configure_retention(&f.app.db, 30).await.unwrap();
    assert!(history::retention(&f.app).await.unwrap().cutoff > old);
    assert!(
        json_ok(replica_admin(
            &f,
            &url,
            &format!("/activity/decisions?operation_id={operation}")
        ))
        .await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    history::export(&f.app).await.unwrap(); // Delayed delivery cannot undo expiry.
    assert!(
        json_ok(f.admin(
            Method::GET,
            &format!("/activity/decisions?operation_id={operation}")
        ))
        .await["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let persisted = history::retention(&f.app).await.unwrap().cutoff;
    history::configure_retention(&f.app.db, 30).await.unwrap();
    assert!(history::retention(&f.app).await.unwrap().cutoff >= persisted);
    let schema = history::clickhouse(
        &f.app,
        &format!("SHOW CREATE TABLE history_v2_{}", f.schema),
        vec![],
        None,
    )
    .await
    .unwrap();
    assert!(!schema.contains("TTL "));
    let (a, b) = tokio::join!(
        history::configure_retention(&f.app.db, 5),
        history::configure_retention(&short.db, 9)
    );
    a.unwrap();
    b.unwrap();
    let first = history::retention(&f.app).await.unwrap();
    let second = history::retention(&short).await.unwrap();
    assert_eq!(first.days, second.days);
    assert!([5, 9].contains(&first.days));
    assert!(first.cutoff >= persisted);
    assert!(second.cutoff >= persisted);
    server.abort();
    short.db.close().await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn migration_backfills_only_retained_receipts_and_claims_can_be_pending() {
    let f = Fixture::new().await;
    let check = unique();
    f.policy(&check, allow_policy()).await;
    let (input, response) = f.attempt(&check).await;
    let event_id = unique();
    event(&f, &event_id).await;
    // Reconstruct a pre-0007 fixture without altering any previously published
    // migration; reapply 0007 to prove the real upgrade backfill contract.
    sqlx::raw_sql("ALTER FUNCTION require_writer_generation_5() RENAME TO require_writer_generation_4; DROP TABLE application_observations,application_observation_state,analytical_retention,analytical_cleanup; DROP INDEX operations_captured_decision; DELETE FROM _sqlx_migrations WHERE version=7").execute(&f.app.db).await.unwrap();
    let mut config = Config::load().unwrap();
    config.database_url = f.app.config.database_url.clone();
    config.valkey_url = f.app.config.valkey_url.clone();
    let upgraded = App::connect(config).await.unwrap();
    let rows = setup(&f, Some(&check)).await;
    assert_eq!(
        rows["observations"]["check_attempt"]["basis"],
        "retained_history"
    );
    assert_eq!(
        rows["observations"]["backend_event"]["basis"],
        "retained_history"
    );
    assert_eq!(
        rows["observations"]["client_evidence"]["basis"],
        "retained_history"
    );
    assert_eq!(
        rows["observations"]["check_attempt"]["record"]["id"],
        response["decision_id"]
    );
    sqlx::query("DELETE FROM delivery_outbox WHERE logical_id=$1")
        .bind(format!(
            "decision:{}",
            response["decision_id"].as_str().unwrap()
        ))
        .execute(&f.app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET response=NULL,detail=NULL,state='claimed' WHERE id=$1")
        .bind(input["operation_id"].as_str().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    assert_eq!(
        setup(&f, Some(&check)).await["observations"]["check_attempt"]["record"]["availability"],
        "pending"
    );
    upgraded.db.close().await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn typed_entity_activity_filters_collisions_and_binds_pagination() {
    let f = Fixture::new().await;
    let context = json_ok(f.browser("context", &json!({}))).await;
    let collisions = [
        ("client", context["client_id"].as_str().unwrap()),
        ("session", context["session_id"].as_str().unwrap()),
        ("ip", "127.0.0.1"),
    ];
    for (_, id) in collisions {
        json_ok(
            f.http
                .post(format!("{}/v1/events", f.url))
                .bearer_auth(&f.app.config.server_secret)
                .json(&json!({"event_id":unique(),"name":"actual_collision","user_id":id})),
        )
        .await;
    }
    history::export(&f.app).await.unwrap();
    // Real accepted backend user IDs may equal a Krine context ID or an IP.
    // Untyped investigation sees both facts; a typed entity link sees only its own.
    for (kind, id) in collisions {
        let broad = json_ok(
            f.admin(Method::GET, "/activity/events")
                .query(&[("entity", id)]),
        )
        .await;
        assert_eq!(broad["items"].as_array().unwrap().len(), 2);
        let typed = json_ok(
            f.admin(Method::GET, "/activity/events")
                .query(&[("entity", id), ("entity_kind", kind)]),
        )
        .await;
        assert_eq!(typed["items"].as_array().unwrap().len(), 1);
        assert_eq!(typed["items"][0]["provenance"], "browser");
        let user = json_ok(
            f.admin(Method::GET, "/activity/events")
                .query(&[("entity", id), ("entity_kind", "user")]),
        )
        .await;
        assert_eq!(user["items"].as_array().unwrap().len(), 1);
        assert_eq!(user["items"][0]["provenance"], "backend");
    }
    let at = util::now();
    let entity = "198.51.100.77";
    let check = unique();
    let mut body = String::new();
    for record_kind in ["event", "decision"] {
        for field in ["client_id", "session_id", "user_id", "ip"] {
            for index in 0..3 {
                let id = unique();
                let mut payload = json!({"decision_id":id,"event_id":id,"operation_id":unique(),"check":check,"policy_version":1,"outcome":"ALLOW","reason":"otherwise","accepted_at":at,"completed_at":at,"client_id":"other_client","session_id":"other_session","user_id":"other_user","ip":"192.0.2.1","source":"evaluation","name":"typed_fixture"});
                payload[field] = json!(entity);
                payload["ordinal"] = json!(index);
                body.push_str(&json!({"kind":record_kind,"id":format!("{record_kind}:{id}"),"at":at,"revision":1,"payload":payload.to_string()}).to_string());
                body.push('\n');
            }
        }
    }
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(body),
    )
    .await
    .unwrap();
    for records in ["events", "decisions"] {
        let base = format!("/activity/{records}?entity={entity}");
        let broad = json_ok(f.admin(Method::GET, &base)).await;
        assert_eq!(broad["items"].as_array().unwrap().len(), 12);
        for (kind, field) in [
            ("client", "client_id"),
            ("session", "session_id"),
            ("user", "user_id"),
            ("ip", "ip"),
        ] {
            let path = format!("{base}&entity_kind={kind}&limit=2");
            let first = json_ok(f.admin(Method::GET, &path)).await;
            assert_eq!(first["items"].as_array().unwrap().len(), 2);
            for row in first["items"].as_array().unwrap() {
                assert_eq!(row[field], entity);
                for other in ["client_id", "session_id", "user_id", "ip"]
                    .into_iter()
                    .filter(|other| *other != field)
                {
                    assert_ne!(row[other], entity);
                }
            }
            let cursor = first["next_cursor"].as_str().unwrap();
            let next = json_ok(f.admin(Method::GET, &format!("{path}&cursor={cursor}"))).await;
            assert_eq!(next["items"].as_array().unwrap().len(), 1);
            assert_eq!(next["next_cursor"], Value::Null);
            let id_field = if records == "events" {
                "event_id"
            } else {
                "decision_id"
            };
            assert!(
                first["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row[id_field] != next["items"][0][id_field])
            );
            rejected(
                f.admin(Method::GET, &format!("{base}&cursor={cursor}")),
                "invalid_input",
            )
            .await;
            rejected(
                f.admin(
                    Method::GET,
                    &format!("/activity/{records}?entity=other&entity_kind={kind}&cursor={cursor}"),
                ),
                "invalid_input",
            )
            .await;
            rejected(
                f.admin(
                    Method::GET,
                    &format!(
                        "{base}&entity_kind={}&cursor={cursor}",
                        if kind == "user" { "client" } else { "user" }
                    ),
                ),
                "invalid_input",
            )
            .await;
        }
        rejected(
            f.admin(
                Method::GET,
                &format!("/activity/{records}?entity_kind=user"),
            ),
            "invalid_input",
        )
        .await;
        rejected(
            f.admin(
                Method::GET,
                &format!("/activity/{records}?entity=&entity_kind=user"),
            ),
            "invalid_input",
        )
        .await;
        rejected(
            f.admin(Method::GET, &format!("{base}&entity_kind=device")),
            "invalid_input",
        )
        .await;
        // Existing opaque tuple cursors remain valid for legacy untyped search.
        let legacy = admin::cursor(at + 1, "last");
        assert_eq!(
            json_ok(f.admin(Method::GET, &format!("{base}&cursor={legacy}"))).await["items"]
                .as_array()
                .unwrap()
                .len(),
            12
        );
    }
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn captured_reason_tracks_verification_and_otherwise_continuation() {
    let f = Fixture::new().await;
    f.configure("verification", 0, "pinned-secret").await;
    let check = unique();
    f.policy(&check, challenge_policy(1)).await;
    let (input, pending) = f.attempt(&check).await;
    let original = f.detail(&pending).await["reason_summary"].clone();
    assert_eq!(original["scope"], "decisive_rule");
    assert_eq!(original["rules"][0]["route"], "challenge");
    let token = f.token(&pending["challenge"]);
    let allowed = json_ok(f.backend(&continuation(&input, &pending, &token))).await;
    let summary = f.detail(&allowed).await["reason_summary"].clone();
    assert_eq!(summary["scope"], "otherwise");
    assert_eq!(summary["outcome"], "ALLOW");
    assert_eq!(summary["rules"][0]["route"], "verification_passed");
    assert_eq!(summary["rules"][0]["result"], "true");
    assert_eq!(
        summary["rules"][0]["evidence"],
        original["rules"][0]["evidence"]
    );
    assert_eq!(summary["provider_revisions"]["verification"]["revision"], 1);
    let (input, _) = f.attempt(&check).await;
    sqlx::query("UPDATE operations SET accepted_at=$1 WHERE id=$2")
        .bind(util::now() - 300_001)
        .bind(input["operation_id"].as_str().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    let expired = json_ok(f.backend(&input)).await;
    let summary = f.detail(&expired).await["reason_summary"].clone();
    assert_eq!(summary["reason"], "verification_expired");
    assert_eq!(summary["rules"][0]["route"], "verification_expired");
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn schema_five_and_six_upgrade_preserve_facts_and_reject_old_writers() {
    let f = Fixture::new().await;
    for version in [5, 6] {
        let schema = unique();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&f.admin)
            .await
            .unwrap();
        let mut config = Config::load().unwrap();
        config.valkey_url = f.app.config.valkey_url.clone();
        let mut url = reqwest::Url::parse(&config.database_url).unwrap();
        url.query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        config.database_url = url.to_string();
        let old = PgPoolOptions::new()
            .max_connections(1)
            .connect(&config.database_url)
            .await
            .unwrap();
        let mut migrations = sqlx::migrate!("../../migrations");
        migrations.migrations = std::borrow::Cow::Owned(
            migrations
                .iter()
                .filter(|m| m.version <= version)
                .cloned()
                .collect(),
        );
        // Generation 3 permits migration 0004's own update; older empty tables
        // need no application writes until the entire selected chain completes.
        sqlx::query("SET krine.writer_generation='3'")
            .execute(&old)
            .await
            .unwrap();
        migrations.run(&old).await.unwrap();
        sqlx::query(if version == 5 {
            "SET krine.writer_generation='3'"
        } else {
            "SET krine.writer_generation='4'"
        })
        .execute(&old)
        .await
        .unwrap();
        let at = util::now();
        sqlx::query("INSERT INTO associations(id,digest,client_id,user_id,metadata,created_at) VALUES('assertion','digest','client','user','{}',$1)").bind(at).execute(&old).await.unwrap();
        sqlx::query("INSERT INTO events(id,digest,envelope,accepted_at) VALUES('old_event','digest','{}',$1)").bind(at).execute(&old).await.unwrap();
        sqlx::query("INSERT INTO operations(id,digest,proof_digest,accepted_at,retry_until,envelope) VALUES('old_attempt','digest','proof',$1,$2,'{\"check\":\"old_check\",\"decision_id\":\"old_decision\"}')").bind(at).bind(at+86_400_000).execute(&old).await.unwrap();
        sqlx::query("INSERT INTO delivery_outbox(id,logical_id,kind,at,payload) VALUES('event:old_browser','event:old_browser','event',$1,'{\"event_id\":\"old_browser\",\"name\":\"browser.context\",\"provenance\":\"browser\"}')").bind(at).execute(&old).await.unwrap();
        let app = App::connect(config).await.unwrap();
        let markers = sqlx::query(
            "SELECT record_id,received_at,basis FROM application_observations ORDER BY kind",
        )
        .fetch_all(&app.db)
        .await
        .unwrap();
        assert_eq!(markers.len(), 3);
        for row in markers {
            assert_eq!(row.get::<i64, _>("received_at"), at);
            assert_eq!(row.get::<String, _>("basis"), "retained_history");
        }
        let preserved: String =
            sqlx::query_scalar("SELECT user_id FROM associations WHERE id='assertion'")
                .fetch_one(&app.db)
                .await
                .unwrap();
        assert_eq!(preserved, "user");
        sqlx::query("SET krine.writer_generation='4'")
            .execute(&old)
            .await
            .unwrap();
        for query in [
            "UPDATE associations SET revoked_at=1 WHERE id='assertion'",
            "UPDATE operations SET state='final' WHERE id='old_attempt'",
            "UPDATE delivery_outbox SET exported_at=1 WHERE id='event:old_browser'",
        ] {
            let error = sqlx::query(query).execute(&old).await.unwrap_err();
            assert!(
                error
                    .to_string()
                    .contains("generation 5; stop the old server")
            );
        }
        app.db.close().await;
        old.close().await;
        sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
            .execute(&f.admin)
            .await
            .unwrap();
    }
    f.finish().await;
}
