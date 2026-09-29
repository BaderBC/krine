//! Outside-in credential lifecycle tests. Run only through the guarded
//! `scripts/with-dev-env.py --isolated-stores` helper. Each fixture owns a schema;
//! it starts no projection/history worker and never resets the shared test stores.
use krine_server::{App, config::Config};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::{collections::HashSet, net::SocketAddr, time::Duration};

fn unique() -> String {
    format!("ct_{:032x}", rand::random::<u128>())
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
}
impl Fixture {
    async fn new() -> Self {
        let mut config = Self::config();
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
        let app = App::connect(config).await.unwrap();
        let (url, server) = Self::serve(app.clone()).await;
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
            admin,
            schema,
            http,
            url,
            server,
            cookie,
            csrf,
        }
    }
    fn config() -> Config {
        let mut config = Config::load().expect("isolated-store configuration");
        config.login_rate = 100000;
        config.browser_rate = 100000;
        config.server_rate = 100000;
        config
    }
    async fn serve(app: App) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                krine_server::router(app).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (url, server)
    }
    fn admin(&self, method: Method, path: &str, key: &str) -> RequestBuilder {
        self.http
            .request(method, format!("{}/v1/admin{path}", self.url))
            .header("origin", &self.app.config.admin_origin)
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .header("idempotency-key", key)
    }
    async fn create(&self, kind: &str, label: &str, key: &str) -> Value {
        ok(self
            .admin(Method::POST, "/credentials", key)
            .json(&json!({"kind":kind,"label":label})))
        .await
    }
    async fn revoke(&self, id: &str, key: &str) -> Value {
        ok(self
            .admin(Method::POST, &format!("/credentials/{id}/revocations"), key)
            .json(&json!({})))
        .await
    }
    async fn list(&self) -> Value {
        ok(self.admin(Method::GET, "/credentials", "unused")).await
    }
    async fn authenticate(&self, kind: &str, value: &str, expected: &str) {
        let request = if kind == "browser" {
            self.http
                .post(format!("{}/v1/browser/proofs", self.url))
                .header("origin", &self.app.config.allowed_origins[0])
                .header("x-krine-public-key", value)
        } else {
            self.http
                .post(format!("{}/v1/contexts/resolve", self.url))
                .bearer_auth(value)
        };
        error(request.json(&json!({})), expected).await;
    }
    async fn restart(&mut self, change_bootstrap: bool) {
        self.server.abort();
        let mut config = Self::config();
        config.database_url = self.app.config.database_url.clone();
        if change_bootstrap {
            config.public_key = unique();
            config.server_secret = unique();
        }
        let old = self.app.clone();
        self.app = App::connect(config).await.unwrap();
        old.db.close().await;
        (self.url, self.server) = Self::serve(self.app.clone()).await;
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
async fn ok(request: RequestBuilder) -> Value {
    let response = request.send().await.unwrap();
    let status = response.status();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}
async fn error(request: RequestBuilder, code: &str) {
    let response = request.send().await.unwrap();
    let expected = match code {
        "unauthenticated" => StatusCode::UNAUTHORIZED,
        "forbidden" => StatusCode::FORBIDDEN,
        "input_conflict" => StatusCode::CONFLICT,
        "not_found" => StatusCode::NOT_FOUND,
        "unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    assert_eq!(response.status(), expected);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"]["code"],
        code
    );
}

