//! Outside-in protocol tests against the real three-store deployment. Run with
//! the documented KRINE_* environment and `cargo test -p krine-server --test
//! runtime -- --ignored --test-threads=1`; this suite creates isolated IDs.
use krine_server::{App, config::Config};
use redis::AsyncCommands;
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

struct Runtime {
    app: App,
    url: String,
    http: Client,
    server: tokio::task::JoinHandle<()>,
    worker: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::watch::Sender<bool>,
    cookie: String,
    csrf: String,
}
impl Runtime {
    async fn start() -> Self {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .try_init();
        let app = App::connect(Config::load().expect("test configuration"))
            .await
            .expect("real databases");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = krine_server::router(app.clone());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let (shutdown, rx) = tokio::sync::watch::channel(false);
        let worker = tokio::spawn(krine_server::worker(app.clone(), rx));
        let http = Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap();
        let response = http
            .post(format!("{url}/v1/admin/session"))
            .header("origin", &app.config.admin_origin)
            .json(&json!({"password":app.config.admin_password}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let csrf = response.json::<Value>().await.unwrap()["csrf_token"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            app,
            url,
            http,
            server,
            worker,
            shutdown,
            cookie,
            csrf,
        }
    }
    fn server(&self, path: &str) -> RequestBuilder {
        self.http
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.app.config.server_secret)
    }
    fn browser(&self, path: &str) -> RequestBuilder {
        self.http
            .post(format!("{}{path}", self.url))
            .header("origin", &self.app.config.allowed_origins[0])
            .header("x-krine-public-key", &self.app.config.public_key)
    }
    fn admin(&self, method: reqwest::Method, path: &str, key: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/v1/admin{path}", self.url))
            .header("origin", &self.app.config.admin_origin)
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .header("idempotency-key", key)
    }
    async fn context(&self) -> Value {
        ok(self
            .browser("/v1/browser/context")
            .json(&json!({"signals":{"webdriver":false}})))
        .await
    }
    async fn proof(&self, context: &Value, check: &str) -> Value {
        ok(self.browser("/v1/browser/proofs").json(&json!({"client_token":context["client_token"],"session_token":context["session_token"],"check":check}))).await
    }
    async fn create(&self, name: &str, policy: Value) {
        ok(self
            .admin(reqwest::Method::POST, "/checks", &unique())
            .json(&json!({"name":name,"description":"Runtime test"})))
        .await;
        let draft = ok(self
            .admin(
                reqwest::Method::PUT,
                &format!("/checks/{name}/draft"),
                &unique(),
            )
            .json(&json!({"revision":1,"description":"Runtime test","policy":policy})))
        .await;
        assert_eq!(draft["draft_revision"], 2);
        ok(self
            .admin(
                reqwest::Method::POST,
                &format!("/checks/{name}/publications"),
                &unique(),
            )
            .json(&json!({"revision":2,"expected_active_version":null})))
        .await;
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.server.abort();
        self.worker.abort();
    }
}
fn unique() -> String {
    format!("test_{:032x}", rand::random::<u128>())
}
async fn ok(builder: RequestBuilder) -> Value {
    let response = builder.send().await.expect("HTTP request");
    let status = response.status();
    let body: Value = response.json().await.expect("JSON response");
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn error(builder: RequestBuilder, status: StatusCode, code: &str) {
    let response = builder.send().await.unwrap();
    assert_eq!(response.status(), status);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], code);
    assert!(body["error"]["request_id"].is_string());
}
fn request(operation: &str, check: &str, proof: &Value) -> Value {
    json!({"operation_id":operation,"check":check,"proof":proof["proof"],"ip":"127.0.0.1"})
}

