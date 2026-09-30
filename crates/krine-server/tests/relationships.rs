//! Real HTTP relationship lifecycle and race tests, each in a dedicated schema.
//! Run with the guarded isolated-stores helper and --test-threads=1.
use krine_server::{App, config::Config};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{collections::HashSet, net::SocketAddr, time::Duration};

fn unique() -> String {
    format!("rel_{:032x}", rand::random::<u128>())
}
struct Fixture {
    app: App,
    admin: PgPool,
    schema: String,
    http: Client,
    url: String,
    server: tokio::task::JoinHandle<()>,
    cookie: String,
    csrf: String,
    actor_id: String,
}
impl Fixture {
    async fn new() -> Self {
        Self::start(None).await
    }
    async fn start(legacy: Option<(&str, &str)>) -> Self {
        let mut config = Config::load().expect("guarded isolated-store environment");
        config.login_rate = 100000;
        config.browser_rate = 100000;
        config.server_rate = 100000;
        let admin = PgPool::connect(&config.database_url).await.unwrap();
        let schema = unique();
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&admin)
            .await
            .unwrap();
        let mut database = reqwest::Url::parse(&config.database_url).unwrap();
        database
            .query_pairs_mut()
            .append_pair("options", &format!("-csearch_path={schema}"));
        config.database_url = database.to_string();
        if let Some((id, digest)) = legacy {
            let old = PgPool::connect(&config.database_url).await.unwrap();
            let mut migrations = sqlx::migrate!("../../migrations");
            migrations.migrations = std::borrow::Cow::Owned(
                migrations
                    .iter()
                    .filter(|m| m.version < 6)
                    .cloned()
                    .collect(),
            );
            migrations.run(&old).await.unwrap();
            sqlx::query("INSERT INTO entities(kind,id,first_seen) VALUES('client','legacy_client',1),('user','legacy_user',1),('ip','127.0.0.1',1)").execute(&old).await.unwrap();
            sqlx::query("INSERT INTO associations(id,digest,client_id,user_id,metadata,created_at) VALUES($1,$2,'legacy_client','legacy_user','{}',$3)").bind(id).bind(digest).bind(now()).execute(&old).await.unwrap();
            sqlx::query("INSERT INTO observed_ips(client_id,session_id,ip,first_seen,last_seen) VALUES('legacy_client','legacy_session','127.0.0.1',1,2)").execute(&old).await.unwrap();
            old.close().await;
        }
        let app = App::connect(config).await.unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let runtime = app.clone();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                krine_server::router(runtime).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let http = Client::builder()
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
        let response = http
            .post(format!("{url}/v1/admin/session"))
            .header("origin", &app.config.admin_origin)
            .json(&json!({"sign_in_name":"fixture","credential":enrollment["credential"]}))
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
            admin,
            schema,
            http,
            url,
            server,
            cookie,
            csrf,
            actor_id,
        }
    }
    fn admin(&self, method: Method, path: &str, key: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/v1/admin{path}", self.url))
            .header("origin", &self.app.config.admin_origin)
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .header("x-krine-operator-id", &self.actor_id)
            .header("idempotency-key", key)
    }
    fn backend(&self, path: &str) -> RequestBuilder {
        self.http
            .post(format!("{}/v1{path}", self.url))
            .bearer_auth(&self.app.config.server_secret)
    }
    fn browser(&self, path: &str) -> RequestBuilder {
        self.http
            .post(format!("{}/v1/browser/{path}", self.url))
            .header("origin", &self.app.config.allowed_origins[0])
            .header("x-krine-public-key", &self.app.config.public_key)
    }
    async fn context(&self) -> Value {
        ok(self.browser("context").json(&json!({}))).await
    }
    async fn refresh(&self, context: &Value) -> Value {
        ok(self.browser("context").json(&json!({"client_token":context["client_token"],"session_token":context["session_token"]}))).await
    }
    fn association(&self, context: &Value, user: &str) -> Value {
        json!({"association_id":unique(),"client_id":context["client_id"],"user_id":user,"session_id":context["session_id"]})
    }
    async fn relationship(&self, kind: &str, id: &str) -> Value {
        ok(self.admin(
            Method::GET,
            &format!("/relationships/{kind}/{id}"),
            "unused",
        ))
        .await
    }
    fn change(
        &self,
        kind: &str,
        id: &str,
        revision: i64,
        restore: bool,
        key: &str,
    ) -> RequestBuilder {
        self.admin(Method::POST,&format!("/relationships/{kind}/{id}/{}",if restore{"restorations"}else{"corrections"}),key).json(&json!({"revision":revision,"reason":if restore{"Verified original evidence"}else{"Wrong association"}}))
    }
    async fn relations(&self, kind: &str, id: &str) -> Value {
        ok(self.admin(
            Method::GET,
            &format!("/entities/{kind}/{id}/relationships"),
            "unused",
        ))
        .await
    }
    async fn check(&self) -> String {
        let name = unique();
        ok(self
            .admin(Method::POST, "/checks", &unique())
            .json(&json!({"name":name})))
        .await;
        let policy = json!({"schema_version":1,"inputs":{},"rules":[{"id":"users","condition":{"op":"compare","left":{"source":"metric","name":"client.user_count_30d","version":1},"comparison":"gte","value":1},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
        ok(self
            .admin(Method::PUT, &format!("/checks/{name}/draft"), &unique())
            .json(&json!({"revision":1,"description":"Relationship test","policy":policy})))
        .await;
        ok(self
            .admin(
                Method::POST,
                &format!("/checks/{name}/publications"),
                &unique(),
            )
            .json(&json!({"revision":2,"expected_active_version":null})))
        .await;
        name
    }
    async fn attempt(&self, context: &Value, check: &str) -> Value {
        let proof=ok(self.browser("proofs").json(&json!({"client_token":context["client_token"],"session_token":context["session_token"],"check":check}))).await;
        json!({"operation_id":unique(),"check":check,"proof":proof["proof"],"ip":"127.0.0.1"})
    }
    async fn envelope(&self, input: &Value) -> Value {
        sqlx::query_scalar("SELECT envelope FROM operations WHERE id=$1")
            .bind(input["operation_id"].as_str().unwrap())
            .fetch_one(&self.app.db)
            .await
            .unwrap()
    }
    async fn cleanup(self) {
        self.server.abort();
        self.app.db.close().await;
        sqlx::query(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
async fn ok(request: RequestBuilder) -> Value {
    let response = request.send().await.unwrap();
    let status = response.status();
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn error(request: RequestBuilder, status: StatusCode, code: &str) {
    let response = request.send().await.unwrap();
    let actual = response.status();
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(actual, status, "{body}");
    assert_eq!(body["error"]["code"], code, "{body}");
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn correction_changes_new_checks_but_preserves_historical_context_and_retries() {
    let f = Fixture::new().await;
    let context = f.context().await;
    let check = f.check().await;
    let input = f.association(&context, "user_one");
    let association = ok(f.backend("/associations").json(&input)).await;
    let id = input["association_id"].as_str().unwrap();
    assert_eq!(association["session_id"], context["session_id"]);
    assert!(
        association["credential_id"]
            .as_str()
            .unwrap()
            .starts_with("cred_")
    );
    let original = f.attempt(&context, &check).await;
    let denied = ok(f.backend("/checks/evaluate").json(&original)).await;
    assert_eq!(denied["outcome"], "DENY");
    let historical = f.envelope(&original).await;
    let history_path = format!(
        "/activity/decisions/{}",
        denied["decision_id"].as_str().unwrap()
    );
    let recorded = ok(f.admin(Method::GET, &history_path, "unused")).await;
    assert_eq!(historical["relationship_context"]["total"], 1);
    assert_eq!(
        historical["relationship_context"]["items"][0]["revision"],
        1
    );
    assert_eq!(
        historical["relationship_context"]["items"][0]["credential_id"],
        association["credential_id"]
    );
    let key = unique();
    let corrected = ok(f.change("backend", id, 1, false, &key)).await;
    assert_eq!(corrected["recalculation"], "complete");
    assert_eq!(corrected["relationship"]["revision"], 2);
    assert!(corrected["relationship"]["revoked_at"].is_number());
    assert_eq!(ok(f.change("backend", id, 1, false, &key)).await, corrected);
    let replay = ok(f.backend("/associations").json(&input)).await;
    assert_eq!(
        replay["revoked_at"],
        corrected["relationship"]["revoked_at"]
    );
    assert_eq!(replay["created_at"], association["created_at"]);
    error(
        f.change("backend", id, 1, true, &unique()),
        StatusCode::CONFLICT,
        "revision_conflict",
    )
    .await;
    let next = f.attempt(&context, &check).await;
    assert_eq!(
        ok(f.backend("/checks/evaluate").json(&next)).await["outcome"],
        "ALLOW"
    );
    let clean = f.envelope(&next).await;
    assert_eq!(clean["relationship_context"]["total"], 0);
    assert_eq!(
        clean["snapshot"]["metrics"]["client.user_count_30d"]["state"]["value"],
        0.0
    );
    assert_eq!(
        ok(f.backend("/checks/evaluate").json(&original)).await,
        denied
    );
    assert_eq!(f.envelope(&original).await, historical);
    assert_eq!(
        ok(f.admin(Method::GET, &history_path, "unused")).await,
        recorded
    );
    let restored = ok(f.change("backend", id, 2, true, &unique())).await;
    assert_eq!(restored["relationship"]["revoked_at"], Value::Null);
    assert_eq!(
        restored["relationship"]["first_seen"],
        association["created_at"]
    );
    // A retry of the earlier correction recovers its receipt, never reapplies it.
    assert_eq!(ok(f.change("backend", id, 1, false, &key)).await, corrected);
    assert_eq!(
        f.relationship("backend", id).await["relationship"]["revision"],
        3
    );
    let next = f.attempt(&context, &check).await;
    assert_eq!(
        ok(f.backend("/checks/evaluate").json(&next)).await["outcome"],
        "DENY"
    );
    let detail = f.relationship("backend", id).await;
    assert_eq!(detail["audit"]["items"].as_array().unwrap().len(), 2);
    assert_eq!(detail["audit"]["items"][0]["actor"], f.actor_id);
    // Original time survives restoration: old assertions remain outside 30 days.
    sqlx::query("UPDATE associations SET created_at=$2 WHERE id=$1")
        .bind(id)
        .bind(now() - 2_592_000_001_i64)
        .execute(&f.app.db)
        .await
        .unwrap();
    let old = f.attempt(&context, &check).await;
    assert_eq!(
        ok(f.backend("/checks/evaluate").json(&old)).await["outcome"],
        "ALLOW"
    );
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn observed_segments_preserve_provenance_and_restore_never_overwrites_new_evidence() {
    let f = Fixture::new().await;
    let context = f.context().await;
    let client = context["client_id"].as_str().unwrap();
    let first = f.relations("client", client).await["items"][0].clone();
    let id = first["id"].as_str().unwrap();
    assert_eq!(first["kind"], "observed_ip");
    assert_eq!(first["session_id"], context["session_id"]);
    assert_eq!(first["first_source"], "browser.context");
    assert!(first["first_event_id"].is_string());
    assert!(first["credential_id"].is_string());
    f.refresh(&context).await;
    error(
        f.change("observed_ip", id, 1, false, &unique()),
        StatusCode::CONFLICT,
        "revision_conflict",
    )
    .await;
    let observed = f.relationship("observed_ip", id).await["relationship"].clone();
    assert_eq!(observed["revision"], 2);
    assert_eq!(observed["first_seen"], first["first_seen"]);
    assert_ne!(observed["last_event_id"], first["first_event_id"]);
    ok(f.change("observed_ip", id, 2, false, &unique())).await;
    ok(f.change("observed_ip", id, 3, true, &unique())).await;
    ok(f.change("observed_ip", id, 4, false, &unique())).await;
    f.refresh(&context).await;
    let rows = f.relations("ip", "127.0.0.1").await;
    assert_eq!(rows["items"].as_array().unwrap().len(), 2);
    let fresh = &rows["items"][0];
    assert_ne!(fresh["id"], id);
    assert_eq!(fresh["revoked_at"], Value::Null);
    assert_eq!(fresh["revision"], 1);
    error(
        f.change("observed_ip", id, 5, true, &unique()),
        StatusCode::CONFLICT,
        "relationship_active",
    )
    .await;
    let audit = f.relationship("observed_ip", id).await;
    assert_eq!(audit["audit"]["items"].as_array().unwrap().len(), 3);
    assert_eq!(
        audit["audit"]["items"][0]["relationship"]["last_seen"],
        observed["last_seen"]
    );
    let retained: bool = sqlx::query_scalar("SELECT has_corrections FROM observed_ips WHERE id=$1")
        .bind(id)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert!(retained);
    // Normal observation expiry must retain corrected evidence and its audit.
    sqlx::query("UPDATE observed_ips SET last_seen=$2 WHERE client_id=$1")
        .bind(client)
        .bind(now() - 2_592_000_001_i64)
        .execute(&f.app.db)
        .await
        .unwrap();
    let (shutdown, receiver) = tokio::sync::watch::channel(false);
    let worker = tokio::spawn(krine_server::worker(f.app.clone(), receiver));
    let mut remaining = 2;
    for _ in 0..50 {
        remaining =
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM observed_ips WHERE client_id=$1")
                .bind(client)
                .fetch_one(&f.app.db)
                .await
                .unwrap();
        if remaining == 1 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    shutdown.send(true).unwrap();
    worker.await.unwrap();
    assert_eq!(remaining, 1);
    assert_eq!(
        f.relationship("observed_ip", id).await["audit"]["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    // An observation/restore race has one active segment and loses neither fact.
    for _ in 0..8 {
        let context = f.context().await;
        let row = f
            .relations("client", context["client_id"].as_str().unwrap())
            .await["items"][0]
            .clone();
        let id = row["id"].as_str().unwrap();
        ok(f.change("observed_ip", id, 1, false, &unique())).await;
        let restore = f.change("observed_ip", id, 2, true, &unique()).send();
        let observe = f.refresh(&context);
        let (result, _) = tokio::join!(restore, observe);
        let result = result.unwrap();
        assert!([StatusCode::OK, StatusCode::CONFLICT].contains(&result.status()));
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM observed_ips WHERE client_id=$1 AND revoked_at IS NULL",
        )
        .bind(context["client_id"].as_str().unwrap())
        .fetch_one(&f.app.db)
        .await
        .unwrap();
        assert_eq!(count, 1);
        let state = f.relationship("observed_ip", id).await;
        if result.status() == StatusCode::OK {
            assert_eq!(state["relationship"]["revoked_at"], Value::Null);
            assert_eq!(state["relationship"]["revision"], 4);
        } else {
            assert!(state["relationship"]["revoked_at"].is_number());
        }
    }
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn mutation_boundaries_retries_and_concurrent_snapshots_are_coherent() {
    let f = Fixture::new().await;
    let context = f.context().await;
    let check = f.check().await;
    let input = f.association(&context, "user");
    let id = input["association_id"].as_str().unwrap();
    ok(f.backend("/associations").json(&input)).await;
    for bad in [
        json!({"revision":0,"reason":"x"}),
        json!({"revision":1,"reason":""}),
        json!({"revision":1,"reason":" x"}),
        json!({"revision":1,"reason":"x\ny"}),
        json!({"revision":1,"reason":"x".repeat(513)}),
        json!({"revision":1,"reason":"x","user_id":"forged"}),
    ] {
        error(
            f.admin(
                Method::POST,
                &format!("/relationships/backend/{id}/corrections"),
                &unique(),
            )
            .json(&bad),
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_input",
        )
        .await;
    }
    let path = format!("/relationships/backend/{id}/corrections");
    error(
        f.backend(&format!("/admin{path}"))
            .header("origin", &f.app.config.admin_origin)
            .json(&json!({"revision":1,"reason":"x"})),
        StatusCode::UNAUTHORIZED,
        "unauthenticated",
    )
    .await;
    error(
        f.admin(Method::POST, &path, &unique())
            .header("x-csrf-token", "wrong")
            .json(&json!({"revision":1,"reason":"x"})),
        StatusCode::FORBIDDEN,
        "csrf_failed",
    )
    .await;
    let other = f.context().await;
    let mut wrong = input.clone();
    wrong["association_id"] = json!(unique());
    wrong["session_id"] = other["session_id"].clone();
    error(
        f.backend("/associations").json(&wrong),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_input",
    )
    .await;
    let key = unique();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let request = f.change("backend", id, 1, false, &key);
        tasks.spawn(async move { ok(request).await });
    }
    let mut received = Vec::new();
    while let Some(value) = tasks.join_next().await {
        received.push(value.unwrap());
    }
    assert!(received.iter().all(|value| value == &received[0]));
    assert_eq!(
        f.relationship("backend", id).await["audit"]["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    error(
        f.change("backend", id, 2, true, &key),
        StatusCode::CONFLICT,
        "input_conflict",
    )
    .await;
    // Holding the same per-client lock produces an explicit failure, no partial audit.
    let mut lock = f.app.db.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!(
            "relationships:{}",
            context["client_id"].as_str().unwrap()
        ))
        .execute(&mut *lock)
        .await
        .unwrap();
    let key = unique();
    error(
        f.change("backend", id, 2, true, &key),
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
    )
    .await;
    lock.rollback().await.unwrap();
    let response = f.change("backend", id, 2, true, &key).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    assert_eq!(
        ok(f.change("backend", id, 2, true, &key)).await["relationship"]["revision"],
        3
    );
    for round in 0..12 {
        let revision = 3 + round * 2;
        let attempt = f.attempt(&context, &check).await;
        let correction = f.change("backend", id, revision, false, &unique());
        let retry = f.backend("/associations").json(&input);
        let evaluation = f.backend("/checks/evaluate").json(&attempt);
        let (corrected, retried, result) = tokio::join!(ok(correction), ok(retry), ok(evaluation));
        assert_eq!(corrected["relationship"]["revision"], revision + 1);
        assert!([revision, revision + 1].contains(&retried["revision"].as_i64().unwrap()));
        let envelope = f.envelope(&attempt).await;
        let count = envelope["snapshot"]["metrics"]["client.user_count_30d"]["state"]["value"]
            .as_f64()
            .unwrap();
        assert_eq!(
            envelope["relationship_context"]["total"].as_i64().unwrap(),
            count as i64
        );
        assert_eq!(
            result["outcome"],
            if count == 0.0 { "ALLOW" } else { "DENY" }
        );
        if count == 1.0 {
            assert_eq!(
                envelope["relationship_context"]["items"][0]["revision"],
                revision
            );
        }
        ok(f.change("backend", id, revision + 1, true, &unique())).await;
        assert_eq!(f.envelope(&attempt).await, envelope);
    }
    // Independent simultaneous intents cannot both apply the same revision.
    let mut contenders = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let request = f.change("backend", id, 27, false, &unique());
        contenders.spawn(async move { request.send().await.unwrap().status() });
    }
    let mut successes = 0;
    while let Some(status) = contenders.join_next().await {
        match status.unwrap() {
            StatusCode::OK => successes += 1,
            StatusCode::CONFLICT => {}
            other => panic!("Unexpected correction status {other}"),
        }
    }
    assert_eq!(successes, 1);
    let mut next = None;
    let mut audits = HashSet::new();
    loop {
        let mut request = f
            .admin(
                Method::GET,
                &format!("/relationships/backend/{id}"),
                "unused",
            )
            .query(&[("limit", "3")]);
        if let Some(cursor) = &next {
            request = request.query(&[("cursor", cursor)]);
        }
        let page = ok(request).await;
        for item in page["audit"]["items"].as_array().unwrap() {
            assert!(audits.insert(item["id"].as_str().unwrap().to_owned()));
        }
        next = page["audit"]["next_cursor"].as_str().map(str::to_owned);
        if next.is_none() {
            break;
        }
    }
    assert_eq!(audits.len(), 27);
    // A new backend fact, a correction and a check share the same snapshot boundary.
    for _ in 0..6 {
        let context = f.context().await;
        let original = f.association(&context, "original");
        ok(f.backend("/associations").json(&original)).await;
        let new = f.association(&context, "new");
        let attempt = f.attempt(&context, &check).await;
        let (receipt, _, result) = tokio::join!(
            ok(f.backend("/associations").json(&new)),
            ok(f.change(
                "backend",
                original["association_id"].as_str().unwrap(),
                1,
                false,
                &unique()
            )),
            ok(f.backend("/checks/evaluate").json(&attempt))
        );
        assert_eq!(receipt["revision"], 1);
        let envelope = f.envelope(&attempt).await;
        let count = envelope["snapshot"]["metrics"]["client.user_count_30d"]["state"]["value"]
            .as_f64()
            .unwrap();
        assert_eq!(
            envelope["relationship_context"]["total"].as_i64().unwrap(),
            count as i64
        );
        assert_eq!(
            result["outcome"],
            if count == 0.0 { "ALLOW" } else { "DENY" }
        );
        let after = f.attempt(&context, &check).await;
        ok(f.backend("/checks/evaluate").json(&after)).await;
        assert_eq!(f.envelope(&after).await["relationship_context"]["total"], 1);
    }
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn migration_preserves_unknown_provenance_and_legacy_digest_while_fencing_old_writers() {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use sha2::{Digest, Sha256};
    let input = json!({"association_id":"legacy_assertion","client_id":"legacy_client","user_id":"legacy_user","metadata":{}});
    let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(serde_json::to_vec(&input).unwrap()));
    let f = Fixture::start(Some(("legacy_assertion", &digest))).await;
    let result = ok(f.backend("/associations").json(&input)).await;
    assert_eq!(result["credential_id"], Value::Null);
    assert_eq!(result["session_id"], Value::Null);
    assert_eq!(result["revision"], 1);
    let mut explicit = input.clone();
    explicit["session_id"] = Value::Null;
    assert_eq!(ok(f.backend("/associations").json(&explicit)).await, result);
    let rows = f.relations("client", "legacy_client").await;
    let observed = rows["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "observed_ip")
        .unwrap();
    assert_eq!(observed["credential_id"], Value::Null);
    assert_eq!(observed["first_source"], "legacy");
    assert_eq!(observed["first_seen"], 1);
    assert_eq!(observed["last_seen"], 2);
    let mut old = f.app.db.acquire().await.unwrap();
    sqlx::query("SET krine.writer_generation='3'")
        .execute(&mut *old)
        .await
        .unwrap();
    for statement in [
        "UPDATE associations SET revoked_at=1 WHERE id='legacy_assertion'",
        "DELETE FROM observed_ips",
        "INSERT INTO associations(id,digest,client_id,user_id,metadata,created_at) VALUES('old','x','legacy_client','legacy_user','{}',1)",
    ] {
        let error = sqlx::query(statement).execute(&mut *old).await.unwrap_err();
        assert!(error.to_string().contains("generation 6"));
    }
    sqlx::query("SET krine.writer_generation='6'")
        .execute(&mut *old)
        .await
        .unwrap();
    drop(old);
    ok(f.change("backend", "legacy_assertion", 1, false, &unique())).await;
    let retry = ok(f.backend("/associations").json(&input)).await;
    assert!(retry["revoked_at"].is_number());
    assert_eq!(retry["credential_id"], Value::Null);
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn pagination_is_kind_safe_and_snapshot_samples_do_not_truncate_metrics() {
    let f = Fixture::new().await;
    let context = f.context().await;
    let check = f.check().await;
    let client = context["client_id"].as_str().unwrap();
    let observed = f.relations("client", client).await["items"][0].clone();
    for index in 0..125 {
        let mut input = f.association(&context, &format!("user_{index}"));
        if index == 0 {
            input["association_id"] = observed["id"].clone();
        }
        ok(f.backend("/associations").json(&input)).await;
    }
    // Kind participates in the cursor even when backend-supplied IDs collide.
    sqlx::query("UPDATE associations SET created_at=$2 WHERE id=$1")
        .bind(observed["id"].as_str().unwrap())
        .bind(observed["first_seen"].as_i64().unwrap())
        .execute(&f.app.db)
        .await
        .unwrap();
    let mut next = None;
    let mut seen = HashSet::new();
    loop {
        let mut request = f
            .admin(
                Method::GET,
                &format!("/entities/client/{client}/relationships"),
                "unused",
            )
            .query(&[("limit", "7")]);
        if let Some(cursor) = &next {
            request = request.query(&[("cursor", cursor)]);
        }
        let page = ok(request).await;
        for item in page["items"].as_array().unwrap() {
            assert!(seen.insert(format!("{}:{}", item["kind"], item["id"])));
        }
        next = page["next_cursor"].as_str().map(str::to_owned);
        if next.is_none() {
            break;
        }
    }
    assert_eq!(seen.len(), 126);
    let attempt = f.attempt(&context, &check).await;
    ok(f.backend("/checks/evaluate").json(&attempt)).await;
    let envelope = f.envelope(&attempt).await;
    assert_eq!(
        envelope["snapshot"]["metrics"]["client.user_count_30d"]["state"]["value"],
        125.0
    );
    assert_eq!(envelope["relationship_context"]["total"], 125);
    assert_eq!(envelope["relationship_context"]["truncated"], true);
    assert_eq!(
        envelope["relationship_context"]["items"]
            .as_array()
            .unwrap()
            .len(),
        100
    );
    assert_eq!(envelope["relationship_ids"].as_array().unwrap().len(), 100);
    assert!(
        envelope["relationship_context"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item.get("metadata").is_none())
    );
    let user = f.relations("user", "user_124").await;
    assert_eq!(user["items"].as_array().unwrap().len(), 1);
    assert_eq!(user["items"][0]["kind"], "backend");
    let ip = f.relations("ip", "127.0.0.1").await;
    assert!(
        ip["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["kind"] == "observed_ip")
    );
    error(
        f.admin(
            Method::GET,
            &format!("/entities/client/{client}/relationships?limit=101"),
            "unused",
        ),
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_input",
    )
    .await;
    f.cleanup().await;
}
