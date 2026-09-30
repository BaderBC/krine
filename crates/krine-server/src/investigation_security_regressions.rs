//! Regressions from independent subject security review; isolated fixtures only.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

type StalledReads = (
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<AtomicUsize>,
    Arc<tokio::sync::Semaphore>,
);

async fn fixture() -> Fixture {
    let f = Fixture::new().await;
    eprintln!("subject security owns {}", f.schema);
    assert!(history::initialize(&f.app).await.unwrap());
    analytics::initialize(&f.app).await.unwrap();
    f
}
async fn at(f: &Fixture) -> i64 {
    sqlx::query_scalar::<_, i64>("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(&f.app.db)
        .await
        .unwrap()
        - 30_000
}
fn timeline(f: &Fixture, base: &str, at: i64) -> RequestBuilder {
    f.http
        .get(format!("{base}/v1/admin/lookup/entities/timeline"))
        .header("cookie", &f.cookie)
        .query(&[
            ("kind", "user"),
            ("id", "security-user"),
            ("from", &at.to_string()),
            ("to", &at.to_string()),
        ])
}
async fn event(f: &Fixture, at: i64, user: &str) {
    let payload = json!({"event_id":"security-event","name":"accepted","accepted_at":at,"user_id":user,"provenance":"backend"});
    let body = format!(
        "{}\n",
        json!({"kind":"event","id":"event:security-event","at":at,"revision":1,"payload":payload.to_string()})
    );
    history::clickhouse(
        &f.app,
        &format!(
            "INSERT INTO {} (kind,id,at,payload,revision) FORMAT JSONEachRow",
            history::table(&f.app, true)
        ),
        vec![],
        Some(body),
    )
    .await
    .unwrap();
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn security_invalid_utf8_cannot_select_a_different_subject() {
    let f = fixture().await;
    let at = at(&f).await;
    event(&f, at, "\u{fffd}").await;
    sqlx::query("INSERT INTO entities(kind,id,first_seen,metadata) VALUES('user',$1,$2,'{}')")
        .bind("\u{fffd}")
        .bind(at)
        .execute(&f.app.db)
        .await
        .unwrap();
    let mut results = Vec::new();
    for route in ["timeline", "context"] {
        for selector in ["%EF%BF%BD", "%FF", "%C0%AF", "%E7%95", "%", "%1", "%GG"] {
            let url = format!(
                "{}/v1/admin/lookup/entities/{route}?kind=user&id={selector}{}",
                f.url,
                if route == "timeline" {
                    format!("&from={at}&to={at}")
                } else {
                    String::new()
                }
            );
            let response = f
                .http
                .get(url)
                .header("cookie", &f.cookie)
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body: Value = response.json().await.unwrap();
            results.push((
                route.to_owned(),
                selector.to_owned(),
                status.as_u16(),
                body.get("scope").cloned(),
                body.get("id").cloned(),
                body.get("items").and_then(Value::as_array).map(Vec::len),
            ));
        }
    }
    for (route, extra) in [
        ("/activity/events", String::new()),
        (
            "/analytics/activity",
            format!("&kind=event&from={at}&to={at}"),
        ),
    ] {
        for selector in ["%EF%BF%BD", "%FF", "%E7%95"] {
            let response = f
                .http
                .get(format!(
                    "{}/v1/admin{route}?entity_kind=user&entity={selector}{extra}",
                    f.url
                ))
                .header("cookie", &f.cookie)
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body: Value = response.json().await.unwrap();
            eprintln!(
                "shared UTF8 route={route}, selector={selector}, status={status}, scope={}, records={:?}, totals={}",
                body["scope"],
                body.get("items").and_then(Value::as_array).map(Vec::len),
                body["totals"]
            );
            results.push((
                route.to_owned(),
                selector.to_owned(),
                status.as_u16(),
                body.get("scope").cloned(),
                None,
                body.get("items").and_then(Value::as_array).map(Vec::len),
            ));
        }
    }
    eprintln!("UTF8 boundary observations: {results:?}");
    f.finish().await;
    assert!(
        results
            .iter()
            .filter(|r| r.1 != "%EF%BF%BD")
            .all(|r| r.2 == 422),
        "Invalid UTF8 must be rejected, not rewritten to a different subject: {results:?}"
    );
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn security_authentication_query_aliases_and_forged_cursors() {
    let f = fixture().await;
    let at = at(&f).await;
    event(&f, at, "security-user").await;
    let paths = [
        "/v1/admin/lookup/entities/timeline",
        "/v1/%61dmin/lookup/entities/timeline",
        "/v1/admin%2flookup/entities/timeline",
        "//v1/admin/lookup/entities/timeline",
        "/v1/admin/lookup/entities/context",
    ];
    for path in paths {
        for method in [Method::GET, Method::HEAD] {
            let response = f
                .http
                .request(method.clone(), format!("{}{path}", f.url))
                .bearer_auth(&f.app.config.server_secret)
                .query(&[
                    ("kind", "user"),
                    ("id", "security-user"),
                    ("from", &at.to_string()),
                    ("to", &at.to_string()),
                ])
                .send()
                .await
                .unwrap();
            assert!(
                !response.status().is_success(),
                "server credential authorized admin {method} {path}"
            );
        }
    }
    for suffix in [
        "&%69d=other",
        "&k%69nd=client",
        "&%66rom=0",
        "&cursor=a&curs%6fr=b",
        "&id[]=other",
        "&id%00=other",
        "&from=9223372036854775808",
        "&%FF=x",
        "&i%=x",
        "&i%1=x",
    ] {
        let response=f.http.get(format!("{}/v1/admin/lookup/entities/timeline?kind=user&id=security-user&from={at}&to={at}{suffix}",f.url)).header("cookie",&f.cookie).send().await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{suffix}"
        );
    }
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let scope = util::digest(
        serde_json::to_vec(
            &json!({"timeline":1,"kind":"user","id":"security-user","from":at,"to":at}),
        )
        .unwrap(),
    );
    // Recomputed digest is public by design; a invented valid position still
    // cannot remove the independent exact subject or time predicates.
    let forged =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&(1, at, "event", "event:zzzz", scope)).unwrap());
    let page = json_ok(timeline(&f, &f.url, at).query(&[("cursor", forged)])).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["summary"]["user_id"], "security-user");
    let wrong_scope = URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&(1, at, "event", "event:zzzz", "x".repeat(64))).unwrap());
    assert_eq!(
        timeline(&f, &f.url, at)
            .query(&[("cursor", wrong_scope)])
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    sqlx::query("DELETE FROM admin_sessions")
        .execute(&f.app.db)
        .await
        .unwrap();
    assert_eq!(
        timeline(&f, &f.url, at).send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(f.app.analytics_queries.available_permits(), 2);
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn security_cancelled_reads_and_shared_admission_remain_bounded() {
    let f = fixture().await;
    let at = at(&f).await;
    sqlx::query(
        "INSERT INTO entities(kind,id,first_seen,metadata) VALUES('user','security-user',$1,'{}')",
    )
    .bind(at)
    .execute(&f.app.db)
    .await
    .unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(AtomicUsize::new(0));
    let peaks = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let state = (active.clone(), entered.clone(), peaks.clone(), gate.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let mock = Router::new()
        .fallback(post(
            |State((active, entered, peaks, gate)): State<StalledReads>| async move {
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peaks.fetch_max(now, Ordering::SeqCst);
                entered.fetch_add(1, Ordering::SeqCst);
                let permit = gate.acquire().await.unwrap();
                permit.forget();
                active.fetch_sub(1, Ordering::SeqCst);
                ""
            },
        ))
        .with_state(state);
    let proxy = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut app = f.app.clone();
    let mut config = Config::load().unwrap();
    config.clickhouse_url = endpoint;
    app.config = Arc::new(config);
    let (url, server) = Fixture::serve(app.clone()).await;
    let one = tokio::spawn(timeline(&f, &url, at).send());
    let two = tokio::spawn(timeline(&f, &url, at).send());
    for _ in 0..100 {
        if entered.load(Ordering::SeqCst) == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(entered.load(Ordering::SeqCst), 2);
    assert_eq!(app.analytics_queries.available_permits(), 0);
    let overflow = timeline(&f, &url, at).send().await.unwrap();
    assert_eq!(overflow.status(), StatusCode::SERVICE_UNAVAILABLE);
    let trend = f
        .http
        .get(format!("{url}/v1/admin/analytics/activity"))
        .header("cookie", &f.cookie)
        .query(&[
            ("kind", "event"),
            ("from", &at.to_string()),
            ("to", &at.to_string()),
        ])
        .send()
        .await
        .unwrap();
    assert_eq!(trend.status(), StatusCode::SERVICE_UNAVAILABLE);
    let context = json_ok(
        f.http
            .get(format!(
                "{url}/v1/admin/lookup/entities/context?kind=user&id=security-user"
            ))
            .header("cookie", &f.cookie),
    )
    .await;
    assert_eq!(context["id"], "security-user");
    one.abort();
    two.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let permits_after_abort = app.analytics_queries.available_permits();
    let recovery = tokio::spawn(timeline(&f, &url, at).send());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let peak = peaks.load(Ordering::SeqCst);
    eprintln!(
        "cancel observations: permits_after_abort={permits_after_abort}, dependency_entered={}, dependency_active={}, peak={peak}",
        entered.load(Ordering::SeqCst),
        active.load(Ordering::SeqCst)
    );
    gate.add_permits(4);
    let _ = recovery.await.unwrap().unwrap();
    for _ in 0..100 {
        if app.analytics_queries.available_permits() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(app.analytics_queries.available_permits(), 2);
    server.abort();
    proxy.abort();
    f.finish().await;
    assert!(
        peak <= 2,
        "Aborting callers bypassed analytical admission, peak={peak}"
    );
}

async fn active_slots(f: &Fixture) -> usize {
    let mut active = 0;
    for id in f.app.analytical_reads.query_ids() {
        let response = f
            .app
            .http
            .post(&f.app.config.clickhouse_url)
            .basic_auth(
                &f.app.config.clickhouse_user,
                Some(&f.app.config.clickhouse_password),
            )
            .query(&[
                ("database", "krine"),
                ("query", "SELECT 1"),
                ("query_id", id),
                ("replace_running_query", "0"),
            ])
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .body("")
            .send()
            .await
            .unwrap();
        let code = response
            .headers()
            .get("x-clickhouse-exception-code")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let status = response.status();
        let _ = response.bytes().await.unwrap();
        if code == "216" {
            active += 1;
        } else {
            assert!(status.is_success(), "collision status={status} code={code}");
        }
    }
    active
}
fn bounded_query() -> String {
    format!(
        "SELECT sleepEachRow(0.02) FROM numbers(100) SETTINGS {},max_result_rows=101,max_result_bytes=2097152,result_overflow_mode='throw' FORMAT JSONEachRow",
        analytics::QUERY_BUDGET
    )
}
fn owned_read(app: App) -> tokio::task::JoinHandle<Result<String>> {
    tokio::spawn(async move {
        let permit = app
            .analytics_queries
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::unavailable())?;
        app.analytical_reads
            .clone()
            .run(permit, async move {
                history::clickhouse(
                    &app,
                    &bounded_query(),
                    vec![
                        ("wait_end_of_query", "1".into()),
                        ("buffer_size", "2097152".into()),
                    ],
                    None,
                )
                .await
            })
            .await
    })
}
async fn wait_for_no_slots(f: &Fixture) {
    for _ in 0..100 {
        if active_slots(f).await == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("owned bounded ClickHouse reads did not finish");
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn real_clickhouse_caller_cancellation_retains_owned_slots_until_completion() {
    let f = fixture().await;
    let first = owned_read(f.app.clone());
    let second = owned_read(f.app.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(active_slots(&f).await, 2);
    first.abort();
    second.abort();
    tokio::time::sleep(Duration::from_millis(200)).await;
    let after_abort = active_slots(&f).await;
    assert_eq!(after_abort, 2);
    assert_eq!(f.app.analytics_queries.available_permits(), 0);
    assert!(owned_read(f.app.clone()).await.unwrap().is_err());
    assert_eq!(active_slots(&f).await, 2);
    wait_for_no_slots(&f).await;
    for _ in 0..100 {
        if f.app.analytics_queries.available_permits() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(f.app.analytics_queries.available_permits(), 2);
    eprintln!(
        "real caller cancellation: after_abort={after_abort}, newly admitted dependency reads=0, final=0"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn real_clickhouse_timeout_keeps_slot_identity_fencing_unknown_execution() {
    let f = fixture().await;
    let mut app = f.app.clone();
    app.http = reqwest::Client::builder()
        .timeout(Duration::from_millis(150))
        .build()
        .unwrap();
    let first = owned_read(app.clone());
    let second = owned_read(app);
    assert!(first.await.unwrap().is_err());
    assert!(second.await.unwrap().is_err());
    let after_timeout = active_slots(&f).await;
    assert_eq!(after_timeout, 2);
    assert_eq!(f.app.analytics_queries.available_permits(), 2);
    // Local jobs have bounded lifetimes; their fixed dependency IDs remain
    // exclusive until ClickHouse itself releases the earlier execution.
    for _ in 0..3 {
        assert!(owned_read(f.app.clone()).await.unwrap().is_err());
        assert_eq!(active_slots(&f).await, 2);
    }
    wait_for_no_slots(&f).await;
    assert!(owned_read(f.app.clone()).await.unwrap().is_ok());
    eprintln!(
        "real timeout: after_timeout={after_timeout}, three same-slot attempts rejected, successful recovery"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn graceful_shutdown_drains_caller_abandoned_reads_and_closes_admission() {
    let f = fixture().await;
    let first = owned_read(f.app.clone());
    let second = owned_read(f.app.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(active_slots(&f).await, 2);
    first.abort();
    second.abort();
    let started = Instant::now();
    f.app.shutdown_analytics().await;
    assert!(started.elapsed() >= Duration::from_millis(500));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(active_slots(&f).await, 0);
    assert!(owned_read(f.app.clone()).await.unwrap().is_err());
    eprintln!(
        "shutdown drained abandoned reads in {} ms with no remaining dependency execution",
        started.elapsed().as_millis()
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn fresh_application_generation_has_new_slots_and_does_not_claim_a_fleet_limit() {
    let f = fixture().await;
    let old_ids = f.app.analytical_reads.query_ids().clone();
    let mut timed = f.app.clone();
    timed.http = reqwest::Client::builder()
        .timeout(Duration::from_millis(150))
        .build()
        .unwrap();
    let one = owned_read(timed.clone());
    let two = owned_read(timed);
    assert!(one.await.unwrap().is_err());
    assert!(two.await.unwrap().is_err());
    assert_eq!(active_slots(&f).await, 2);
    // Recreate the same in-memory admission state as a new application process.
    // This is not a claim to have restarted the OS process or the stores.
    let mut fresh = f.app.clone();
    fresh.analytics_queries = Arc::new(tokio::sync::Semaphore::new(2));
    fresh.analytical_reads = Arc::new(analytical_reads::Reads::default());
    assert!(
        fresh
            .analytical_reads
            .query_ids()
            .iter()
            .all(|id| !old_ids.contains(id))
    );
    let three = owned_read(fresh.clone());
    let four = owned_read(fresh.clone());
    tokio::time::sleep(Duration::from_millis(200)).await;
    let old_active = active_slots(&f).await;
    let mut fresh_active = 0;
    for id in fresh.analytical_reads.query_ids() {
        let response = f
            .app
            .http
            .post(&f.app.config.clickhouse_url)
            .basic_auth(
                &f.app.config.clickhouse_user,
                Some(&f.app.config.clickhouse_password),
            )
            .query(&[
                ("database", "krine"),
                ("query", "SELECT 1"),
                ("query_id", id),
            ])
            .header(reqwest::header::CONTENT_LENGTH, 0)
            .body("")
            .send()
            .await
            .unwrap();
        if response
            .headers()
            .get("x-clickhouse-exception-code")
            .and_then(|v| v.to_str().ok())
            == Some("216")
        {
            fresh_active += 1;
        }
        let _ = response.bytes().await.unwrap();
    }
    assert_eq!((old_active, fresh_active), (2, 2));
    assert!(three.await.unwrap().is_ok());
    assert!(four.await.unwrap().is_ok());
    fresh.shutdown_analytics().await;
    wait_for_no_slots(&f).await;
    eprintln!(
        "generation boundary: old={old_active}, fresh={fresh_active}; per-instance cap is not fleet/restart-wide; all reads finished"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn shutdown_of_stalled_transport_has_a_whole_job_deadline() {
    let f = fixture().await;
    let entered = Arc::new(AtomicUsize::new(0));
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let mock = Router::new().fallback(post(
        |State((entered, gate)): State<(Arc<AtomicUsize>, Arc<tokio::sync::Semaphore>)>| async move {
            entered.fetch_add(1, Ordering::SeqCst);
            let permit = gate.acquire().await.unwrap();
            permit.forget();
            ""
        },
    )).with_state((entered.clone(), gate.clone()));
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut config = Config::load().unwrap();
    config.clickhouse_url = endpoint;
    let mut app = f.app.clone();
    app.config = Arc::new(config);
    let one = owned_read(app.clone());
    let two = owned_read(app.clone());
    for _ in 0..100 {
        if entered.load(Ordering::SeqCst) == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(entered.load(Ordering::SeqCst), 2);
    one.abort();
    two.abort();
    let started = Instant::now();
    app.shutdown_analytics().await;
    assert!(started.elapsed() >= Duration::from_secs(4));
    assert!(started.elapsed() < Duration::from_secs(6));
    assert_eq!(app.analytics_queries.available_permits(), 2);
    assert!(owned_read(app.clone()).await.unwrap().is_err());
    gate.add_permits(2);
    tokio::time::sleep(Duration::from_millis(50)).await;
    server.abort();
    eprintln!(
        "stalled-transport shutdown drained local jobs in {} ms; dependency completion remains explicitly unknown",
        started.elapsed().as_millis()
    );
    f.finish().await;
}

type CapturedQueries = Vec<(String, Option<String>)>;

#[derive(Clone)]
struct PreparationProbe {
    requests: Arc<Mutex<CapturedQueries>>,
    gate: Arc<tokio::sync::Semaphore>,
    definition: String,
}

#[tokio::test]
#[ignore = "requires guarded isolated stores"]
async fn cancelled_preparation_retains_ownership_and_scopes_every_dependency_call() {
    let f = fixture().await;
    let at = at(&f).await;
    sqlx::query(
        "UPDATE analytical_migrations SET completed=false WHERE name='activity_scalars_v1'",
    )
    .execute(&f.app.db)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO entities(kind,id,first_seen,metadata) VALUES('user','security-user',$1,'{}')",
    )
    .bind(at)
    .execute(&f.app.db)
    .await
    .unwrap();
    let definition = history::clickhouse(
        &f.app,
        &format!(
            "DESCRIBE TABLE {} FORMAT JSONEachRow",
            history::table(&f.app, true)
        ),
        vec![],
        None,
    )
    .await
    .unwrap();
    let state = PreparationProbe {
        requests: Arc::new(Mutex::new(Vec::new())),
        gate: Arc::new(tokio::sync::Semaphore::new(0)),
        definition,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let mock =
        Router::new()
            .fallback(
                post(
                    |State(state): State<PreparationProbe>,
                     axum::extract::Query(params): axum::extract::Query<
                        BTreeMap<String, String>,
                    >| async move {
                        if params.contains_key("query_id") {
                            assert_eq!(
                                params.get("replace_running_query").map(String::as_str),
                                Some("0")
                            );
                        }
                        state
                            .requests
                            .lock()
                            .unwrap()
                            .push((params["query"].clone(), params.get("query_id").cloned()));
                        let permit = state.gate.acquire().await.unwrap();
                        permit.forget();
                        if params["query"].starts_with("DESCRIBE TABLE") {
                            state.definition.clone()
                        } else {
                            String::new()
                        }
                    },
                ),
            )
            .with_state(state.clone());
    let proxy = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut config = Config::load().unwrap();
    config.clickhouse_url = endpoint;
    let mut app = f.app.clone();
    app.config = Arc::new(config);
    let (url, server) = Fixture::serve(app.clone()).await;
    let one = tokio::spawn(timeline(&f, &url, at).send());
    let two = tokio::spawn(timeline(&f, &url, at).send());
    for _ in 0..100 {
        if !state.requests.lock().unwrap().is_empty()
            && app.analytics_queries.available_permits() == 0
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.requests.lock().unwrap().len(), 1);
    assert_eq!(app.analytics_queries.available_permits(), 0);
    one.abort();
    two.abort();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        app.analytics_queries.available_permits(),
        0,
        "preparation remains owned after caller cancellation"
    );
    assert_eq!(
        timeline(&f, &url, at).send().await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let context = json_ok(
        f.http
            .get(format!(
                "{url}/v1/admin/lookup/entities/context?kind=user&id=security-user"
            ))
            .header("cookie", &f.cookie),
    )
    .await;
    assert_eq!(context["id"], "security-user");
    assert_eq!(
        state.requests.lock().unwrap().len(),
        1,
        "context does not query analytical storage"
    );
    state.gate.add_permits(10);
    for _ in 0..100 {
        if app.analytics_queries.available_permits() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(app.analytics_queries.available_permits(), 2);
    // Ordinary worker/helper work outside the owned future must not acquire
    // its task-local ID or contend for an analytical slot.
    history::clickhouse(&app, "SELECT 1", vec![], None)
        .await
        .unwrap();
    let requests = state.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 5);
    assert!(requests[0].0.starts_with("ALTER TABLE"));
    assert!(requests[1].0.starts_with("DESCRIBE TABLE"));
    assert_eq!(requests[0].1, requests[1].1);
    assert!(requests[0].1.is_some());
    let final_ids = requests[2..4]
        .iter()
        .map(|(query, id)| {
            assert!(query.starts_with("SELECT at,kind,id"));
            id.as_ref().unwrap().clone()
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(final_ids.len(), 2);
    assert_eq!(
        final_ids,
        app.analytical_reads.query_ids().iter().cloned().collect()
    );
    assert_eq!(requests[4], ("SELECT 1".into(), None));
    eprintln!(
        "cancelled preparation: 2 owned operations, overflow rejected, setup/final reads scoped, context independent and ordinary call unscoped"
    );
    server.abort();
    proxy.abort();
    f.finish().await;
}
