//! Real-store subject scopes, logical replacement and independent context reads.
use super::*;

async fn fixture() -> Fixture {
    let f = Fixture::new().await;
    eprintln!("investigation fixture owned schema/tables: {}", f.schema);
    assert!(history::initialize(&f.app).await.unwrap());
    f
}
async fn clock(f: &Fixture) -> i64 {
    sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(&f.app.db)
        .await
        .unwrap()
}
fn event(id: &str, at: i64, user: &str) -> Value {
    json!({"event_id":id,"name":"trial.requested","accepted_at":at,"occurred_at":at-3_600_000,
        "user_id":user,"client_id":"client-shared","session_id":"session-one","ip":"192.0.2.4",
        "provenance":"backend","properties":{"private_note":"detail only"}})
}
fn decision(id: &str, at: i64, user: &str, outcome: &str) -> Value {
    json!({"decision_id":id,"operation_id":format!("op_{id}"),"check":"can_claim_trial","policy_version":1,
        "outcome":outcome,"reason":"otherwise","accepted_at":at,"completed_at":at+1,
        "client_id":"client-shared","session_id":"session-one","user_id":user,"ip":"192.0.2.4",
        "source":"evaluation","reason_summary":null})
}
async fn insert(f: &Fixture, kind: &str, id: &str, at: i64, revision: i64, payload: Value) {
    history::clickhouse(&f.app,&format!("INSERT INTO {} (kind,id,at,payload,revision) FORMAT JSONEachRow",history::table(&f.app,true)),vec![],
        Some(format!("{}\n",json!({"kind":kind,"id":format!("{kind}:{id}"),"at":at,"revision":revision,"payload":payload.to_string()})))).await.unwrap();
}
fn request(f: &Fixture, kind: &str, id: &str, from: i64, to: i64) -> RequestBuilder {
    f.admin(Method::GET, "/lookup/entities/timeline").query(&[
        ("kind", kind),
        ("id", id),
        ("from", &from.to_string()),
        ("to", &to.to_string()),
    ])
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn timeline_mixed_pages_preserve_latest_logical_records_and_direct_subject_scope() {
    let f = fixture().await;
    let at = clock(&f).await - 60_000;
    let user = " Alice\\x41 /%2e 界 ";
    for id in ["a", "b", "same"] {
        insert(&f, "event", id, at, 1, event(id, at, user)).await;
    }
    for id in ["a", "same"] {
        let mut final_decision = decision(id, at, user, "DENY");
        final_decision["sample_data"] = json!({"dataset_id":"fixture","generator_version":"1"});
        insert(&f, "decision", id, at, 3, final_decision.clone()).await;
        insert(
            &f,
            "decision",
            id,
            at,
            1,
            decision(id, at, user, "CHALLENGE_REQUIRED"),
        )
        .await;
        insert(&f, "decision", id, at, 3, final_decision).await;
    }
    // Reuse after the supported retry horizon replaces identity before subject
    // and time filtering. It must not resurrect the older matching row.
    insert(
        &f,
        "event",
        "reused",
        at - 3 * 86_400_000,
        1,
        event("reused", at - 3 * 86_400_000, user),
    )
    .await;
    insert(
        &f,
        "event",
        "reused",
        at + 1,
        1,
        event("reused", at + 1, "someone else"),
    )
    .await;
    insert(
        &f,
        "event",
        "related",
        at,
        1,
        event("related", at, "someone else"),
    )
    .await;
    let mut collision = event("typed-collision", at, "different");
    collision["client_id"] = json!(user);
    insert(&f, "event", "typed-collision", at, 1, collision).await;
    let mut items = Vec::new();
    let mut cursor = None;
    let mut pages = 0;
    loop {
        let mut pending =
            request(&f, "user", user, at - 3 * 86_400_000, at + 1).query(&[("limit", "2")]);
        if let Some(cursor) = &cursor {
            pending = pending.query(&[("cursor", cursor)]);
        }
        let page = json_ok(pending).await;
        assert_eq!(page["scope"], json!({"kind":"user","id":user}));
        items.extend(page["items"].as_array().unwrap().iter().cloned());
        pages += 1;
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
        assert!(pages < 4);
    }
    assert_eq!(pages, 3);
    assert_eq!(
        items
            .iter()
            .map(|r| (r["kind"].as_str().unwrap(), r["id"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        vec![
            ("event", "same"),
            ("event", "b"),
            ("event", "a"),
            ("decision", "same"),
            ("decision", "a")
        ]
    );
    for row in &items[..3] {
        assert_eq!(row["summary"]["occurred_at"], at - 3_600_000);
        assert!(row["summary"].get("properties").is_none());
        assert_eq!(row["summary"]["session_id"], "session-one");
    }
    let legacy = json_ok(
        f.admin(Method::GET, "/activity/decisions")
            .query(&[("entity_kind", "user"), ("entity", user)]),
    )
    .await;
    assert_eq!(items[3]["summary"], legacy["items"][0]);
    assert_eq!(items[4]["summary"], legacy["items"][1]);
    assert_eq!(items[3]["summary"]["outcome"], "DENY");
    assert_eq!(items[3]["summary"]["sample_data"]["dataset_id"], "fixture");
    let detail = json_ok(
        f.admin(Method::GET, "/lookup/events")
            .query(&[("id", "same")]),
    )
    .await;
    assert_eq!(detail["properties"]["private_note"], "detail only");
    let old = json_ok(request(&f, "user", user, at - 3 * 86_400_000, at - 1)).await;
    assert!(old["items"].as_array().unwrap().is_empty());
    let missing_context = f
        .admin(Method::GET, "/lookup/entities/context")
        .query(&[("kind", "user"), ("id", user)])
        .send()
        .await
        .unwrap();
    assert_eq!(missing_context.status(), StatusCode::NOT_FOUND);
    eprintln!(
        "mixed timeline pages={pages}, logical records={}, direct scope and late occurrence verified",
        items.len()
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn timeline_exact_identifiers_cursor_scope_retention_and_unknown_facts() {
    let f = fixture().await;
    let now = clock(&f).await;
    let floor = now - 60_000;
    sqlx::query("UPDATE analytical_retention SET expired_before=$1")
        .bind(floor)
        .execute(&f.app.db)
        .await
        .unwrap();
    let ids = [
        ".",
        "..",
        "%2e",
        r"tenant\x41",
        r"tenant\\x41",
        r"\N",
        "trailing\\",
        " Alice\u{a0} ",
        "用户/a?b#c%",
    ];
    for (n, user) in ids.iter().enumerate() {
        for suffix in ["a", "b"] {
            let id = format!("e{n}_{suffix}");
            let mut payload = event(&id, floor, user);
            payload.as_object_mut().unwrap().remove("provenance");
            payload.as_object_mut().unwrap().remove("occurred_at");
            payload["sample_data"] = json!({"dataset_id":"fixture","generator_version":"1"});
            insert(&f, "event", &id, floor, 1, payload).await;
        }
        let first =
            json_ok(request(&f, "user", user, floor - 1, floor).query(&[("limit", "1")])).await;
        assert_eq!(first["scope"]["id"], *user);
        assert_eq!(first["range"]["effective_from"], floor);
        assert!(first["items"][0]["summary"]["provenance"].is_null());
        assert!(first["items"][0]["summary"]["occurred_at"].is_null());
        let cursor = first["next_cursor"].as_str().unwrap();
        let second = json_ok(
            request(&f, "user", user, floor - 1, floor)
                .query(&[("cursor", cursor), ("limit", "100")]),
        )
        .await;
        assert_eq!(second["items"].as_array().unwrap().len(), 1);
        assert!(second["next_cursor"].is_null());
        rejected(
            request(&f, "user", "another", floor - 1, floor).query(&[("cursor", cursor)]),
            "invalid_input",
        )
        .await;
        rejected(
            request(&f, "user", user, floor, floor).query(&[("cursor", cursor)]),
            "invalid_input",
        )
        .await;
    }
    let mut unsupported = event("unknown", floor, ids[0]);
    unsupported["provenance"] = json!("legacy");
    insert(&f, "event", "unknown", floor, 1, unsupported).await;
    let current = json_ok(request(&f, "user", ids[0], floor, floor)).await;
    assert_eq!(current["items"][0]["summary"]["provenance"], "legacy");
    sqlx::query("INSERT INTO delivery_outbox(id,logical_id,kind,at,payload) VALUES('event:pending','event:pending','event',$1,'{}')").bind(floor-1000).execute(&f.app.db).await.unwrap();
    for (from, to) in [(floor - 100, floor - 1), (now + 60_000, now + 120_000)] {
        let unavailable = json_ok(request(&f, "user", ids[0], from, to)).await;
        assert!(unavailable["range"]["effective_from"].is_null());
        assert!(unavailable["range"]["effective_to"].is_null());
        assert!(unavailable["items"].as_array().unwrap().is_empty());
        assert!(unavailable["next_cursor"].is_null());
        assert_eq!(unavailable["delivery"]["pending_records"], 1);
        assert_eq!(
            unavailable["delivery"]["oldest_record_accepted_at"],
            floor - 1000
        );
    }
    let empty = json_ok(request(&f, "user", ids[0], floor + 1, floor + 100)).await;
    assert_eq!(empty["range"]["effective_from"], floor + 1);
    assert!(empty["items"].as_array().unwrap().is_empty());
    for extra in [
        ("kind", "client"),
        ("id", "other"),
        ("from", "0"),
        ("unused", "x"),
        ("cursor", "not-base64!"),
    ] {
        rejected(
            request(&f, "user", ids[0], floor, floor).query(&[extra]),
            "invalid_input",
        )
        .await;
    }
    for path in [
        "timeline?kind=user&id=.&from=0&to=1",
        "context?kind=user&id=.",
    ] {
        assert_eq!(
            f.http
                .get(format!("{}/v1/admin/lookup/entities/{path}", f.url))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn subject_context_and_relationships_survive_analytical_failure_without_fake_history() {
    let f = fixture().await;
    let browser = json_ok(f.browser("context", &json!({}))).await;
    let client = browser["client_id"].as_str().unwrap();
    let session = browser["session_id"].as_str().unwrap();
    let assertion=json_ok(f.http.post(format!("{}/v1/associations",f.url)).bearer_auth(&f.app.config.server_secret)
        .json(&json!({"association_id":"assertion","client_id":client,"session_id":session,"user_id":"person","metadata":{"plan":"trial"}}))).await;
    history::export(&f.app).await.unwrap();
    let legacy = json_ok(
        f.admin(Method::GET, "/lookup/entities")
            .query(&[("kind", "user"), ("id", "person")]),
    )
    .await;
    let context = json_ok(
        f.admin(Method::GET, "/lookup/entities/context")
            .query(&[("kind", "user"), ("id", "person")]),
    )
    .await;
    for field in [
        "kind",
        "id",
        "first_seen",
        "metadata",
        "associations",
        "associations_next_cursor",
    ] {
        assert_eq!(legacy[field], context[field]);
    }
    assert_eq!(context["associations"][0], assertion);
    assert!(context.get("recent_events").is_none());
    assert!(context.get("recent_decisions").is_none());
    assert!(legacy.get("observed_at").is_none());
    for metric in context["metrics"].as_object().unwrap().values() {
        assert_eq!(metric["provenance"]["observed_at"], context["observed_at"]);
    }
    // A second HTTP listener shares this fixture's PostgreSQL/Valkey clients;
    // only its ClickHouse endpoint is unavailable. No store is stopped or altered.
    let unavailable = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", unavailable.local_addr().unwrap());
    drop(unavailable);
    let mut config = Config::load().unwrap();
    config.clickhouse_url = endpoint;
    let mut failed_app = f.app.clone();
    failed_app.config = Arc::new(config);
    let (url, server) = Fixture::serve(failed_app).await;
    let read = |path: &str| {
        f.http
            .get(format!("{url}/v1/admin/lookup/entities{path}"))
            .header("cookie", &f.cookie)
            .header("origin", &f.app.config.admin_origin)
    };
    let healthy = json_ok(read("/context?kind=user&id=person")).await;
    assert_eq!(healthy["metadata"], json!({"plan":"trial"}));
    assert_eq!(
        json_ok(read("/relationships?kind=user&id=person")).await["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        read("?kind=user&id=person").send().await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let at = clock(&f).await;
    let unavailable = read(&format!(
        "/timeline?kind=user&id=person&from={}&to={at}",
        at - 60_000
    ))
    .send()
    .await
    .unwrap();
    assert_eq!(unavailable.status(), StatusCode::SERVICE_UNAVAILABLE);
    let error = unavailable.json::<Value>().await.unwrap();
    assert!(error.get("items").is_none());
    server.abort();
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn timeline_admission_response_bounds_and_recovery_are_shared_with_analytics() {
    let f = fixture().await;
    let at = clock(&f).await - 1000;
    let held = f.app.analytics_queries.acquire_many(2).await.unwrap();
    assert_eq!(
        request(&f, "user", "u", at, at)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        f.admin(Method::GET, "/analytics/activity")
            .query(&[
                ("kind", "event"),
                ("from", &at.to_string()),
                ("to", &at.to_string())
            ])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    drop(held);
    let mut records = String::new();
    for n in 0..103 {
        let id = format!("event_{n:03}");
        let mut payload = event(&id, at, "u");
        payload["properties"] = json!({"detail":"x".repeat(16_000)});
        records.push_str(&format!("{}\n",json!({"kind":"event","id":format!("event:{id}"),"at":at,"revision":1,"payload":payload.to_string()})));
    }
    history::clickhouse(
        &f.app,
        &format!(
            "INSERT INTO {} (kind,id,at,payload,revision) FORMAT JSONEachRow",
            history::table(&f.app, true)
        ),
        vec![],
        Some(records),
    )
    .await
    .unwrap();
    let response = request(&f, "user", "u", at, at)
        .query(&[("limit", "100")])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.bytes().await.unwrap();
    assert!(
        bytes.len() < 100_000,
        "bounded summaries exclude 1.6 MB of event properties"
    );
    let page: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page["items"].as_array().unwrap().len(), 100);
    let next = json_ok(
        request(&f, "user", "u", at, at)
            .query(&[("cursor", page["next_cursor"].as_str().unwrap())]),
    )
    .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 3);
    // A malformed retained scalar must fail the whole requested page, not be
    // skipped or converted into an empty history. A narrower scope can recover.
    let mut malformed = event("malformed", at, "bad");
    malformed["occurred_at"] = json!({"not":"a timestamp"});
    insert(&f, "event", "malformed", at, 1, malformed).await;
    assert_eq!(
        request(&f, "user", "bad", at, at)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        json_ok(request(&f, "user", "u", at, at)).await["items"]
            .as_array()
            .unwrap()
            .len(),
        50
    );
    eprintln!("timeline 100-row summary response bytes={}", bytes.len());
    f.finish().await;
}