#[tokio::test]
#[ignore = "requires three isolated stores and KRINE_* configuration"]
async fn secrets_are_revealed_once_and_revocation_is_immediate() {
    let f = Fixture::new().await;
    let original = f.list().await;
    assert_eq!(original["items"].as_array().unwrap().len(), 2);
    let key = unique();
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let request = f
            .admin(Method::POST, "/credentials", &key)
            .json(&json!({"kind":"server","label":"Production API"}));
        tasks.spawn(ok(request));
    }
    let mut responses = Vec::new();
    while let Some(result) = tasks.join_next().await {
        responses.push(result.unwrap());
    }
    let revealed = responses
        .iter()
        .filter(|value| value["secret_status"] == "revealed")
        .collect::<Vec<_>>();
    assert_eq!(revealed.len(), 1);
    let secret = revealed[0]["secret"].as_str().unwrap();
    assert!(secret.starts_with("sk_"));
    assert_eq!(secret.len(), 46);
    let credential = revealed[0]["credential"].clone();
    let id = credential["id"].as_str().unwrap();
    assert!(credential["public_key"].is_null());
    for value in &responses {
        assert_eq!(value["credential"], credential);
        if value["secret_status"] == "unrecoverable" {
            assert!(value["secret"].is_null());
        }
    }
    f.authenticate("server", secret, "invalid_input").await;
    f.authenticate("browser", secret, "unauthenticated").await;
    let browser = f.create("browser", "Web", &unique()).await;
    let public = browser["credential"]["public_key"].as_str().unwrap();
    assert_eq!(browser["secret_status"], "not_applicable");
    assert!(browser["secret"].is_null());
    assert!(public.starts_with("pk_"));
    f.authenticate("browser", public, "invalid_input").await;
    f.authenticate("server", public, "unauthenticated").await;
    let context = ok(f
        .http
        .post(format!("{}/v1/browser/context", f.url))
        .header("origin", &f.app.config.allowed_origins[0])
        .header("x-krine-public-key", public)
        .json(&json!({"signals":{"webdriver":false}})))
    .await;
    let resolved = ok(f.http.post(format!("{}/v1/contexts/resolve", f.url))
        .bearer_auth(secret)
        .json(&json!({"client_token":context["client_token"],"session_token":context["session_token"]}))).await;
    assert_eq!(resolved["client_id"], context["client_id"]);
    assert_eq!(resolved["session_id"], context["session_id"]);
    error(
        f.http
            .post(format!("{}/v1/browser/proofs", f.url))
            .header("origin", "https://untrusted.invalid")
            .header("x-krine-public-key", public)
            .json(&json!({})),
        "forbidden",
    )
    .await;

    let stored = sqlx::query("SELECT digest,public_key FROM application_credentials WHERE id=$1")
        .bind(id)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_ne!(stored.get::<String, _>("digest"), secret);
    assert!(stored.get::<Option<String>, _>("public_key").is_none());
    let mutation: Value = sqlx::query_scalar("SELECT response FROM admin_mutations WHERE key=$1")
        .bind(&key)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(mutation, json!({"credential_id":id}));
    let list = f.list().await;
    assert!(!list.to_string().contains(secret));
    error(
        f.admin(Method::POST, "/credentials", &key)
            .json(&json!({"kind":"server","label":"Changed"})),
        "input_conflict",
    )
    .await;

    let mut other_config = Fixture::config();
    other_config.database_url = f.app.config.database_url.clone();
    let other = App::connect(other_config).await.unwrap();
    let (other_url, other_server) = Fixture::serve(other.clone()).await;
    let revoke_key = unique();
    let revoked = f.revoke(id, &revoke_key).await;
    assert!(revoked["revoked_at"].is_i64());
    assert_eq!(revoked["revoked_by"], "administrator");
    assert_eq!(f.revoke(id, &revoke_key).await, revoked);
    assert_eq!(f.revoke(id, &unique()).await, revoked);
    f.authenticate("server", secret, "unauthenticated").await;
    error(
        f.http
            .post(format!("{other_url}/v1/contexts/resolve"))
            .bearer_auth(secret)
            .json(&json!({})),
        "unauthenticated",
    )
    .await;
    other_server.abort();
    other.db.close().await;
    let replay = f.create("server", "Production API", &key).await;
    assert_eq!(replay["credential"], revoked);
    assert_eq!(replay["secret_status"], "unrecoverable");
    assert!(replay["secret"].is_null());

    let first = ok(f.admin(Method::GET, "/credentials?limit=2", "unused")).await;
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = ok(f.admin(
        Method::GET,
        &format!("/credentials?limit=2&cursor={cursor}"),
        "unused",
    ))
    .await;
    let ids = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .chain(second["items"].as_array().unwrap())
        .map(|item| item["id"].as_str().unwrap())
        .collect::<HashSet<_>>();
    assert_eq!(ids.len(), 4);
    assert!(second["next_cursor"].is_null());
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores and KRINE_* configuration"]
async fn revoked_bootstrap_credentials_stay_revoked_across_restarts() {
    let mut f = Fixture::new().await;
    let original_public = f.app.config.public_key.clone();
    let original_secret = f.app.config.server_secret.clone();
    let original = f.list().await;
    for credential in original["items"].as_array().unwrap() {
        assert_eq!(credential["source"], "bootstrap");
        f.revoke(credential["id"].as_str().unwrap(), &unique())
            .await;
    }
    f.restart(false).await;
    f.authenticate("server", &original_secret, "unauthenticated")
        .await;
    f.authenticate("browser", &original_public, "unauthenticated")
        .await;
    f.restart(true).await;
    f.authenticate("server", &f.app.config.server_secret, "unauthenticated")
        .await;
    f.authenticate("browser", &f.app.config.public_key, "unauthenticated")
        .await;
    assert_eq!(f.list().await["items"].as_array().unwrap().len(), 2);
    let setup = ok(f.admin(Method::GET, "/setup", "unused")).await;
    assert!(setup["public_key"].is_null());
    assert!(setup["browser_credential_id"].is_null());
    assert_eq!(setup["active_credentials"], json!({"browser":0,"server":0}));
    let new = f.create("browser", "Replacement", &unique()).await;
    f.create("browser", "Second browser", &unique()).await;
    let setup = ok(f.admin(Method::GET, "/setup", "unused")).await;
    assert_eq!(setup["public_key"], new["credential"]["public_key"]);
    assert_eq!(setup["browser_credential_id"], new["credential"]["id"]);
    assert_eq!(setup["active_credentials"], json!({"browser":2,"server":0}));
    f.authenticate(
        "browser",
        setup["public_key"].as_str().unwrap(),
        "invalid_input",
    )
    .await;
    let create_key = unique();
    let server = f.create("server", "Persistent server", &create_key).await;
    f.restart(true).await;
    f.authenticate(
        "server",
        server["secret"].as_str().unwrap(),
        "invalid_input",
    )
    .await;
    let replay = f.create("server", "Persistent server", &create_key).await;
    assert_eq!(replay["credential"], server["credential"]);
    assert_eq!(replay["secret_status"], "unrecoverable");
    assert!(replay["secret"].is_null());
    let mut collision = Fixture::config();
    collision.database_url = f.app.config.database_url.clone();
    collision.public_key = collision.server_secret.clone();
    assert!(App::connect(collision).await.is_err());
    let mut collision = Fixture::config();
    collision.database_url = f.app.config.database_url.clone();
    collision.public_key = collision.admin_password.clone();
    assert!(App::connect(collision).await.is_err());
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores and KRINE_* configuration"]
async fn credential_mutations_validate_boundaries_and_fail_closed_without_database() {
    let f = Fixture::new().await;
    for input in [
        json!({"kind":"server","label":""}),
        json!({"kind":"server","label":" spaced "}),
        json!({"kind":"server","label":"bad\nlabel"}),
        json!({"kind":"server","label":"x".repeat(129)}),
        json!({"kind":"administrator","label":"bad kind"}),
        json!({"kind":"server","label":"extra","secret":"chosen by caller"}),
    ] {
        error(
            f.admin(Method::POST, "/credentials", &unique())
                .json(&input),
            "invalid_input",
        )
        .await;
    }
    let input = json!({"kind":"server","label":"Safe"});
    error(
        f.http
            .post(format!("{}/v1/admin/credentials", f.url))
            .header("origin", &f.app.config.admin_origin)
            .json(&input),
        "unauthenticated",
    )
    .await;
    error(
        f.http
            .post(format!("{}/v1/admin/credentials", f.url))
            .header("origin", &f.app.config.admin_origin)
            .header("cookie", &f.cookie)
            .header("idempotency-key", unique())
            .json(&input),
        "forbidden",
    )
    .await;
    error(
        f.admin(Method::POST, "/credentials/missing/revocations", &unique())
            .json(&json!({})),
        "not_found",
    )
    .await;
    for query in ["limit=0", "limit=101", "cursor=invalid", "unknown=yes"] {
        error(
            f.admin(Method::GET, &format!("/credentials?{query}"), "unused"),
            "invalid_input",
        )
        .await;
    }
    assert_eq!(f.list().await["items"].as_array().unwrap().len(), 2);
    f.app.db.close().await;
    f.authenticate("browser", &f.app.config.public_key, "unavailable")
        .await;
    f.authenticate("server", &f.app.config.server_secret, "unavailable")
        .await;
    error(
        f.admin(Method::POST, "/credentials", &unique())
            .json(&input),
        "unavailable",
    )
    .await;
    error(f.admin(Method::GET, "/setup", "unused"), "unavailable").await;
    f.cleanup().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores and KRINE_* configuration"]
async fn first_boot_import_is_atomic_and_serialized_across_replicas() {
    let f = Fixture::new().await;
    let digest: String =
        sqlx::query_scalar("SELECT digest FROM application_credentials WHERE kind='server'")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    // Reconstruct a first-boot failure inside this fixture's private schema.
    // The colliding retained digest forces the second insert to fail.
    sqlx::query("DELETE FROM application_credentials")
        .execute(&f.app.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM application_credential_bootstrap")
        .execute(&f.app.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO application_credentials(id,kind,label,source,digest,created_at) VALUES('collision','server','Collision','administrator',$1,0)")
        .bind(digest).execute(&f.app.db).await.unwrap();
    let mut config = Fixture::config();
    config.database_url = f.app.config.database_url.clone();
    assert!(App::connect(config).await.is_err());
    let marker_count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM application_credential_bootstrap")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(marker_count, 0);
    let credential_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM application_credentials")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(credential_count, 1);
    sqlx::query("DELETE FROM application_credentials WHERE id='collision'")
        .execute(&f.app.db)
        .await
        .unwrap();
    let mut startups = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let mut config = Fixture::config();
        config.database_url = f.app.config.database_url.clone();
        startups.spawn(App::connect(config));
    }
    while let Some(result) = startups.join_next().await {
        result.unwrap().unwrap().db.close().await;
    }
    let items = f.list().await;
    assert_eq!(items["items"].as_array().unwrap().len(), 2);
    f.authenticate("browser", &f.app.config.public_key, "invalid_input")
        .await;
    f.authenticate("server", &f.app.config.server_secret, "invalid_input")
        .await;
    f.cleanup().await;
}