#[tokio::test]
#[ignore = "requires PostgreSQL, Valkey, ClickHouse and KRINE_* configuration"]
async fn secure_vertical_slice_and_recovery() {
    let runtime = Runtime::start().await;
    let check = unique();
    runtime.create(&check,json!({"schema_version":1,"inputs":{},"rules":[{"id":"velocity","condition":{"op":"compare","left":{"source":"metric","name":"session.event_count_5m","version":1},"comparison":"gte","value":1},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    let context = runtime.context().await;
    let resolved = ok(runtime.server("/v1/contexts/resolve").json(
        &json!({"client_token":context["client_token"],"session_token":context["session_token"]}),
    ))
    .await;
    assert_eq!(resolved["client_id"], context["client_id"]);
    assert_eq!(resolved["session_id"], context["session_id"]);
    let other = runtime.context().await;
    error(
        runtime.server("/v1/contexts/resolve").json(
            &json!({"client_token":other["client_token"],"session_token":context["session_token"]}),
        ),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_context",
    )
    .await;
    error(
        runtime
            .browser("/v1/browser/proofs")
            .json(&json!({"client_token":"invalid","session_token":"invalid","check":check})),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_context",
    )
    .await;
    let proof = runtime.proof(&context, &check).await;
    let operation = unique();
    let initial = request(&operation, &check, &proof);
    let allowed = ok(runtime.server("/v1/checks/evaluate").json(&initial)).await;
    assert_eq!(allowed["outcome"], "ALLOW");
    // Final response is byte-for-byte the same JSON value after changed policy,
    // later events and loss of the ephemeral proof credential.
    let event = json!({"event_id":unique(),"name":"login","client_id":context["client_id"],"session_id":context["session_id"],"ip":"::ffff:127.0.0.1","properties":{"number":1,"object":{"z":true,"a":"v"}}});
    let accepted = ok(runtime.server("/v1/events").json(&event)).await;
    assert_eq!(accepted["duplicate"], false);
    let mut normalized = event.clone();
    normalized["ip"] = json!("127.0.0.1");
    normalized["properties"]["number"] = json!(1.0);
    let duplicate = ok(runtime.server("/v1/events").json(&normalized)).await;
    assert_eq!(duplicate["duplicate"], true);
    assert_eq!(duplicate["accepted_at"], accepted["accepted_at"]);
    let mut changed = event.clone();
    changed["properties"]["number"] = json!(2);
    error(
        runtime.server("/v1/events").json(&changed),
        StatusCode::CONFLICT,
        "input_conflict",
    )
    .await;
    let new_proof = runtime.proof(&context, &check).await;
    let denied =
        ok(runtime
            .server("/v1/checks/evaluate")
            .json(&request(&unique(), &check, &new_proof)))
        .await;
    assert_eq!(denied["outcome"], "DENY");
    let detail = ok(runtime.admin(
        reqwest::Method::GET,
        &format!(
            "/activity/decisions/{}",
            denied["decision_id"].as_str().unwrap()
        ),
        &unique(),
    ))
    .await;
    assert_eq!(
        detail["snapshot"]["metrics"]["session.event_count_5m"]["state"]["value"],
        1.0
    );
    assert_eq!(
        detail["snapshot"]["metrics"]["ip.risk"]["state"]["status"],
        "unknown"
    );
    assert!(
        !detail
            .to_string()
            .contains(proof["proof"].as_str().unwrap())
    );
    assert_eq!(
        ok(runtime.server("/v1/checks/evaluate").json(&initial)).await,
        allowed
    );
    let mut changed = initial.clone();
    changed["ip"] = json!("127.0.0.2");
    error(
        runtime.server("/v1/checks/evaluate").json(&changed),
        StatusCode::CONFLICT,
        "input_conflict",
    )
    .await;
    let mut replay = initial.clone();
    replay["operation_id"] = json!(unique());
    error(
        runtime.server("/v1/checks/evaluate").json(&replay),
        StatusCode::CONFLICT,
        "proof_used",
    )
    .await;
    // A claimed but not finalized operation survives process cancellation.
    sqlx::query("UPDATE operations SET response=NULL,detail=NULL WHERE id=$1")
        .bind(&operation)
        .execute(&runtime.app.db)
        .await
        .unwrap();
    assert_eq!(
        ok(runtime.server("/v1/checks/evaluate").json(&initial)).await,
        allowed
    );
    // A restored old watermark cannot advertise empty known counters.
    let generation: String =
        sqlx::query_scalar("SELECT generation FROM projection_state WHERE singleton=true")
            .fetch_one(&runtime.app.db)
            .await
            .unwrap();
    let _: () = runtime
        .app
        .redis
        .clone()
        .set("krine:projection:watermark", "-1")
        .await
        .unwrap();
    ok(runtime.http.get(format!("{}/health/ready", runtime.url))).await;
    let new_generation: String =
        sqlx::query_scalar("SELECT generation FROM projection_state WHERE singleton=true")
            .fetch_one(&runtime.app.db)
            .await
            .unwrap();
    assert_ne!(generation, new_generation);
    let rebuilt = ok(runtime.server("/v1/checks/evaluate").json(&request(
        &unique(),
        &check,
        &runtime.proof(&context, &check).await,
    )))
    .await;
    assert_eq!(rebuilt["outcome"], "DENY");
    // Concurrent distinct events and exact duplicates each contribute once.
    let start = Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for n in 0..16 {
        let mut input = event.clone();
        if n >= 8 {
            input["event_id"] = json!(unique());
        }
        let builder = runtime.server("/v1/events").json(&input);
        tasks.spawn(async move { ok(builder).await });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    let proof = runtime.proof(&context, &check).await;
    let op = unique();
    let evaluated = ok(runtime
        .server("/v1/checks/evaluate")
        .json(&request(&op, &check, &proof)))
    .await;
    let detail = ok(runtime.admin(
        reqwest::Method::GET,
        &format!(
            "/activity/decisions/{}",
            evaluated["decision_id"].as_str().unwrap()
        ),
        &unique(),
    ))
    .await;
    assert_eq!(
        detail["snapshot"]["metrics"]["session.event_count_5m"]["state"]["value"],
        9.0
    );
    eprintln!(
        "16 concurrent ingestion requests + decision completed in {} ms",
        start.elapsed().as_millis()
    );
    // Competing operations cannot share one proof, including in-flight calls.
    let proof = runtime.proof(&context, &check).await;
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..12 {
        let builder =
            runtime
                .server("/v1/checks/evaluate")
                .json(&request(&unique(), &check, &proof));
        tasks.spawn(async move {
            let response = builder.send().await.unwrap();
            (response.status(), response.json::<Value>().await.unwrap())
        });
    }
    let mut successes = 0;
    while let Some(result) = tasks.join_next().await {
        let (status, body) = result.unwrap();
        if status == StatusCode::OK {
            successes += 1;
        } else {
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["error"]["code"], "proof_used");
        }
    }
    assert_eq!(successes, 1);
    // The sampling timestamp follows projection contention and rebuilding.
    let edge = r_context_event(&runtime, &check).await;
    let edge_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        - 299_600;
    sqlx::query("UPDATE events SET accepted_at=$1 WHERE id=$2")
        .bind(edge_at)
        .bind(edge.1["event_id"].as_str().unwrap())
        .execute(&runtime.app.db)
        .await
        .unwrap();
    let mut hold = runtime.app.db.begin().await.unwrap();
    sqlx::query("SELECT singleton FROM projection_state WHERE singleton=true FOR UPDATE")
        .execute(&mut *hold)
        .await
        .unwrap();
    let _: () = runtime
        .app
        .redis
        .clone()
        .set("krine:projection:generation", "force-rebuild")
        .await
        .unwrap();
    let attempt = runtime
        .server("/v1/checks/evaluate")
        .json(&request(&unique(), &check, &edge.2));
    let concurrent = tokio::spawn(async move { ok(attempt).await });
    tokio::time::sleep(Duration::from_millis(650)).await;
    hold.commit().await.unwrap();
    let response = concurrent.await.unwrap();
    assert!(response["accepted_at"].as_i64().unwrap() - edge_at >= 300_000);
    let recorded = ok(runtime.admin(
        reqwest::Method::GET,
        &format!(
            "/activity/decisions/{}",
            response["decision_id"].as_str().unwrap()
        ),
        &unique(),
    ))
    .await;
    assert_eq!(
        recorded["snapshot"]["metrics"]["session.event_count_5m"]["state"]["value"],
        0.0
    );
    // Application restart restores final responses from PostgreSQL.
    let restarted = Runtime::start().await;
    assert_eq!(
        ok(restarted.server("/v1/checks/evaluate").json(&initial)).await,
        allowed
    );
    sqlx::query("UPDATE operations SET retry_until=0 WHERE id=$1")
        .bind(&operation)
        .execute(&runtime.app.db)
        .await
        .unwrap();
    error(
        runtime.server("/v1/checks/evaluate").json(&initial),
        StatusCode::UNPROCESSABLE_ENTITY,
        "operation_expired",
    )
    .await;
    error(
        runtime.server("/v1/checks/evaluate").json(&changed),
        StatusCode::CONFLICT,
        "input_conflict",
    )
    .await;
    let entity = ok(runtime.admin(
        reqwest::Method::GET,
        &format!(
            "/entities/session/{}",
            context["session_id"].as_str().unwrap()
        ),
        &unique(),
    ))
    .await;
    assert_eq!(entity["kind"], "session");
    assert_eq!(entity["metadata"]["provenance"], "browser");
    assert_eq!(
        entity["metrics"]["session.event_count_5m"]["state"]["value"],
        9.0
    );
    // Historical lists use ClickHouse; exporter may lag ingestion.
    let mut exported = false;
    for _ in 0..20 {
        let response = runtime
            .admin(
                reqwest::Method::GET,
                &format!("/activity/decisions?check={check}&operation_id={operation}"),
                &unique(),
            )
            .send()
            .await
            .unwrap();
        if response.status() == StatusCode::OK
            && !response.json::<Value>().await.unwrap()["items"]
                .as_array()
                .unwrap()
                .is_empty()
        {
            exported = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert!(exported, "durable outbox reached ClickHouse");
}

#[tokio::test]
#[ignore = "requires PostgreSQL, Valkey, ClickHouse and KRINE_* configuration"]
async fn hostile_boundaries_and_policy_editing() {
    let r = Runtime::start().await;
    error(
        r.http
            .post(format!("{}/v1/events", r.url))
            .bearer_auth(&r.app.config.public_key)
            .json(&json!({})),
        StatusCode::UNAUTHORIZED,
        "unauthenticated",
    )
    .await;
    error(
        r.browser("/v1/browser/context")
            .header("origin", "https://hostile.example")
            .json(&json!({})),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    error(
        r.browser("/v1/browser/context")
            .header("x-krine-public-key", "bad")
            .json(&json!({})),
        StatusCode::UNAUTHORIZED,
        "unauthenticated",
    )
    .await;
    error(
        r.browser("/v1/browser/context")
            .json(&json!({"user_id":"forged"})),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_input",
    )
    .await;
    error(
        r.server("/v1/events")
            .header("content-type", "application/json")
            .body("{\"name\":\"a\",\"name\":\"b\"}"),
        StatusCode::BAD_REQUEST,
        "invalid_json",
    )
    .await;
    error(
        r.server("/v1/events")
            .header("content-type", "application/json")
            .body("x".repeat(65537)),
        StatusCode::PAYLOAD_TOO_LARGE,
        "body_too_large",
    )
    .await;
    error(
        r.admin(reqwest::Method::POST, "/checks", &unique())
            .header("x-csrf-token", "invalid")
            .json(&json!({"name":unique()})),
        StatusCode::FORBIDDEN,
        "forbidden",
    )
    .await;
    let check = unique();
    let key = unique();
    let input = json!({"name":check});
    let created = ok(r.admin(reqwest::Method::POST, "/checks", &key).json(&input)).await;
    assert_eq!(created["draft"]["otherwise"], "DENY");
    assert_eq!(
        ok(r.admin(reqwest::Method::POST, "/checks", &key).json(&input)).await,
        created
    );
    error(
        r.admin(reqwest::Method::POST, "/checks", &key)
            .json(&json!({"name":unique()})),
        StatusCode::CONFLICT,
        "input_conflict",
    )
    .await;
    // Deepest supported core condition survives HTTP decoding and serialization.
    let mut condition =
        json!({"op":"known","value":{"source":"metric","name":"ip.risk","version":1}});
    for _ in 0..7 {
        condition = json!({"op":"all","conditions":[condition]});
    }
    let policy = json!({"schema_version":1.0,"inputs":{},"rules":[{"id":"risk","condition":condition,"then":"CHALLENGE","on_unknown":"DENY"}],"otherwise":"DENY"});
    ok(r.admin(
        reqwest::Method::PUT,
        &format!("/checks/{check}/draft"),
        &unique(),
    )
    .json(&json!({"revision":1,"description":"","policy":policy})))
    .await;
    error(
        r.admin(
            reqwest::Method::POST,
            &format!("/checks/{check}/publications"),
            &unique(),
        )
        .json(&json!({"revision":2,"expected_active_version":null})),
        StatusCode::UNPROCESSABLE_ENTITY,
        "capability_unconfigured",
    )
    .await;
    error(r.admin(reqwest::Method::PUT,&format!("/checks/{check}/draft"),&unique()).json(&json!({"revision":1,"description":"","policy":{"schema_version":1,"otherwise":"ALLOW"}})),StatusCode::CONFLICT,"revision_conflict").await;
    ok(r.admin(
        reqwest::Method::PUT,
        &format!("/checks/{check}/draft"),
        &unique(),
    )
    .json(
        &json!({"revision":2,"description":"","policy":{"schema_version":1,"otherwise":"ALLOW"}}),
    ))
    .await;
    let publish = json!({"revision":3,"expected_active_version":null});
    let key = unique();
    let published = ok(r
        .admin(
            reqwest::Method::POST,
            &format!("/checks/{check}/publications"),
            &key,
        )
        .json(&publish))
    .await;
    assert_eq!(published["version"], 1);
    assert_eq!(
        ok(r.admin(
            reqwest::Method::POST,
            &format!("/checks/{check}/publications"),
            &key
        )
        .json(&publish))
        .await,
        published
    );
    error(
        r.admin(
            reqwest::Method::POST,
            &format!("/checks/{check}/publications"),
            &unique(),
        )
        .json(&publish),
        StatusCode::CONFLICT,
        "revision_conflict",
    )
    .await;
    let context = r.context().await;
    let proof=ok(r.browser("/v1/browser/proofs").header("x-forwarded-for","203.0.113.99").json(&json!({"client_token":context["client_token"],"session_token":context["session_token"],"check":check}))).await;
    let mut bad = request(&unique(), &check, &proof);
    bad["ip"] = json!("203.0.113.99");
    error(
        r.server("/v1/checks/evaluate").json(&bad),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_proof",
    )
    .await;
    assert_eq!(
        ok(r.server("/v1/checks/evaluate")
            .json(&request(&unique(), &check, &proof)))
        .await["outcome"],
        "ALLOW"
    );
    let immutable = ok(r.admin(
        reqwest::Method::GET,
        &format!("/checks/{check}/versions/1"),
        &unique(),
    ))
    .await;
    assert_eq!(immutable["version"], 1);
    assert_eq!(immutable["policy"]["otherwise"], "ALLOW");
    // Untrusted client identifiers cannot select a context via backend resolver.
    error(
        r.server("/v1/contexts/resolve")
            .json(&json!({"client_id":context["client_id"],"session_id":context["session_id"]})),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_input",
    )
    .await;
    let association = json!({"association_id":unique(),"client_id":context["client_id"],"user_id":"test-user","metadata":{"account":"trusted"}});
    let created = ok(r.server("/v1/associations").json(&association)).await;
    assert_eq!(created["provenance"], "backend");
    assert_eq!(
        ok(r.server("/v1/associations").json(&association)).await,
        created
    );
    let row = sqlx::query("SELECT COUNT(*) AS count FROM associations WHERE id=$1")
        .bind(association["association_id"].as_str().unwrap())
        .fetch_one(&r.app.db)
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("count"), 1);
}

async fn r_context_event(runtime: &Runtime, check: &str) -> (Value, Value, Value) {
    let context = runtime.context().await;
    let event = json!({"event_id":unique(),"name":"boundary","client_id":context["client_id"],"session_id":context["session_id"]});
    ok(runtime.server("/v1/events").json(&event)).await;
    let proof = runtime.proof(&context, check).await;
    (context, event, proof)
}

#[tokio::test]
#[ignore = "requires PostgreSQL, Valkey, ClickHouse and KRINE_* configuration"]
async fn large_decision_pages_and_typed_entity_history() {
    let runtime = Runtime::start().await;
    let check = unique();
    let condition = json!({"op":"all","conditions":(0..255).map(|_| json!({"op":"compare","left":{"source":"input","name":"value"},"comparison":"eq","value":"different"})).collect::<Vec<_>>()});
    runtime.create(&check,json!({"schema_version":1,"inputs":{"value":"string"},"rules":[{"id":"large_trace","condition":condition,"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    let context = runtime.context().await;
    let mut decision_ids = Vec::new();
    for _ in 0..30 {
        let proof = runtime.proof(&context, &check).await;
        let mut body = request(&unique(), &check, &proof);
        body["inputs"] = json!({"value":"x".repeat(1024)});
        let result = ok(runtime.server("/v1/checks/evaluate").json(&body)).await;
        assert_eq!(result["outcome"], "ALLOW");
        decision_ids.push(result["decision_id"].as_str().unwrap().to_owned());
    }
    let detail = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/activity/decisions/{}", decision_ids[0]),
        &unique(),
    ))
    .await;
    assert!(serde_json::to_vec(&detail).unwrap().len() > 280_000);
    assert_eq!(
        detail["evaluation"]["trace"][0]["condition"]["children"]
            .as_array()
            .unwrap()
            .len(),
        255
    );

    // Application user identifiers may equal Krine client identifiers. They
    // remain different entities even when their textual identifiers collide.
    let user = context["client_id"].as_str().unwrap();
    let user_event = unique();
    ok(runtime
        .server("/v1/events")
        .json(&json!({"event_id":user_event,"name":"user_only","user_id":user})))
    .await;
    let other_context = runtime.context().await;
    let proof = runtime.proof(&other_context, &check).await;
    let mut body = request(&unique(), &check, &proof);
    body["inputs"] = json!({"value":"x".repeat(1024)});
    body["user_id"] = json!(user);
    let user_decision = ok(runtime.server("/v1/checks/evaluate").json(&body)).await;
    let user_decision_id = user_decision["decision_id"].as_str().unwrap();
    let mut exported_ids = decision_ids
        .iter()
        .map(|id| format!("decision:{id}"))
        .collect::<Vec<_>>();
    exported_ids.push(format!("decision:{user_decision_id}"));
    exported_ids.push(format!("event:{user_event}"));
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM outbox WHERE id=ANY($1) AND exported_at IS NOT NULL",
            )
            .bind(&exported_ids)
            .fetch_one(&runtime.app.db)
            .await
            .unwrap();
            if count == exported_ids.len() as i64 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("large valid decision details reach ClickHouse");

    // The default page and maximum requested page must return only summaries,
    // even though their corresponding full details exceed the 8 MiB read cap.
    for suffix in ["", "&limit=100"] {
        let page = ok(runtime.admin(
            reqwest::Method::GET,
            &format!("/activity/decisions?check={check}{suffix}"),
            &unique(),
        ))
        .await;
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 31);
        assert!(page["next_cursor"].is_null());
        assert!(serde_json::to_vec(&page).unwrap().len() < 65_536);
        let summary = items
            .iter()
            .find(|item| item["decision_id"] == decision_ids[0])
            .unwrap();
        for field in [
            "decision_id",
            "operation_id",
            "check",
            "policy_version",
            "outcome",
            "reason",
            "accepted_at",
            "completed_at",
            "client_id",
            "session_id",
            "user_id",
            "ip",
            "source",
        ] {
            assert_eq!(summary[field], detail[field], "summary field {field}");
        }
        assert!(summary["user_id"].is_null());
        assert!(summary["policy_version"].is_number());
        assert!(summary["accepted_at"].is_number());
        assert!(summary["completed_at"].is_number());
        assert!(summary.get("policy").is_none());
        assert!(summary.get("snapshot").is_none());
        assert!(summary.get("evaluation").is_none());
        assert_eq!(
            items
                .iter()
                .find(|item| item["decision_id"] == user_decision_id)
                .unwrap()["user_id"],
            user
        );
    }
    let page = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/activity/decisions?check={check}&limit=20"),
        &unique(),
    ))
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 20);
    let cursor = page["next_cursor"].as_str().unwrap();
    let next = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/activity/decisions?check={check}&limit=20&cursor={cursor}"),
        &unique(),
    ))
    .await;
    assert_eq!(next["items"].as_array().unwrap().len(), 11);
    assert!(next["next_cursor"].is_null());
    assert!(!page["items"].as_array().unwrap().iter().any(|first| {
        next["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|second| first["decision_id"] == second["decision_id"])
    }));

    let entity = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/entities/user/{user}"),
        &unique(),
    ))
    .await;
    let events = entity["recent_events"].as_array().unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["event_id"], user_event);
    let decisions = entity["recent_decisions"].as_array().unwrap();
    assert_eq!(decisions.len(), 1);
    assert_eq!(decisions[0]["decision_id"], user_decision_id);
    assert_eq!(decisions[0]["client_id"], other_context["client_id"]);
    let client = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/entities/client/{user}"),
        &unique(),
    ))
    .await;
    assert_eq!(client["recent_decisions"].as_array().unwrap().len(), 20);
    assert!(
        client["recent_decisions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|decision| decision["client_id"] == user && decision["user_id"].is_null())
    );
    assert!(
        client["recent_events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["name"] == "browser.context" && event["provenance"] == "browser")
    );
    assert!(
        client["recent_events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["client_id"] == user && event["event_id"] != user_event)
    );
    // General activity search intentionally matches an identifier across kinds.
    let broad = ok(runtime.admin(
        reqwest::Method::GET,
        &format!("/activity/decisions?check={check}&entity={user}&limit=100"),
        &unique(),
    ))
    .await;
    assert_eq!(broad["items"].as_array().unwrap().len(), 31);
}
