//! Requires three isolated stores; KRINE_PROVIDER_TEST_VALKEY_URL points at test Valkey.
//! Every test owns its PostgreSQL schema and ClickHouse tables. Never migrates live data.
use super::*;
use axum::{
    Json,
    extract::{Path, State},
    routing::{get, post},
};
use reqwest::{Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Instant,
};

mod protected_application;

#[derive(Default)]
struct MockState {
    tokens: BTreeMap<String, Value>,
    calls: Vec<Value>,
    ip_calls: usize,
    ip_body: Option<Value>,
    ip_delay_ms: u64,
    delay_ms: u64,
}
struct Fixture {
    app: App,
    http: reqwest::Client,
    url: String,
    cookie: String,
    csrf: String,
    actor_id: String,
    schema: String,
    admin: PgPool,
    server: tokio::task::JoinHandle<()>,
    mock_server: tokio::task::JoinHandle<()>,
    mock: Arc<Mutex<MockState>>,
}
fn unique() -> String {
    format!("pt_{:032x}", rand::random::<u128>())
}
async fn json_ok(request: RequestBuilder) -> Value {
    let path = request
        .try_clone()
        .unwrap()
        .build()
        .unwrap()
        .url()
        .path()
        .to_owned();
    let response = request.send().await.unwrap();
    let status = response.status();
    let body: Value = response.json().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{path}: {body}");
    body
}
async fn rejected(request: RequestBuilder, code: &str) {
    let response = request.send().await.unwrap();
    assert!(response.status().is_client_error());
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"]["code"],
        code
    );
}
impl Fixture {
    async fn new() -> Self {
        Self::with_browser_origin(None).await
    }
    async fn with_browser_origin(origin: Option<String>) -> Self {
        let _ = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .try_init();
        let mut config = Config::load().unwrap();
        if let Some(origin) = origin {
            config.allowed_origins = vec![origin];
        }
        config.valkey_url = std::env::var("KRINE_PROVIDER_TEST_VALKEY_URL")
            .expect("dedicated test Valkey required");
        config.server_rate = 100000;
        config.browser_rate = 100000;
        config.login_rate = 100000;
        let admin = PgPool::connect(&config.database_url).await.unwrap();
        let schema = unique();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let mut url = reqwest::Url::parse(&config.database_url).unwrap();
        url.query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        config.database_url = url.to_string();
        let mut app = App::connect(config).await.unwrap();
        app.provider_test.history_suffix = schema.clone();
        let mock = Arc::new(Mutex::new(MockState::default()));
        let mock_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", mock_listener.local_addr().unwrap());
        app.provider_test.ip_endpoint = Some(format!("{endpoint}/ip/"));
        app.provider_test.verify_endpoint = Some(format!("{endpoint}/verify"));
        let mock_router = Router::new()
            .route("/ip/{ip}", get(mock_ip))
            .route("/verify", post(mock_verify))
            .with_state(mock.clone());
        let mock_server = tokio::spawn(async move {
            axum::serve(mock_listener, mock_router).await.unwrap();
        });
        let (url, server) = Self::serve(app.clone()).await;
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap();
        let enrollment=http.post(format!("{url}/v1/admin/auth/bootstrap"))
            .header("origin",&app.config.admin_origin)
            .json(&json!({"installation_secret":app.config.admin_password,"sign_in_name":"fixture","name":"Fixture operator"}))
            .send().await.unwrap();
        assert_eq!(enrollment.status(), StatusCode::OK);
        let enrollment: Value = enrollment.json().await.unwrap();
        let actor_id = enrollment["operator"]["id"].as_str().unwrap().to_owned();
        let login = http
            .post(format!("{url}/v1/admin/session"))
            .header("origin", &app.config.admin_origin)
            .json(&json!({"sign_in_name":"fixture","credential":enrollment["credential"]}))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let cookie = login.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let csrf = login.json::<Value>().await.unwrap()["csrf_token"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            app,
            http,
            url,
            cookie,
            csrf,
            actor_id,
            schema,
            admin,
            server,
            mock_server,
            mock,
        }
    }
    async fn restart(&mut self) {
        self.restart_with_capacity(self.app.config.max_pending_outbox)
            .await;
    }
    async fn restart_with_capacity(&mut self, capacity: i64) {
        self.server.abort();
        let mut config = Config::load().unwrap();
        config.database_url = self.app.config.database_url.clone();
        config.valkey_url = self.app.config.valkey_url.clone();
        config.clickhouse_url = self.app.config.clickhouse_url.clone();
        config.server_rate = 100000;
        config.browser_rate = 100000;
        config.login_rate = 100000;
        config.max_pending_outbox = capacity;
        let mut app = App::connect(config).await.unwrap();
        app.provider_test = self.app.provider_test.clone();
        let (url, server) = Self::serve(app.clone()).await;
        self.app = app;
        self.url = url;
        self.server = server;
    }
    async fn serve(app: App) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router(app).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (url, server)
    }
    fn admin(&self, method: Method, path: &str) -> RequestBuilder {
        self.admin_key(method, path, &unique())
    }
    fn admin_key(&self, method: Method, path: &str, key: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/v1/admin{path}", self.url))
            .header("origin", &self.app.config.admin_origin)
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .header("x-krine-operator-id", &self.actor_id)
            .header("idempotency-key", key)
    }
    fn backend(&self, input: &Value) -> RequestBuilder {
        self.http
            .post(format!("{}/v1/checks/evaluate", self.url))
            .bearer_auth(&self.app.config.server_secret)
            .json(input)
    }
    fn browser(&self, path: &str, input: &Value) -> RequestBuilder {
        self.http
            .post(format!("{}/v1/browser/{path}", self.url))
            .header("origin", &self.app.config.allowed_origins[0])
            .header("x-krine-public-key", &self.app.config.public_key)
            .json(input)
    }
    async fn configure(&self, capability: &str, revision: i64, secret: &str) -> Value {
        let provider = if capability == "verification" {
            "turnstile"
        } else {
            "proxycheck"
        };
        let config = if capability == "verification" {
            json!({"secret":secret,"site_key":"real-site-key"})
        } else {
            json!({"secret":secret})
        };
        let candidate =
            json!({"revision":revision,"provider":provider,"enabled":true,"config":config});
        let tested = json_ok(
            self.admin(Method::POST, &format!("/providers/{capability}/tests"))
                .json(&candidate),
        )
        .await;
        assert_eq!(
            tested["status"],
            if capability == "verification" {
                "configuration_checked"
            } else {
                "ready"
            }
        );
        let mut save = candidate;
        save["test_token"] = tested["test_token"].clone();
        save["acknowledge_dependents"] = json!(true);
        save["reviewed_dependents_token"] = tested["dependents_token"].clone();
        json_ok(
            self.admin(Method::PUT, &format!("/providers/{capability}"))
                .json(&save),
        )
        .await
    }
    async fn policy(&self, name: &str, policy: Value) {
        json_ok(
            self.admin(Method::POST, "/checks")
                .json(&json!({"name":name})),
        )
        .await;
        json_ok(
            self.admin(Method::PUT, &format!("/checks/{name}/draft"))
                .json(&json!({"revision":1,"description":"Provider integration","policy":policy})),
        )
        .await;
        json_ok(
            self.admin(Method::POST, &format!("/checks/{name}/publications"))
                .json(&json!({"revision":2,"expected_active_version":null})),
        )
        .await;
    }
    async fn attempt(&self, name: &str) -> (Value, Value) {
        let context = json_ok(self.browser("context", &json!({}))).await;
        let proof=json_ok(self.browser("proofs",&json!({"client_token":context["client_token"],"session_token":context["session_token"],"check":name}))).await;
        let input =
            json!({"operation_id":unique(),"check":name,"proof":proof["proof"],"ip":"127.0.0.1"});
        let response = json_ok(self.backend(&input)).await;
        (input, response)
    }
    fn token(&self, challenge: &Value) -> String {
        let token = unique();
        let timestamp = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap();
        self.mock.lock().unwrap().tokens.insert(token.clone(),json!({"success":true,"hostname":"localhost","action":"krine_verify","cdata":challenge["binding"],"challenge_ts":timestamp}));
        token
    }
    async fn detail(&self, response: &Value) -> Value {
        json_ok(self.admin(
            Method::GET,
            &format!(
                "/activity/decisions/{}",
                response["decision_id"].as_str().unwrap()
            ),
        ))
        .await
    }
    async fn finish(self) {
        self.server.abort();
        self.app.shutdown_analytics().await;
        self.mock_server.abort();
        for table in [
            format!("history_{}", self.schema),
            format!("history_v2_{}", self.schema),
        ] {
            history::clickhouse(
                &self.app,
                &format!("DROP TABLE IF EXISTS {table}"),
                vec![],
                None,
            )
            .await
            .unwrap();
        }
        self.app.db.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
    }
}
async fn mock_ip(
    State(state): State<Arc<Mutex<MockState>>>,
    Path(ip): Path<String>,
) -> Json<Value> {
    let (delay, body) = {
        let mut state = state.lock().unwrap();
        state.ip_calls += 1;
        (state.ip_delay_ms, state.ip_body.clone().unwrap_or_else(||json!({"status":"ok",ip:{"detections":{"risk":91,"proxy":true},"location":{"country_code":"US"}}})))
    };
    tokio::time::sleep(Duration::from_millis(delay)).await;
    Json(body)
}
async fn mock_verify(
    State(state): State<Arc<Mutex<MockState>>>,
    Json(input): Json<Value>,
) -> Json<Value> {
    let (delay, result) = {
        let mut state = state.lock().unwrap();
        state.calls.push(input.clone());
        (
            state.delay_ms,
            state
                .tokens
                .get(input["response"].as_str().unwrap())
                .cloned()
                .unwrap_or(json!({"success":false,"error-codes":["invalid-input-response"]})),
        )
    };
    tokio::time::sleep(Duration::from_millis(delay)).await;
    Json(result)
}
fn challenge_policy(count: usize) -> Value {
    json!({"schema_version":1,"rules":(0..count).map(|n|json!({"id":format!("verify_{n}"),"condition":{"op":"known","value":{"source":"metric","name":"client.age_seconds","version":1}},"then":"CHALLENGE","on_unknown":"DENY"})).collect::<Vec<_>>(),"otherwise":"ALLOW"})
}
fn continuation(input: &Value, pending: &Value, token: &str) -> Value {
    let mut body = input.clone();
    body["verification"] =
        json!({"challenge_id":pending["challenge"]["challenge_id"],"token":token});
    body
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_admin_enrichment_and_bound_continuations() {
    let f = Fixture::new().await;
    let summary = f.configure("verification", 0, "initial-secret").await;
    assert_eq!(summary["revision"], 1);
    assert_eq!(summary["status"], "configuration_checked");
    assert!(summary["config"].get("secret").is_none());
    let check = unique();
    f.policy(&check, challenge_policy(2)).await;
    let (input, pending) = f.attempt(&check).await;
    assert_eq!(pending["outcome"], "CHALLENGE_REQUIRED");
    let pending_detail = f.detail(&pending).await;
    assert_eq!(json_ok(f.backend(&input)).await, pending);
    assert_eq!(f.mock.lock().unwrap().calls.len(), 0);
    let secret_sql: Value = sqlx::query_scalar("SELECT envelope FROM operations WHERE id=$1")
        .bind(input["operation_id"].as_str().unwrap())
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert!(!secret_sql.to_string().contains("initial-secret"));
    // Configuration and policy changes do not alter this attempt.
    f.configure("verification", 1, "replacement-secret").await;
    json_ok(f.admin(Method::PUT,&format!("/checks/{check}/draft")).json(&json!({"revision":2,"description":"Changed","policy":{"schema_version":1,"rules":[],"otherwise":"DENY"}}))).await;
    json_ok(
        f.admin(Method::POST, &format!("/checks/{check}/publications"))
            .json(&json!({"revision":3,"expected_active_version":1})),
    )
    .await;
    let token = f.token(&pending["challenge"]);
    let body = continuation(&input, &pending, &token);
    let second = json_ok(f.backend(&body)).await;
    assert_eq!(second["outcome"], "CHALLENGE_REQUIRED");
    assert_ne!(
        second["challenge"]["challenge_id"],
        pending["challenge"]["challenge_id"]
    );
    assert_eq!(
        second["challenge"]["expires_at"],
        pending["challenge"]["expires_at"]
    );
    assert_eq!(json_ok(f.backend(&body)).await, second);
    assert_eq!(json_ok(f.backend(&input)).await, second);
    rejected(
        f.backend(&continuation(&input, &second, &token)),
        "verification_used",
    )
    .await;
    let next_token = f.token(&second["challenge"]);
    let final_result = json_ok(f.backend(&continuation(&input, &second, &next_token))).await;
    assert_eq!(final_result["outcome"], "ALLOW");
    assert_eq!(final_result["policy_version"], 1);
    assert_eq!(json_ok(f.backend(&input)).await, final_result);
    assert!(
        f.mock
            .lock()
            .unwrap()
            .calls
            .iter()
            .all(|c| c["secret"] == "initial-secret")
    );
    let detail = f.detail(&final_result).await;
    assert_eq!(
        detail["verification_transitions"].as_array().unwrap().len(),
        6
    );
    assert_eq!(detail["provider_revisions"]["verification"]["revision"], 1);
    assert!(!detail.to_string().contains(&token));
    assert!(!detail.to_string().contains("initial-secret"));
    // Deliver all revisions, then deliberately deliver an old pending payload last.
    history::export(&f.app).await.unwrap();
    let delayed = json!({"kind":"decision","id":format!("decision:{}",pending["decision_id"].as_str().unwrap()),"at":pending["accepted_at"],"payload":pending_detail.to_string(),"revision":1});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{delayed}\n")),
    )
    .await
    .unwrap();
    let page = json_ok(f.admin(Method::GET, &format!("/activity/decisions?check={check}"))).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["outcome"], "ALLOW");
    // Intelligence is only fetched for used metrics, and preserves revision/time in the frozen snapshot.
    f.configure("ip_intelligence", 0, "ip-secret").await;
    let calls = f.mock.lock().unwrap().ip_calls;
    let simple = unique();
    f.policy(
        &simple,
        json!({"schema_version":1,"rules":[],"otherwise":"ALLOW"}),
    )
    .await;
    f.attempt(&simple).await;
    assert_eq!(f.mock.lock().unwrap().ip_calls, calls);
    let risk = unique();
    f.policy(&risk,json!({"schema_version":1,"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.high_risk","version":1},"comparison":"eq","value":true},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    let (risk_input, risk_result) = f.attempt(&risk).await;
    assert_eq!(risk_result["outcome"], "DENY");
    let detail = f.detail(&risk_result).await;
    assert_eq!(
        detail["snapshot"]["metrics"]["ip.risk"]["state"]["value"],
        0.91
    );
    assert_eq!(
        detail["snapshot"]["metrics"]["ip.risk"]["provenance"]["source"],
        "proxycheck@1"
    );
    f.attempt(&risk).await;
    assert_eq!(f.mock.lock().unwrap().ip_calls, calls + 1);
    assert_eq!(json_ok(f.backend(&risk_input)).await, risk_result);
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_races_crash_recovery_fencing_and_expiry() {
    let mut f = Fixture::new().await;
    f.configure("verification", 0, "pinned-secret").await;
    let check = unique();
    f.policy(&check, challenge_policy(1)).await;
    let (input, pending) = f.attempt(&check).await;
    let token = f.token(&pending["challenge"]);
    let body = continuation(&input, &pending, &token);
    f.mock.lock().unwrap().delay_ms = 400;
    let request = f.backend(&body);
    let running = tokio::spawn(async move { json_ok(request).await });
    for _ in 0..100 {
        if !f.mock.lock().unwrap().calls.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(json_ok(f.backend(&input)).await, pending);
    rejected(f.backend(&body), "operation_in_progress").await;
    rejected(
        f.backend(&continuation(&input, &pending, "different-token")),
        "input_conflict",
    )
    .await;
    // The provider call holds no transaction/advisory lock.
    let start = Instant::now();
    let mut tx = f.app.db.begin().await.unwrap();
    let locked: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!(
                "operation:{}",
                input["operation_id"].as_str().unwrap()
            ))
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(locked);
    tx.rollback().await.unwrap();
    assert!(start.elapsed() < Duration::from_millis(200));
    let allowed = running.await.unwrap();
    assert_eq!(allowed["outcome"], "ALLOW");
    assert_eq!(f.mock.lock().unwrap().calls.len(), 1);
    let (other, other_pending) = f.attempt(&check).await;
    rejected(
        f.backend(&continuation(&other, &other_pending, &token)),
        "verification_used",
    )
    .await;
    assert_eq!(json_ok(f.backend(&other)).await, other_pending);
    f.mock.lock().unwrap().delay_ms = 0;
    // Stop after successful provider response, before commit. Only digests/UUID survive.
    let (crash_input, crash_pending) = f.attempt(&check).await;
    let crash_token = f.token(&crash_pending["challenge"]);
    let crash_body = continuation(&crash_input, &crash_pending, &crash_token);
    let pause = Arc::new(VerificationPause::default());
    let mut stalled = f.app.clone();
    stalled.provider_test.after_verification = Some(pause.clone());
    let (stalled_url, stalled_server) = Fixture::serve(stalled).await;
    let request = f
        .http
        .post(format!("{stalled_url}/v1/checks/evaluate"))
        .bearer_auth(&f.app.config.server_secret)
        .json(&crash_body);
    let task = tokio::spawn(async move { request.send().await });
    tokio::time::timeout(Duration::from_secs(3), pause.arrived.notified())
        .await
        .unwrap();
    let stored =
        sqlx::query("SELECT token_digest,verification_uuid FROM challenge_steps WHERE id=$1")
            .bind(crash_pending["challenge"]["challenge_id"].as_str().unwrap())
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(
        stored.get::<String, _>("token_digest"),
        util::digest(&crash_token)
    );
    sqlx::query("UPDATE operations SET lease_until=$1 WHERE id=$2")
        .bind(util::now() - 1)
        .bind(crash_input["operation_id"].as_str().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    f.restart().await;
    let recovered = json_ok(f.backend(&crash_body)).await;
    assert_eq!(recovered["outcome"], "ALLOW");
    let attempts = f
        .mock
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|c| c["response"] == crash_token)
        .cloned()
        .collect::<Vec<_>>();
    assert_eq!(attempts.len(), 2);
    assert_eq!(
        attempts[0]["idempotency_key"],
        attempts[1]["idempotency_key"]
    );
    assert_eq!(
        attempts[0]["idempotency_key"],
        stored.get::<String, _>("verification_uuid")
    );
    // Release the stale worker. Its fence cannot alter the recovered final result.
    pause.resume.notify_one();
    let stale = task.await.unwrap().unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_eq!(json_ok(f.backend(&crash_input)).await, recovered);
    stalled_server.abort();
    // A lost original bearer cannot be reconstructed: an ordinary recovery fails closed.
    let (lost, lost_pending) = f.attempt(&check).await;
    let lost_token = f.token(&lost_pending["challenge"]);
    let lost_body = continuation(&lost, &lost_pending, &lost_token);
    let pause = Arc::new(VerificationPause::default());
    let mut stalled = f.app.clone();
    stalled.provider_test.after_verification = Some(pause.clone());
    let (url, server) = Fixture::serve(stalled).await;
    let request = f
        .http
        .post(format!("{url}/v1/checks/evaluate"))
        .bearer_auth(&f.app.config.server_secret)
        .json(&lost_body);
    let task = tokio::spawn(async move { request.send().await });
    tokio::time::timeout(Duration::from_secs(3), pause.arrived.notified())
        .await
        .unwrap();
    sqlx::query("UPDATE operations SET lease_until=$1 WHERE id=$2")
        .bind(util::now() - 1)
        .bind(lost["operation_id"].as_str().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    let denied = json_ok(f.backend(&lost)).await;
    assert_eq!(denied["outcome"], "DENY");
    assert_eq!(denied["reason"], "verification_unavailable");
    pause.resume.notify_one();
    assert_eq!(task.await.unwrap().unwrap().status(), StatusCode::CONFLICT);
    server.abort();
    // A pending attempt expires in the worker even without a browser continuation.
    sqlx::query("UPDATE operations SET accepted_at=$1 WHERE id=$2")
        .bind(util::now() - 300_001)
        .bind(other["operation_id"].as_str().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    checks::expire_pending(&f.app).await.unwrap();
    let expired = json_ok(f.backend(&other)).await;
    assert_eq!(expired["outcome"], "DENY");
    assert_eq!(expired["reason"], "verification_expired");
    let mut changed = other;
    changed["ip"] = json!("127.0.0.2");
    rejected(f.backend(&changed), "input_conflict").await;
    assert!(
        sqlx::query("SELECT id FROM outbox LIMIT 1")
            .fetch_all(&f.app.db)
            .await
            .is_err()
    );
    // Old generation connections fail visibly instead of acknowledging new history.
    let mut legacy = f.app.db.acquire().await.unwrap();
    sqlx::query("SET krine.writer_generation='2'")
        .execute(&mut *legacy)
        .await
        .unwrap();
    let error =
        sqlx::query("UPDATE delivery_outbox SET exported_at=1 WHERE id=(SELECT id FROM delivery_outbox LIMIT 1)")
            .execute(&mut *legacy)
            .await
            .unwrap_err();
    assert!(error.to_string().contains("stop the old server"));
    sqlx::query("SET krine.writer_generation='6'")
        .execute(&mut *legacy)
        .await
        .unwrap();
    drop(legacy);
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_candidate_guards_partial_unknowns_and_outage_denial() {
    let f = Fixture::new().await;
    let candidate = json!({"revision":0,"provider":"turnstile","enabled":true,"config":{"site_key":"public-key","secret":"candidate-secret"}});
    let test = json_ok(
        f.admin(Method::POST, "/providers/verification/tests")
            .json(&candidate),
    )
    .await;
    assert_eq!(test["status"], "configuration_checked");
    assert_eq!(f.mock.lock().unwrap().calls.len(), 0);
    let mut changed = candidate.clone();
    changed["config"]["secret"] = json!("changed-secret");
    changed["test_token"] = test["test_token"].clone();
    rejected(
        f.admin(Method::PUT, "/providers/verification")
            .json(&changed),
        "invalid_input",
    )
    .await;
    let mut save = candidate;
    save["test_token"] = test["test_token"].clone();
    let response = json_ok(
        f.admin_key(Method::PUT, "/providers/verification", "save-exact")
            .json(&save),
    )
    .await;
    assert_eq!(
        json_ok(
            f.admin_key(Method::PUT, "/providers/verification", "save-exact")
                .json(&save)
        )
        .await,
        response
    );
    assert!(!response.to_string().contains("candidate-secret"));
    let check = unique();
    f.policy(&check, challenge_policy(1)).await;
    let (input, pending) = f.attempt(&check).await;
    let disconnect = json!({"revision":1,"provider":"turnstile","enabled":false,"config":{}});
    rejected(
        f.admin(Method::PUT, "/providers/verification")
            .json(&disconnect),
        "dependent_checks",
    )
    .await;
    let mut disconnect = disconnect;
    disconnect["acknowledge_dependents"] = json!(true);
    let providers = json_ok(f.admin(Method::GET, "/providers")).await;
    disconnect["reviewed_dependents_token"] = providers["items"][1]["dependents_token"].clone();
    json_ok(
        f.admin(Method::PUT, "/providers/verification")
            .json(&disconnect),
    )
    .await;
    let failed =
        json_ok(f.backend(&continuation(&input, &pending, "invalid-provider-token"))).await;
    assert_eq!(failed["reason"], "verification_failed");
    let fresh = f.attempt(&check).await.1;
    assert_eq!(fresh["reason"], "verification_unavailable");
    f.configure("verification", 2, "timeout-secret").await;
    let (slow, slow_pending) = f.attempt(&check).await;
    let token = f.token(&slow_pending["challenge"]);
    f.mock.lock().unwrap().delay_ms = 2000;
    let start = Instant::now();
    let denied = json_ok(f.backend(&continuation(&slow, &slow_pending, &token))).await;
    assert_eq!(denied["outcome"], "DENY");
    assert_eq!(denied["reason"], "verification_unavailable");
    assert!(start.elapsed() < Duration::from_millis(2300));
    println!(
        "bounded verification timeout: {}ms",
        start.elapsed().as_millis()
    );
    f.configure("ip_intelligence", 0, "ip-secret").await;
    f.mock.lock().unwrap().ip_body = Some(
        json!({"status":"ok","127.0.0.1":{"detections":{"risk":null,"proxy":false},"location":{"country_code":false}}}),
    );
    let risk = unique();
    f.policy(&risk,json!({"schema_version":1,"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.risk","version":1},"comparison":"gte","value":0.8},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    let (_, result) = f.attempt(&risk).await;
    assert_eq!(result["reason"], "unknown_denied");
    let detail = f.detail(&result).await;
    let metrics = &detail["snapshot"]["metrics"];
    assert_eq!(
        metrics["ip.risk"]["state"],
        json!({"status":"unknown","reason":"missing"})
    );
    assert_eq!(
        metrics["ip.country"]["state"],
        json!({"status":"unknown","reason":"invalid"})
    );
    assert_eq!(
        metrics["ip.is_proxy"]["state"],
        json!({"status":"known","value":false})
    );
    // An expired activation token cannot be saved, even with exact candidate content.
    let candidate = json!({"revision":3,"provider":"turnstile","enabled":true,"config":{"secret":"future-secret","site_key":"next-key"}});
    let tested = json_ok(
        f.admin(Method::POST, "/providers/verification/tests")
            .json(&candidate),
    )
    .await;
    sqlx::query("UPDATE provider_tests SET expires_at=0")
        .execute(&f.app.db)
        .await
        .unwrap();
    let mut save = candidate;
    save["test_token"] = tested["test_token"].clone();
    save["acknowledge_dependents"] = json!(true);
    save["reviewed_dependents_token"] = tested["dependents_token"].clone();
    rejected(
        f.admin(Method::PUT, "/providers/verification").json(&save),
        "invalid_input",
    )
    .await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_stale_cache_and_interrupted_history_migration() {
    use redis::AsyncCommands;
    let mut f = Fixture::new().await;
    f.configure("ip_intelligence", 0, "key").await;
    let check = unique();
    f.policy(&check,json!({"schema_version":1,"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.risk","version":1},"comparison":"gte","value":0.8},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"})).await;
    f.attempt(&check).await;
    let key = format!("krine:ip:1:127.0.0.1:{}", f.schema);
    let encoded: String = f.app.redis.clone().get(&key).await.unwrap();
    let mut stale: Value = serde_json::from_str(&encoded).unwrap();
    stale["observed_at_ms"] = json!(util::now() - 60_001);
    stale["risk"] = json!({"status":"known","value":0.0});
    let _: () = f
        .app
        .redis
        .clone()
        .set(&key, stale.to_string())
        .await
        .unwrap();
    f.mock.lock().unwrap().ip_body = Some(json!({"status":"error"}));
    let (_, denied) = f.attempt(&check).await;
    assert_eq!(denied["reason"], "unknown_denied");
    let detail = f.detail(&denied).await;
    assert_eq!(
        detail["snapshot"]["metrics"]["ip.risk"]["state"]["status"],
        "unknown"
    );
    // Backfill copied, but PostgreSQL migration marker was lost: rerun safely.
    history::export(&f.app).await.unwrap();
    let legacy_prefix = unique();
    let mut body = String::new();
    for n in 0..205 {
        let id = format!("{legacy_prefix}_{n:03}");
        body.push_str(&json!({"kind":"event","id":format!("event:{id}"),"at":util::now(),"payload":json!({"event_id":id,"name":"legacy","accepted_at":util::now()}).to_string()}).to_string());
        body.push('\n');
    }
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(body),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM analytical_migrations WHERE name='history_v2'")
        .execute(&f.app.db)
        .await
        .unwrap();
    history::export(&f.app).await.unwrap();
    let first = sqlx::query(
        "SELECT cursor_id,completed FROM analytical_migrations WHERE name='history_v2'",
    )
    .fetch_one(&f.app.db)
    .await
    .unwrap();
    assert!(first.get::<String, _>("cursor_id").ends_with("_099"));
    assert!(!first.get::<bool, _>("completed"));
    f.restart().await;
    history::export(&f.app).await.unwrap();
    let second: String =
        sqlx::query_scalar("SELECT cursor_id FROM analytical_migrations WHERE name='history_v2'")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert!(second.ends_with("_199"));
    history::export(&f.app).await.unwrap();
    history::export(&f.app).await.unwrap();
    let completed: bool =
        sqlx::query_scalar("SELECT completed FROM analytical_migrations WHERE name='history_v2'")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert!(completed);
    // Simulate a lost copy acknowledgement by resetting the checkpoint and
    // repeating all batches; FINAL must still expose exactly one of every row.
    sqlx::query("DELETE FROM analytical_migrations WHERE name='history_v2'")
        .execute(&f.app.db)
        .await
        .unwrap();
    for _ in 0..4 {
        history::export(&f.app).await.unwrap();
    }
    let rows=history::clickhouse(&f.app,&format!("SELECT count() AS count FROM history_v2_{} FINAL WHERE startsWith(id,{{prefix:String}}) FORMAT JSONEachRow",f.schema),vec![("param_prefix",format!("event:{legacy_prefix}"))],None).await.unwrap();
    let count = serde_json::from_str::<Value>(&rows).unwrap()["count"].clone();
    assert!(count == json!(205) || count == json!("205"));
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_publication_and_disconnect_serialize_in_both_orders() {
    for metric in ["ip.risk", "ip.high_risk"] {
        for save_first in [true, false] {
            let f = Fixture::new().await;
            f.configure("ip_intelligence", 0, "key").await;
            let check = unique();
            json_ok(
                f.admin(Method::POST, "/checks")
                    .json(&json!({"name":check})),
            )
            .await;
            let (comparison, value) = if metric == "ip.risk" {
                ("gte", json!(0.8))
            } else {
                ("eq", json!(true))
            };
            let policy = json!({"schema_version":1,"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":metric,"version":1},"comparison":comparison,"value":value},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
            json_ok(
                f.admin(Method::PUT, &format!("/checks/{check}/draft"))
                    .json(&json!({"revision":1,"description":"publication race","policy":policy})),
            )
            .await;
            let save = f
                .admin(Method::PUT, "/providers/ip_intelligence")
                .json(&json!({"revision":1,"provider":"proxycheck","enabled":false,"config":{}}));
            let publish = f
                .admin(Method::POST, &format!("/checks/{check}/publications"))
                .json(&json!({"revision":2,"expected_active_version":null}));
            let mut barrier = f.app.db.begin().await.unwrap();
            if save_first {
                // Stop save after its dependency read but before revision insertion.
                sqlx::query("LOCK TABLE provider_revisions IN SHARE MODE")
                    .execute(&mut *barrier)
                    .await
                    .unwrap();
                let saving = tokio::spawn(async move { json_ok(save).await });
                wait_for_query_lock(&f, "INSERT INTO provider_revisions%").await;
                let publication = tokio::spawn(async move { json_ok(publish).await });
                wait_for_query_lock(
                    &f,
                    "SELECT revision FROM provider_current WHERE capability=$1 FOR SHARE%",
                )
                .await;
                assert!(!publication.is_finished());
                barrier.commit().await.unwrap();
                let disconnected = saving.await.unwrap();
                assert_eq!(disconnected["enabled"], false);
                assert!(
                    disconnected["dependent_checks"]
                        .as_array()
                        .unwrap()
                        .is_empty()
                );
                // Missing IP configuration remains publishable with explicit unknowns.
                assert_eq!(publication.await.unwrap()["version"], 1);
                let (_, denied) = f.attempt(&check).await;
                assert_eq!(denied["reason"], "unknown_denied");
            } else {
                // Stop publication after locking the capability but before insertion.
                sqlx::query("LOCK TABLE policy_versions IN SHARE MODE")
                    .execute(&mut *barrier)
                    .await
                    .unwrap();
                let publication = tokio::spawn(async move { json_ok(publish).await });
                wait_for_query_lock(&f, "INSERT INTO policy_versions%").await;
                let saving = tokio::spawn(async move { rejected(save, "dependent_checks").await });
                wait_for_query_lock(
                    &f,
                    "SELECT revision FROM provider_current WHERE capability=$1 FOR UPDATE%",
                )
                .await;
                assert!(!saving.is_finished());
                barrier.commit().await.unwrap();
                assert_eq!(publication.await.unwrap()["version"], 1);
                saving.await.unwrap();
            }
            f.finish().await;
        }
    }
}
async fn wait_for_query_lock(f: &Fixture, pattern: &str) {
    tokio::time::timeout(Duration::from_millis(600),async{
        loop {
            let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1 AND pid<>pg_backend_pid())").bind(pattern).fetch_one(&f.app.db).await.unwrap();
            if blocked {break;}tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }).await.expect("request reached its database barrier");
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_pin_reads_coherent_revision_after_configuration_lock_wait() {
    let f = Fixture::new().await;
    let policy: krine_core::Policy = serde_json::from_value(json!({
        "schema_version":1,
        "rules":[{"id":"risk","condition":{"op":"known","value":{"source":"metric","name":"ip.risk","version":1}},"then":"CHALLENGE","on_unknown":"DENY"}],
        "otherwise":"DENY"
    }))
    .unwrap();
    let mut initial = f.app.db.begin().await.unwrap();
    let unconfigured = providers::pin(&mut initial, &policy).await.unwrap();
    initial.commit().await.unwrap();
    let mut results = Vec::new();

    for (capability, provider) in [
        ("ip_intelligence", "proxycheck"),
        ("verification", "turnstile"),
    ] {
        // First activation, disconnect, reactivation, and enabled secret rotation.
        for (index, enabled) in [true, false, true, true].into_iter().enumerate() {
            let revision = i64::try_from(index).unwrap() + 1;
            let mut changing = f.app.db.begin().await.unwrap();
            sqlx::query("INSERT INTO provider_revisions(capability,revision,provider,enabled,config,secret,status,message,created_at) VALUES($1,$2,$3,$4,'{}',$5,'configuration_checked','test',0)")
                .bind(capability).bind(revision).bind(provider).bind(enabled)
                .bind(format!("secret-{revision}"))
                .execute(&mut *changing).await.unwrap();
            sqlx::query("UPDATE provider_current SET revision=$1 WHERE capability=$2")
                .bind(revision)
                .bind(capability)
                .execute(&mut *changing)
                .await
                .unwrap();

            let mut reading = f.app.db.begin().await.unwrap();
            let reader_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut *reading)
                .await
                .unwrap();
            let policy = policy.clone();
            let pinning = tokio::spawn(async move {
                let pinned = providers::pin(&mut reading, &policy).await.unwrap();
                reading.commit().await.unwrap();
                pinned
            });
            // Observe the actual row-lock wait, rather than assuming a sleep
            // put the immutable-revision read before the writer's commit.
            tokio::time::timeout(Duration::from_millis(600), async {
                loop {
                    let blocked: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock')")
                        .bind(reader_pid).fetch_one(&f.app.db).await.unwrap();
                    if blocked {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .expect("pin reached the configuration row lock");
            changing.commit().await.unwrap();
            let pinned = pinning.await.unwrap();
            results.push((capability, revision, enabled, pinned));
        }
    }

    f.finish().await;
    assert_eq!(
        unconfigured,
        json!({
            "ip_intelligence":{"revision":0,"enabled":false},
            "verification":{"revision":0,"enabled":false}
        })
    );
    for (capability, revision, enabled, pinned) in results {
        assert_eq!(
            pinned[capability],
            json!({"revision":revision,"enabled":enabled}),
            "{capability} revision {revision} must carry its own enabled state"
        );
    }
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_full_capacity_retains_all_thirty_two_steps_in_one_delivery_slot() {
    let mut f = Fixture::new().await;
    f.configure("verification", 0, "key").await;
    let check = unique();
    f.policy(&check, challenge_policy(32)).await;
    let (input, mut current) = f.attempt(&check).await;
    let initial: i64 =
        sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(initial, 2);
    f.restart_with_capacity(initial).await;
    assert_eq!(
        f.browser("context", &json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    for _ in 0..32 {
        assert_eq!(current["outcome"], "CHALLENGE_REQUIRED");
        let token = f.token(&current["challenge"]);
        current = json_ok(f.backend(&continuation(&input, &current, &token))).await;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
                .fetch_one(&f.app.db)
                .await
                .unwrap();
        assert_eq!(count, initial);
    }
    assert_eq!(current["outcome"], "ALLOW");
    assert_eq!(json_ok(f.backend(&input)).await, current);
    let detail = f.detail(&current).await;
    let transitions = detail["verification_transitions"].as_array().unwrap();
    assert_eq!(transitions.len(), 96);
    for (index, transition) in transitions.iter().enumerate() {
        assert_eq!(transition["sequence"], (index + 1) as i64);
        assert_eq!(
            transition["state"],
            ["pending", "verifying", "passed"][index % 3]
        );
    }
    let logical = format!("decision:{}", current["decision_id"].as_str().unwrap());
    let slots: i64 = sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE logical_id=$1")
        .bind(&logical)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(slots, 1);
    let persisted: i64 =
        sqlx::query_scalar("SELECT count(*) FROM verification_transitions WHERE operation_id=$1")
            .bind(input["operation_id"].as_str().unwrap())
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(persisted, 96);
    history::export(&f.app).await.unwrap();
    let page = json_ok(f.admin(Method::GET, &format!("/activity/decisions?check={check}"))).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["outcome"], "ALLOW");
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_export_acknowledges_only_its_revision_and_reserves_pending_capacity() {
    let mut f = Fixture::new().await;
    f.configure("verification", 0, "key").await;
    let check = unique();
    f.policy(&check, challenge_policy(2)).await;
    let (input, pending) = f.attempt(&check).await;
    let logical = format!("decision:{}", pending["decision_id"].as_str().unwrap());
    let pause = Arc::new(VerificationPause::default());
    let mut exporter = f.app.clone();
    exporter.provider_test.after_export = Some(pause.clone());
    let exporting = tokio::spawn(async move { history::export(&exporter).await });
    tokio::time::timeout(Duration::from_secs(3), pause.arrived.notified())
        .await
        .unwrap();
    // The exporter's immutable read is revision one. Continue while its network
    // result is unacknowledged; it must hold no lock on the coalescing row.
    let token = f.token(&pending["challenge"]);
    let second = json_ok(f.backend(&continuation(&input, &pending, &token))).await;
    assert_eq!(second["outcome"], "CHALLENGE_REQUIRED");
    pause.resume.notify_one();
    exporting.await.unwrap().unwrap();
    let row = sqlx::query("SELECT revision,exported_at FROM delivery_outbox WHERE logical_id=$1")
        .bind(&logical)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(row.get::<i64, _>("revision"), 3);
    assert!(row.get::<Option<i64>, _>("exported_at").is_none());
    history::export(&f.app).await.unwrap();
    let pending_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(pending_rows, 0);
    f.restart_with_capacity(1).await;
    // Its already exported pending result still reserves the only delivery slot.
    assert_eq!(
        f.browser("context", &json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let token = f.token(&second["challenge"]);
    let allowed = json_ok(f.backend(&continuation(&input, &second, &token))).await;
    assert_eq!(allowed["outcome"], "ALLOW");
    let pending_rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(pending_rows, 1);
    // A crash after ClickHouse success leaves the exact current revision queued.
    let pause = Arc::new(VerificationPause::default());
    let mut exporter = f.app.clone();
    exporter.provider_test.after_export = Some(pause.clone());
    let exporting = tokio::spawn(async move { history::export(&exporter).await });
    tokio::time::timeout(Duration::from_secs(3), pause.arrived.notified())
        .await
        .unwrap();
    exporting.abort();
    f.restart().await;
    history::export(&f.app).await.unwrap();
    let page = json_ok(f.admin(Method::GET, &format!("/activity/decisions?check={check}"))).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["outcome"], "ALLOW");
    assert_eq!(json_ok(f.backend(&input)).await, allowed);
    json_ok(f.browser("context", &json!({}))).await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_partial_candidate_can_activate_only_with_usable_evidence() {
    for (body, expected, cause) in [
        (
            json!({"status":"warning","1.1.1.1":{"detections":{"risk":45,"proxy":false},"location":{"country_code":"US"}}}),
            "configuration_checked",
            "provider warning",
        ),
        (
            json!({"status":"ok","1.1.1.1":{"detections":{"risk":45,"proxy":false}}}),
            "configuration_checked",
            "incomplete fields",
        ),
        (
            json!({"status":"ok","1.1.1.1":{}}),
            "invalid",
            "no usable evidence",
        ),
        (
            json!({"status":"error","1.1.1.1":{"detections":{"risk":45}}}),
            "invalid",
            "rejected",
        ),
        (
            json!({"status":"ok","1.1.1.1":[]}),
            "invalid",
            "invalid evidence",
        ),
    ] {
        let f = Fixture::new().await;
        f.mock.lock().unwrap().ip_body = Some(body);
        let candidate = json!({"revision":0,"provider":"proxycheck","enabled":true,"config":{"secret":"candidate-secret"}});
        let tested = json_ok(
            f.admin(Method::POST, "/providers/ip_intelligence/tests")
                .json(&candidate),
        )
        .await;
        assert_eq!(tested["status"], expected);
        assert!(tested["message"].as_str().unwrap().contains(cause));
        let mut save = candidate;
        save["test_token"] = tested["test_token"].clone();
        if expected == "configuration_checked" {
            assert!(
                tested["message"]
                    .as_str()
                    .unwrap()
                    .contains("other IPs may differ")
            );
            let saved = json_ok(
                f.admin(Method::PUT, "/providers/ip_intelligence")
                    .json(&save),
            )
            .await;
            assert_eq!(saved["status"], expected);
            assert_eq!(saved["message"], tested["message"]);
            assert_eq!(saved["enabled"], true);
        } else {
            assert!(tested["test_token"].is_null());
            rejected(
                f.admin(Method::PUT, "/providers/ip_intelligence")
                    .json(&save),
                "invalid_input",
            )
            .await;
        }
        f.finish().await;
    }
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_pending_expiry_and_cleanup_preserve_reserved_delivery() {
    let mut f = Fixture::new().await;
    f.configure("verification", 0, "key").await;
    let check = unique();
    f.policy(&check, challenge_policy(1)).await;
    let (input, pending) = f.attempt(&check).await;
    history::export(&f.app).await.unwrap();
    let id = input["operation_id"].as_str().unwrap();
    let logical = format!("decision:{}", pending["decision_id"].as_str().unwrap());
    let past = util::now() - 172_800_001;
    sqlx::query("UPDATE operations SET accepted_at=$1 WHERE id=$2")
        .bind(past)
        .bind(id)
        .execute(&f.app.db)
        .await
        .unwrap();
    sqlx::query("UPDATE delivery_outbox SET at=$1 WHERE logical_id=$2")
        .bind(past)
        .bind(&logical)
        .execute(&f.app.db)
        .await
        .unwrap();
    // Cleanup can remove the old exported snapshot, but not its unfinished owner.
    history::export(&f.app).await.unwrap();
    let state: String = sqlx::query_scalar("SELECT state FROM operations WHERE id=$1")
        .bind(id)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(state, "pending");
    f.restart_with_capacity(1).await;
    assert_eq!(
        f.browser("context", &json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    checks::expire_pending(&f.app).await.unwrap();
    let expired = json_ok(f.backend(&input)).await;
    assert_eq!(expired["reason"], "verification_expired");
    let detail = f.detail(&expired).await;
    assert_eq!(detail["verification_transitions"][0]["state"], "pending");
    assert_eq!(detail["verification_transitions"][1]["state"], "expired");
    let slots: i64 =
        sqlx::query_scalar("SELECT count(*) FROM delivery_outbox WHERE exported_at IS NULL")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(slots, 1);
    // Old unexported finals survive cleanup and continue to consume capacity.
    sqlx::query("UPDATE delivery_outbox SET at=$1 WHERE logical_id=$2")
        .bind(past)
        .bind(&logical)
        .execute(&f.app.db)
        .await
        .unwrap();
    assert_eq!(
        f.browser("context", &json!({}))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    history::export(&f.app).await.unwrap();
    let retained: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM operations WHERE id=$1)")
        .bind(id)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert!(!retained);
    let page = json_ok(f.admin(Method::GET, &format!("/activity/decisions?check={check}"))).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["reason"], "verification_expired");
    json_ok(f.browser("context", &json!({}))).await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_coalescing_migration_preserves_latest_revision_and_restarts() {
    let f = Fixture::new().await;
    let schema = unique();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&f.admin)
        .await
        .unwrap();
    let mut config = Config::load().unwrap();
    let mut url = reqwest::Url::parse(&config.database_url).unwrap();
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    config.database_url = url.to_string();
    let old = PgPoolOptions::new()
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET krine.writer_generation='2'")
                    .execute(connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&config.database_url)
        .await
        .unwrap();
    let mut migrations = sqlx::migrate!("../../migrations");
    migrations.migrations = std::borrow::Cow::Owned(
        migrations
            .iter()
            .filter(|m| m.version < 4)
            .cloned()
            .collect(),
    );
    migrations.run(&old).await.unwrap();
    sqlx::query("INSERT INTO delivery_outbox(id,logical_id,revision,kind,at,payload,exported_at) VALUES ('decision:d:v1','decision:d',1,'decision',1,'{\"verification_transitions\":[1]}',2),('decision:d:v2','decision:d',2,'decision',1,'{\"verification_transitions\":[1,2]}',NULL),('decision:d:v3','decision:d',3,'decision',1,'{\"verification_transitions\":[1,2,3]}',NULL),('event:e',NULL,1,'event',1,'{}',2)")
        .execute(&old).await.unwrap();
    let app = App::connect(config).await.unwrap();
    // Repeating startup runs no applied migration again and preserves its data.
    sqlx::migrate!("../../migrations")
        .run(&app.db)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM delivery_outbox")
        .fetch_one(&app.db)
        .await
        .unwrap();
    assert_eq!(count, 2);
    let row = sqlx::query(
        "SELECT revision,payload,exported_at FROM delivery_outbox WHERE logical_id='decision:d'",
    )
    .fetch_one(&app.db)
    .await
    .unwrap();
    assert_eq!(row.get::<i64, _>("revision"), 3);
    assert_eq!(
        row.get::<Value, _>("payload")["verification_transitions"],
        json!([1, 2, 3])
    );
    assert!(row.get::<Option<i64>, _>("exported_at").is_none());
    let event: String =
        sqlx::query_scalar("SELECT logical_id FROM delivery_outbox WHERE id='event:e'")
            .fetch_one(&app.db)
            .await
            .unwrap();
    assert_eq!(event, "event:e");
    let duplicate = sqlx::query("INSERT INTO delivery_outbox(id,logical_id,kind,at,payload) VALUES ('duplicate','decision:d','decision',1,'{}')")
        .execute(&app.db).await.unwrap_err();
    assert_eq!(
        duplicate.as_database_error().unwrap().code().unwrap(),
        "23505"
    );
    let incompatible =
        sqlx::query("UPDATE delivery_outbox SET exported_at=2 WHERE logical_id='decision:d'")
            .execute(&old)
            .await
            .unwrap_err();
    assert!(
        incompatible
            .to_string()
            .contains("generation 6; stop the old server")
    );
    old.close().await;
    app.db.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&f.admin)
        .await
        .unwrap();
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn provider_review_binds_exact_dependencies_across_concurrent_publications() {
    let risk = json!({"schema_version":1,"inputs":{},"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.high_risk","version":1},"comparison":"eq","value":true},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
    let unrelated = json!({"schema_version":1,"inputs":{},"rules":[],"otherwise":"ALLOW"});
    for change in ["add", "republish", "remove"] {
        for publication_first in [true, false] {
            let f = Fixture::new().await;
            f.configure("ip_intelligence", 0, "original-key").await;
            let check = unique();
            let original = if change == "add" { &unrelated } else { &risk };
            f.policy(&check, original.clone()).await;
            let candidate = json!({"revision":1,"provider":"proxycheck","enabled":true,"config":{"secret":"replacement-key"}});
            let tested = json_ok(
                f.admin(Method::POST, "/providers/ip_intelligence/tests")
                    .json(&candidate),
            )
            .await;
            let reviewed = if change == "add" {
                json!([])
            } else {
                json!([{"check":check,"version":1}])
            };
            assert_eq!(tested["dependent_versions"], reviewed);
            let before = json_ok(f.admin(Method::GET, "/providers")).await;
            assert_eq!(
                before["items"][0]["dependents_token"],
                tested["dependents_token"]
            );
            for version in tested["dependent_versions"].as_array().unwrap() {
                let immutable = json_ok(f.admin(
                    Method::GET,
                    &format!(
                        "/checks/{}/versions/{}",
                        version["check"].as_str().unwrap(),
                        version["version"]
                    ),
                ))
                .await;
                assert_eq!(immutable["policy"], *original);
            }
            let next = if change == "remove" {
                &unrelated
            } else {
                &risk
            };
            json_ok(
                f.admin(Method::PUT, &format!("/checks/{check}/draft"))
                    .json(&json!({"revision":2,"description":"review race","policy":next})),
            )
            .await;
            let mut body = candidate;
            body["test_token"] = tested["test_token"].clone();
            body["acknowledge_dependents"] = json!(true);
            body["reviewed_dependents_token"] = tested["dependents_token"].clone();
            let save = f
                .admin(Method::PUT, "/providers/ip_intelligence")
                .json(&body);
            let publish = f
                .admin(Method::POST, &format!("/checks/{check}/publications"))
                .json(&json!({"revision":3,"expected_active_version":1}));
            let mut barrier = f.app.db.begin().await.unwrap();
            if publication_first {
                sqlx::query("LOCK TABLE policy_versions IN SHARE MODE")
                    .execute(&mut *barrier)
                    .await
                    .unwrap();
                let publication = tokio::spawn(async move { json_ok(publish).await });
                wait_for_query_lock(&f, "INSERT INTO policy_versions%").await;
                let saving = tokio::spawn(async move { save.send().await.unwrap() });
                wait_for_query_lock(
                    &f,
                    "SELECT revision FROM provider_current WHERE capability=$1 FOR UPDATE%",
                )
                .await;
                barrier.commit().await.unwrap();
                assert_eq!(publication.await.unwrap()["version"], 2);
                let rejected = saving.await.unwrap();
                assert_eq!(rejected.status(), StatusCode::CONFLICT);
                assert_eq!(
                    rejected.json::<Value>().await.unwrap()["error"]["code"],
                    "dependent_checks_changed"
                );
                let current = json_ok(f.admin(Method::GET, "/providers")).await;
                assert_eq!(current["items"][0]["revision"], 1);
                assert_ne!(
                    current["items"][0]["dependents_token"],
                    tested["dependents_token"]
                );
                assert_eq!(
                    current["items"][0]["dependent_versions"],
                    if change == "remove" {
                        json!([])
                    } else {
                        json!([{"check":check,"version":2}])
                    }
                );
                // A new review does not require retesting identical credentials.
                body["reviewed_dependents_token"] = current["items"][0]["dependents_token"].clone();
                let key = unique();
                let saved = json_ok(
                    f.admin_key(Method::PUT, "/providers/ip_intelligence", &key)
                        .json(&body),
                )
                .await;
                assert_eq!(saved["revision"], 2);
                assert_eq!(
                    json_ok(
                        f.admin_key(Method::PUT, "/providers/ip_intelligence", &key)
                            .json(&body)
                    )
                    .await,
                    saved
                );
            } else {
                sqlx::query("LOCK TABLE provider_revisions IN SHARE MODE")
                    .execute(&mut *barrier)
                    .await
                    .unwrap();
                let saving = tokio::spawn(async move { json_ok(save).await });
                wait_for_query_lock(&f, "INSERT INTO provider_revisions%").await;
                let publication = tokio::spawn(async move { json_ok(publish).await });
                wait_for_query_lock(
                    &f,
                    "SELECT revision FROM provider_current WHERE capability=$1 FOR SHARE%",
                )
                .await;
                barrier.commit().await.unwrap();
                let saved = saving.await.unwrap();
                assert_eq!(saved["revision"], 2);
                assert_eq!(saved["dependent_versions"], reviewed);
                assert_eq!(publication.await.unwrap()["version"], 2);
            }
            f.finish().await;
        }
    }
}

#[path = "connection_integration.rs"]
mod connection_tests;

#[path = "retention_integration.rs"]
mod retention_tests;

#[path = "addressing_integration.rs"]
mod addressing;

#[path = "analytics_integration.rs"]
mod analytics_tests;

#[path = "investigation_integration.rs"]
mod investigation_tests;

#[path = "investigation_security_regressions.rs"]
mod investigation_security_regressions;
#[path = "operator_integration.rs"]
mod operator_access;
