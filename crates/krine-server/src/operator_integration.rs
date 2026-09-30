//! Actual HTTP and PostgreSQL authority ordering; every fixture owns its schema.
use super::*;
use crate::{
    admin as mutations,
    operators::{self, Audit, Capability},
};
use axum::http::HeaderMap;

struct Actor {
    id: String,
    cookie: String,
    csrf: String,
    session: String,
    credential: String,
    login: String,
}
impl Actor {
    fn request(&self, f: &Fixture, method: Method, path: &str, key: &str) -> RequestBuilder {
        f.http
            .request(method, format!("{}/v1/admin{path}", f.url))
            .header("origin", &f.app.config.admin_origin)
            .header("cookie", &self.cookie)
            .header("x-csrf-token", &self.csrf)
            .header("x-krine-operator-id", &self.id)
            .header("idempotency-key", key)
    }
    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in [
            ("cookie", self.cookie.as_str()),
            ("x-csrf-token", self.csrf.as_str()),
            ("x-krine-operator-id", self.id.as_str()),
            ("idempotency-key", "held-mutation"),
        ] {
            h.insert(k, v.parse().unwrap());
        }
        h
    }
}
async fn enroll(f: &Fixture, role: &str) -> Actor {
    let name = unique();
    let created=json_ok(f.admin(Method::POST,"/operators").json(&json!({"name":"Test operator","sign_in_name":name,"role":role,"reason":"Access boundary test"}))).await;
    login(f, name, created["credential"].as_str().unwrap().into()).await
}
async fn login(f: &Fixture, name: String, credential: String) -> Actor {
    let response = f
        .http
        .post(format!("{}/v1/admin/session", f.url))
        .header("origin", &f.app.config.admin_origin)
        .json(&json!({"sign_in_name":name,"credential":credential}))
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
    let session: Value = response.json().await.unwrap();
    Actor {
        id: session["actor_id"].as_str().unwrap().into(),
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
        session: session["session_id"].as_str().unwrap().into(),
        credential,
        login: name,
    }
}
async fn disable(f: &Fixture, id: &str) -> Value {
    json_ok(f.admin(Method::PUT,&format!("/operators/{id}")).json(&json!({"revision":1,"name":"Disabled operator","role":"viewer","state":"disabled","reason":"Offboarding test"}))).await
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_enforce_roles_aliases_head_and_cookie_ambiguity() {
    let f = Fixture::new().await;
    let viewer = enroll(&f, "viewer").await;
    let editor = enroll(&f, "editor").await;
    for (method, path) in [
        (Method::POST, "/checks"),
        (Method::PUT, "/checks/example/draft"),
        (Method::PUT, "/lookup/checks/draft?name=example"),
        (Method::POST, "/checks/example/publications"),
        (Method::POST, "/lookup/checks/publications?name=example"),
        (Method::POST, "/checks/example/restorations"),
        (Method::POST, "/lookup/checks/restorations?name=example"),
        (Method::POST, "/relationships/backend/example/corrections"),
        (
            Method::POST,
            "/lookup/relationships/corrections?kind=backend&id=example",
        ),
        (Method::POST, "/relationships/backend/example/restorations"),
        (
            Method::POST,
            "/lookup/relationships/restorations?kind=backend&id=example",
        ),
        (Method::GET, "/credentials"),
        (Method::HEAD, "/credentials"),
        (Method::POST, "/credentials"),
        (Method::POST, "/credentials/example/revocations"),
        (Method::PUT, "/providers/verification"),
        (Method::POST, "/providers/ip_intelligence/tests"),
        (Method::GET, "/operators"),
        (Method::GET, "/operators/example"),
        (Method::POST, "/operators"),
        (Method::PUT, "/operators/example"),
        (Method::POST, "/operators/example/credential-rotations"),
        (Method::GET, "/audit"),
    ] {
        let response = viewer
            .request(&f, method.clone(), path, &unique())
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{method} {path}");
        if method != Method::HEAD {
            assert_eq!(
                response.json::<Value>().await.unwrap()["error"]["code"],
                "insufficient_privilege"
            );
        }
    }
    for path in ["/checks", "/metrics", "/providers", "/setup"] {
        assert_eq!(
            viewer
                .request(&f, Method::HEAD, path, &unique())
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
    }
    sqlx::query("INSERT INTO entities(kind,id,first_seen,metadata) VALUES('user','operator-investigation',0,'{}')")
        .execute(&f.app.db)
        .await
        .unwrap();
    for actor in [&viewer, &editor] {
        for path in [
            "/lookup/entities/context?kind=user&id=operator-investigation",
            "/lookup/entities/timeline?kind=user&id=operator-investigation&from=0&to=0",
        ] {
            for method in [Method::GET, Method::HEAD] {
                assert_eq!(
                    actor
                        .request(&f, method.clone(), path, &unique())
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    StatusCode::OK,
                    "{method} {path}"
                );
            }
        }
    }
    let name = unique();
    json_ok(
        editor
            .request(&f, Method::POST, "/checks", &unique())
            .json(&json!({"name":name})),
    )
    .await;
    rejected(
        editor
            .request(&f, Method::POST, "/credentials", &unique())
            .json(&json!({"kind":"server","label":"No"})),
        "insufficient_privilege",
    )
    .await;
    rejected(
        viewer.request(
            &f,
            Method::GET,
            &format!("/operators/{}/sessions", editor.id),
            &unique(),
        ),
        "insufficient_privilege",
    )
    .await;
    for cookie in [
        format!("{}; {}", viewer.cookie, viewer.cookie),
        format!("{}; krine_operator=bad", viewer.cookie),
    ] {
        let response = f
            .http
            .get(format!("{}/v1/admin/session", f.url))
            .header("cookie", cookie)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let response = viewer
        .request(&f, Method::GET, "/session", &unique())
        .header("cookie", &viewer.cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    rejected(
        editor
            .request(&f, Method::POST, "/checks", &unique())
            .header("x-csrf-token", "wrong")
            .json(&json!({"name":unique()})),
        "csrf_failed",
    )
    .await;
    rejected(
        editor
            .request(&f, Method::POST, "/checks", &unique())
            .header("x-krine-operator-id", &viewer.id)
            .json(&json!({"name":unique()})),
        "actor_changed",
    )
    .await;
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_scope_receipts_reauthorize_replay_and_do_not_reveal_secrets_twice() {
    let f = Fixture::new().await;
    let first = enroll(&f, "admin").await;
    let second = enroll(&f, "admin").await;
    let key = unique();
    let one = unique();
    let two = unique();
    let response = json_ok(
        first
            .request(&f, Method::POST, "/checks", &key)
            .json(&json!({"name":one})),
    )
    .await;
    assert_eq!(
        json_ok(
            first
                .request(&f, Method::POST, "/checks", &key)
                .json(&json!({"name":one}))
        )
        .await,
        response
    );
    json_ok(
        second
            .request(&f, Method::POST, "/checks", &key)
            .json(&json!({"name":two})),
    )
    .await;
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM administrative_audit WHERE mutation_key=$1")
            .bind(&key)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(rows, 2);
    let creation_key = unique();
    let input = json!({"name":"New viewer","sign_in_name":unique(),"role":"viewer","reason":"One-time reveal test"});
    let reveal = json_ok(
        first
            .request(&f, Method::POST, "/operators", &creation_key)
            .json(&input),
    )
    .await;
    let retry = json_ok(
        first
            .request(&f, Method::POST, "/operators", &creation_key)
            .json(&input),
    )
    .await;
    assert_eq!(retry["secret_status"], "unrecoverable");
    assert!(retry["credential"].is_null());
    let stored: Value =
        sqlx::query_scalar("SELECT response FROM admin_mutations WHERE actor_id=$1 AND key=$2")
            .bind(&first.id)
            .bind(&creation_key)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(stored, json!({"operator_id":reveal["operator"]["id"]}));
    disable(&f, &first.id).await;
    rejected(
        first
            .request(&f, Method::POST, "/checks", &key)
            .json(&json!({"name":one})),
        "unauthenticated",
    )
    .await;
    let reactivated=json_ok(f.admin(Method::PUT,&format!("/operators/{}",first.id)).json(&json!({"revision":2,"name":"Reactivated viewer","role":"viewer","state":"active","reason":"Least privilege"}))).await;
    assert_eq!(reactivated["revision"], 3);
    let viewer = login(&f, first.login, first.credential).await;
    rejected(
        viewer
            .request(&f, Method::POST, "/checks", &key)
            .json(&json!({"name":one})),
        "insufficient_privilege",
    )
    .await;
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_gate_orders_privileged_commit_before_revocation_and_fences_later_work() {
    let f = Fixture::new().await;
    let editor = enroll(&f, "editor").await;
    let headers = editor.headers();
    let name = unique();
    let (mut tx, receipt, replay) = mutations::mutation(
        &f.app,
        &headers,
        "checks",
        &json!({"name":name}),
        Capability::Edit,
    )
    .await
    .unwrap();
    assert!(replay.is_none());
    let blocked=tokio::spawn(f.admin(Method::PUT,&format!("/operators/{}",editor.id)).json(&json!({"revision":1,"name":"Disabled","role":"editor","state":"disabled","reason":"Concurrent offboarding"})).send());
    // Observe the actual PostgreSQL lock waiter instead of assuming a sleep proves ordering.
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let waits:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT singleton FROM operator_access%')").fetch_one(&f.admin).await.unwrap();
        if waits {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "revocation did not reach the authorization gate"
        );
        tokio::task::yield_now().await;
    }
    assert!(!blocked.is_finished());
    sqlx::query(
        "INSERT INTO checks(name,description,draft,created_at,updated_at) VALUES($1,'','{}',1,1)",
    )
    .bind(&name)
    .execute(&mut *tx)
    .await
    .unwrap();
    let _ = mutations::finish(
        tx,
        receipt,
        json!({"name":name}),
        Audit::new("check.create", "check", &name),
    )
    .await
    .unwrap();
    assert_eq!(blocked.await.unwrap().unwrap().status(), StatusCode::OK);
    rejected(
        editor
            .request(&f, Method::POST, "/checks", "held-mutation")
            .json(&json!({"name":name})),
        "unauthenticated",
    )
    .await;
    assert!(
        sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM checks WHERE name=$1)")
            .bind(name)
            .fetch_one(&f.app.db)
            .await
            .unwrap()
    );
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_last_admin_rotation_and_absolute_expiry_are_enforced() {
    let f = Fixture::new().await;
    rejected(f.admin(Method::PUT,&format!("/operators/{}",f.actor_id)).json(&json!({"revision":1,"name":"Fixture","role":"viewer","state":"active","reason":"Would lock out"})),"last_admin").await;
    let other = enroll(&f, "admin").await;
    let a = f
        .admin(Method::PUT, &format!("/operators/{}", f.actor_id))
        .json(
            &json!({"revision":1,"name":"First","role":"viewer","state":"active","reason":"Race"}),
        );
    let b = other
        .request(
            &f,
            Method::PUT,
            &format!("/operators/{}", other.id),
            &unique(),
        )
        .json(
            &json!({"revision":1,"name":"Second","role":"viewer","state":"active","reason":"Race"}),
        );
    let (a, b) = tokio::join!(a.send(), b.send());
    let statuses = [a.unwrap().status(), b.unwrap().status()];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 1);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::CONFLICT)
            .count(),
        1
    );
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM operators WHERE role='admin' AND state='active'")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(count, 1);
    f.finish().await;
    let f = Fixture::new().await;
    let viewer = enroll(&f, "viewer").await;
    let rotation = json_ok(
        f.admin(
            Method::POST,
            &format!("/operators/{}/credential-rotations", viewer.id),
        )
        .json(&json!({"revision":1,"reason":"Credential rotation"})),
    )
    .await;
    rejected(
        viewer.request(&f, Method::GET, "/session", &unique()),
        "unauthenticated",
    )
    .await;
    rejected(
        f.http
            .post(format!("{}/v1/admin/session", f.url))
            .header("origin", &f.app.config.admin_origin)
            .json(&json!({"sign_in_name":viewer.login,"credential":viewer.credential})),
        "unauthenticated",
    )
    .await;
    let fresh = login(
        &f,
        viewer.login,
        rotation["credential"].as_str().unwrap().into(),
    )
    .await;
    let duration: i64 =
        sqlx::query_scalar("SELECT expires_at-created_at FROM operator_sessions WHERE id=$1")
            .bind(&fresh.session)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(duration, operators::SESSION_MILLIS);
    sqlx::query("UPDATE operator_sessions SET expires_at=1 WHERE id=$1")
        .bind(&fresh.session)
        .execute(&f.app.db)
        .await
        .unwrap();
    rejected(
        fresh.request(&f, Method::GET, "/session", &unique()),
        "unauthenticated",
    )
    .await;
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_provider_test_cannot_cross_actor_or_offboarding_boundary() {
    let mut f = Fixture::new().await;
    let pause = Arc::new(VerificationPause::default());
    f.app.provider_test.after_operator_provider_test = Some(pause.clone());
    f.restart().await;
    let first = enroll(&f, "admin").await;
    let other = enroll(&f, "admin").await;
    let candidate = json!({"revision":0,"provider":"proxycheck","enabled":true,"config":{"secret":"test-secret"}});
    let pending = tokio::spawn(
        first
            .request(
                &f,
                Method::POST,
                "/providers/ip_intelligence/tests",
                &unique(),
            )
            .json(&candidate)
            .send(),
    );
    tokio::time::timeout(Duration::from_secs(3), pause.arrived.notified())
        .await
        .unwrap();
    disable(&f, &first.id).await;
    pause.resume.notify_one();
    assert_eq!(
        pending.await.unwrap().unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM provider_tests WHERE actor_id=$1")
        .bind(&first.id)
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
    f.app.provider_test.after_operator_provider_test = None;
    f.restart().await;
    let tested = json_ok(
        other
            .request(
                &f,
                Method::POST,
                "/providers/ip_intelligence/tests",
                &unique(),
            )
            .json(&candidate),
    )
    .await;
    let mut save = candidate.clone();
    save["test_token"] = tested["test_token"].clone();
    rejected(
        f.admin(Method::PUT, "/providers/ip_intelligence")
            .json(&save),
        "invalid_input",
    )
    .await;
    json_ok(
        other
            .request(&f, Method::PUT, "/providers/ip_intelligence", &unique())
            .json(&save),
    )
    .await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_recovery_is_host_armed_single_use_narrow_and_revocable() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let f = Fixture::new().await;
    let installation: String = sqlx::query_scalar("SELECT installation_id FROM operator_access")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    let directory = std::env::temp_dir().join(unique());
    std::fs::create_dir(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let output = directory.join("grant");
    crate::recovery::arm(
        (*f.app.config).clone(),
        &installation,
        &output,
        "Lost the named credential",
    )
    .await
    .unwrap();
    assert_eq!(std::fs::metadata(&output).unwrap().mode() & 0o777, 0o600);
    assert!(
        crate::recovery::arm(
            (*f.app.config).clone(),
            &installation,
            &output,
            "Must not overwrite"
        )
        .await
        .is_err()
    );
    let token = std::fs::read_to_string(&output).unwrap();
    let redeem = || {
        f.http
            .post(format!("{}/v1/admin/auth/recovery/session", f.url))
            .header("origin", &f.app.config.admin_origin)
            .json(&json!({"token":token.trim()}))
    };
    let response = redeem().send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session: Value = response.json().await.unwrap();
    assert!(session["operator"].is_null());
    assert_eq!(session["authentication_method"], "installation_recovery");
    let actor = Actor {
        id: session["actor_id"].as_str().unwrap().into(),
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
        session: session["session_id"].as_str().unwrap().into(),
        credential: String::new(),
        login: String::new(),
    };
    assert!(actor.id.starts_with("recovery:"));
    assert_eq!(
        redeem().send().await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    json_ok(actor.request(&f, Method::GET, "/operators", &unique())).await;
    for path in [
        "/checks",
        "/providers",
        "/credentials",
        "/audit",
        "/activity/events",
        "/setup",
        "/lookup/entities/context",
        "/lookup/entities/timeline",
    ] {
        rejected(
            actor.request(&f, Method::GET, path, &unique()),
            "insufficient_privilege",
        )
        .await;
    }
    let recovery_rotation = json_ok(
        actor
            .request(
                &f,
                Method::POST,
                &format!("/operators/{}/credential-rotations", f.actor_id),
                &unique(),
            )
            .json(&json!({"revision":1,"reason":"Restore ordinary access"})),
    )
    .await;
    assert_eq!(recovery_rotation["secret_status"], "revealed");
    let named = login(
        &f,
        "fixture".into(),
        recovery_rotation["credential"].as_str().unwrap().into(),
    )
    .await;
    assert_eq!(named.id, f.actor_id);
    let output2 = directory.join("replacement");
    crate::recovery::arm(
        (*f.app.config).clone(),
        &installation,
        &output2,
        "Replace recovery authority",
    )
    .await
    .unwrap();
    rejected(
        actor.request(&f, Method::GET, "/operators", &unique()),
        "unauthenticated",
    )
    .await;
    let token2 = std::fs::read_to_string(&output2).unwrap();
    sqlx::query("UPDATE operator_recovery_grants SET expires_at=1 WHERE consumed_at IS NULL")
        .execute(&f.app.db)
        .await
        .unwrap();
    rejected(
        f.http
            .post(format!("{}/v1/admin/auth/recovery/session", f.url))
            .header("origin", &f.app.config.admin_origin)
            .json(&json!({"token":token2.trim()})),
        "unauthenticated",
    )
    .await;
    std::fs::remove_file(output).unwrap();
    std::fs::remove_file(output2).unwrap();
    std::fs::remove_dir(directory).unwrap();
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_audit_is_atomic_secret_safe_paged_and_independent_of_history() {
    let f = Fixture::new().await;
    let editor = enroll(&f, "editor").await;
    let check = unique();
    let secret_marker = "NotAnAuditPayload-DoNotCopyThisDescription";
    let key = unique();
    json_ok(
        editor
            .request(&f, Method::POST, "/checks", &key)
            .json(&json!({"name":check,"description":secret_marker})),
    )
    .await;
    let query = format!(
        "/audit?actor_id={}&resource_type=check&resource_id={check}&limit=1",
        editor.id
    );
    let page = json_ok(f.admin(Method::GET, &query)).await;
    assert_eq!(page["coverage"]["days"], 365);
    assert_eq!(page["items"].as_array().unwrap().len(), 1);
    assert_eq!(page["items"][0]["actor"]["id"], editor.id);
    assert!(!page.to_string().contains(secret_marker));
    assert!(!page.to_string().contains(&editor.credential));
    assert!(!page.to_string().contains(&editor.csrf));
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM administrative_audit")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    rejected(
        editor
            .request(&f, Method::POST, "/checks", &unique())
            .json(&json!({"name":check})),
        "input_conflict",
    )
    .await;
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM administrative_audit")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(before, after);
    let first = json_ok(f.admin(Method::GET, "/audit?limit=1")).await;
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = json_ok(f.admin(Method::GET, &format!("/audit?limit=1&cursor={cursor}"))).await;
    assert_ne!(first["items"][0]["id"], second["items"][0]["id"]);
    rejected(
        f.admin(
            Method::GET,
            &format!("/audit?limit=1&actor_id={}&cursor={cursor}", editor.id),
        ),
        "invalid_input",
    )
    .await;
    // Floor is monotonic and independent from a two-day analytical setting.
    history::configure_retention(&f.app.db, 2).await.unwrap();
    let retained = json_ok(f.admin(Method::GET, &query)).await;
    assert_eq!(retained["items"][0]["id"], page["items"][0]["id"]);
    sqlx::query("UPDATE administrative_audit SET at=(extract(epoch FROM clock_timestamp())*1000)::bigint-366*86400000::bigint WHERE mutation_key=$1").bind(key).execute(&f.app.db).await.unwrap();
    operators::cleanup(&f.app).await.unwrap();
    let expired = json_ok(f.admin(Method::GET, &query)).await;
    assert!(expired["items"].as_array().unwrap().is_empty());
    f.finish().await;
}
#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_credential_revocations_serialize_distinct_actors_and_preserve_first_snapshot() {
    let f = Fixture::new().await;
    let first = enroll(&f, "admin").await;
    let second = enroll(&f, "admin").await;
    let created = json_ok(
        first
            .request(&f, Method::POST, "/credentials", &unique())
            .json(&json!({"kind":"server","label":"Concurrent revocation"})),
    )
    .await;
    let id = created["credential"]["id"].as_str().unwrap();
    let path = format!("/credentials/{id}/revocations");
    let first_key = unique();
    let second_key = unique();

    // Hold the credential row until both HTTP requests are observed waiting
    // behind it. Different actor/key receipt locks cannot serialize this race.
    let mut held = f.app.db.begin().await.unwrap();
    let holder: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(&mut *held)
        .await
        .unwrap();
    sqlx::query("SELECT id FROM application_credentials WHERE id=$1 FOR UPDATE")
        .bind(id)
        .fetch_one(&mut *held)
        .await
        .unwrap();
    let a = tokio::spawn(
        first
            .request(&f, Method::POST, &path, &first_key)
            .json(&json!({}))
            .send(),
    );
    let b = tokio::spawn(
        second
            .request(&f, Method::POST, &path, &second_key)
            .json(&json!({}))
            .send(),
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let waiting: i64 = sqlx::query_scalar("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid))) SELECT count(DISTINCT a.pid) FROM blocked b JOIN pg_stat_activity a ON a.pid=b.pid WHERE a.wait_event_type='Lock' AND a.query LIKE 'SELECT % FROM application_credentials WHERE id=$1 FOR UPDATE'")
            .bind(holder).fetch_one(&f.admin).await.unwrap();
        if waiting == 2 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "both revocations did not reach the held credential row: {waiting}"
        );
        tokio::task::yield_now().await;
    }
    assert!(!a.is_finished() && !b.is_finished());
    held.commit().await.unwrap();
    let a = a.await.unwrap().unwrap();
    let b = b.await.unwrap().unwrap();
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    let revoked: Value = a.json().await.unwrap();
    assert_eq!(b.json::<Value>().await.unwrap(), revoked);
    assert_eq!(revoked["created_by"], created["credential"]["created_by"]);
    let first_actor = revoked["revocation_actor"]["id"].as_str().unwrap();
    assert!([first.id.as_str(), second.id.as_str()].contains(&first_actor));
    assert_eq!(revoked["revoked_by"], first_actor);
    assert_eq!(revoked["revocation_actor"]["name"], "Test operator");
    let audits = sqlx::query("SELECT action,actor_id,mutation_key FROM administrative_audit WHERE resource_id=$1 AND action IN ('credential.revoke','credential.revocation_confirmed') ORDER BY action")
        .bind(id).fetch_all(&f.app.db).await.unwrap();
    assert_eq!(audits.len(), 2);
    assert_eq!(
        audits[0].get::<String, _>("action"),
        "credential.revocation_confirmed"
    );
    assert_eq!(audits[1].get::<String, _>("action"), "credential.revoke");
    assert_eq!(audits[1].get::<String, _>("actor_id"), first_actor);
    assert_ne!(audits[0].get::<String, _>("actor_id"), first_actor);
    for (actor, key) in [(&first, &first_key), (&second, &second_key)] {
        assert_eq!(
            json_ok(actor.request(&f, Method::POST, &path, key).json(&json!({}))).await,
            revoked
        );
        assert!(
            audits
                .iter()
                .any(|r| r.get::<String, _>("actor_id") == actor.id
                    && r.get::<String, _>("mutation_key") == *key)
        );
    }
    let count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM administrative_audit WHERE resource_id=$1")
            .bind(id)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(count, 3, "creation plus two original mutation intents");

    // Names are captured evidence, not a lookup against current operator data.
    json_ok(f.admin(Method::PUT, &format!("/operators/{first_actor}"))
        .json(&json!({"revision":1,"name":"Renamed operator","role":"admin","state":"active","reason":"Snapshot regression"}))).await;
    let confirming = if first_actor == first.id {
        &second
    } else {
        &first
    };
    let third_key = unique();
    assert_eq!(
        json_ok(
            confirming
                .request(&f, Method::POST, &path, &third_key)
                .json(&json!({}))
        )
        .await,
        revoked
    );
    assert_eq!(
        json_ok(
            confirming
                .request(&f, Method::POST, &path, &third_key)
                .json(&json!({}))
        )
        .await,
        revoked
    );
    let listed = json_ok(f.admin(Method::GET, "/credentials?q=Concurrent%20revocation")).await;
    assert_eq!(listed["items"], json!([revoked.clone()]));
    let stored: Value =
        sqlx::query_scalar("SELECT revocation_actor FROM application_credentials WHERE id=$1")
            .bind(id)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(stored, revoked["revocation_actor"]);
    let confirmations: i64 = sqlx::query_scalar("SELECT count(*) FROM administrative_audit WHERE resource_id=$1 AND action='credential.revocation_confirmed'")
        .bind(id).fetch_one(&f.app.db).await.unwrap();
    assert_eq!(confirmations, 2);
    let receipts: i64 =
        sqlx::query_scalar("SELECT count(*) FROM admin_mutations WHERE response->>'id'=$1")
            .bind(id)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(receipts, 3);
    let recorded: String = sqlx::query_scalar("SELECT jsonb_build_object('audit',(SELECT jsonb_agg(to_jsonb(a)) FROM administrative_audit a),'receipts',(SELECT jsonb_agg(to_jsonb(m)) FROM admin_mutations m))::text")
        .fetch_one(&f.app.db).await.unwrap();
    for secret in [
        created["secret"].as_str().unwrap(),
        &first.credential,
        &second.credential,
        &first.csrf,
        &second.csrf,
        first.cookie.split_once('=').unwrap().1,
        second.cookie.split_once('=').unwrap().1,
        &f.app.config.server_secret,
        &f.app.config.admin_password,
    ] {
        assert!(!recorded.contains(secret));
    }
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_stopped_upgrade_fences_old_authentication_and_writers() {
    let f = Fixture::new().await;
    let schema = unique();
    sqlx::query(&format!("CREATE SCHEMA {schema}"))
        .execute(&f.admin)
        .await
        .unwrap();
    let mut config = (*f.app.config).clone();
    let mut url = reqwest::Url::parse(&config.database_url).unwrap();
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("options", &format!("-csearch_path={schema}"));
    config.database_url = url.to_string();
    let old = PgPoolOptions::new()
        .max_connections(1)
        .connect(&config.database_url)
        .await
        .unwrap();
    sqlx::query("SET krine.writer_generation='3'")
        .execute(&old)
        .await
        .unwrap();
    let mut migrations = sqlx::migrate!("../../migrations");
    migrations.migrations = std::borrow::Cow::Owned(
        migrations
            .iter()
            .filter(|m| m.version < 9)
            .cloned()
            .collect(),
    );
    migrations.run(&old).await.unwrap();
    sqlx::query("SET krine.writer_generation='5'")
        .execute(&old)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_sessions(digest,csrf,expires_at) VALUES('old-session','old-csrf',9223372036854775807)").execute(&old).await.unwrap();
    sqlx::query("INSERT INTO admin_mutations(key,digest,response,created_at) VALUES('legacy','hash','{}',1)").execute(&old).await.unwrap();
    for (id, revoked_by, revoked_at) in [
        ("legacy_shared", Some("administrator"), Some(321_i64)),
        ("legacy_active", None, None),
    ] {
        sqlx::query("INSERT INTO application_credentials(id,kind,label,source,digest,created_at,revoked_at,revoked_by) VALUES($1,'server',$1,'administrator',$1,123,$2,$3)")
            .bind(id).bind(revoked_at).bind(revoked_by).execute(&old).await.unwrap();
    }
    let upgraded = App::connect(config).await.unwrap();
    for query in [
        "SELECT * FROM admin_sessions WHERE digest='old-session'",
        "INSERT INTO admin_sessions(digest,csrf,expires_at) VALUES('new-old-session','csrf',1)",
        "INSERT INTO checks(name,description,draft,created_at,updated_at) VALUES('old-write','','{}',1,1)",
        "INSERT INTO admin_mutations(key,digest,response,created_at) VALUES('old-write','hash','{}',1)",
        "UPDATE operator_access SET local_enabled=false",
    ] {
        assert!(
            sqlx::query(query).execute(&old).await.is_err(),
            "old generation accepted: {query}"
        );
    }
    let legacy: String =
        sqlx::query_scalar("SELECT actor_id FROM admin_mutations WHERE key='legacy'")
            .fetch_one(&upgraded.db)
            .await
            .unwrap();
    assert_eq!(legacy, "legacy_shared_administrator");
    let consumed: bool =
        sqlx::query_scalar("SELECT bootstrap_consumed_at IS NOT NULL FROM operator_access")
            .fetch_one(&upgraded.db)
            .await
            .unwrap();
    assert!(!consumed);

    // Exercise the migrated rows through HTTP, including historical absent
    // identities; later confirmations must never manufacture their authors.
    let (url, server) = Fixture::serve(upgraded.clone()).await;
    let enrollment = json_ok(f.http.post(format!("{url}/v1/admin/auth/bootstrap"))
        .header("origin", &upgraded.config.admin_origin)
        .json(&json!({"installation_secret":upgraded.config.admin_password,"sign_in_name":"upgrade_admin","name":"Upgrade Admin"}))).await;
    let response = f
        .http
        .post(format!("{url}/v1/admin/session"))
        .header("origin", &upgraded.config.admin_origin)
        .json(&json!({"sign_in_name":"upgrade_admin","credential":enrollment["credential"]}))
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
    let session: Value = response.json().await.unwrap();
    let request = |method: Method, path: &str, key: &str| {
        f.http
            .request(method, format!("{url}/v1/admin{path}"))
            .header("origin", &upgraded.config.admin_origin)
            .header("cookie", &cookie)
            .header("x-csrf-token", session["csrf_token"].as_str().unwrap())
            .header("x-krine-operator-id", session["actor_id"].as_str().unwrap())
            .header("idempotency-key", key)
    };
    for (id, revoked_by, revoked_at) in [
        ("legacy_shared", json!("administrator"), json!(321)),
        ("legacy_active", session["actor_id"].clone(), Value::Null),
    ] {
        let path = format!("/credentials/{id}/revocations");
        let key = unique();
        let first = json_ok(request(Method::POST, &path, &key).json(&json!({}))).await;
        assert_eq!(first["created_at"], 123);
        assert!(first["created_by"].is_null());
        assert_eq!(first["revoked_by"], revoked_by);
        if revoked_at.is_null() {
            assert!(first["revoked_at"].as_i64().unwrap() > 654);
            assert_eq!(
                first["revocation_actor"],
                json!({"id":session["actor_id"],"type":"operator","name":"Upgrade Admin"})
            );
        } else {
            assert_eq!(first["revoked_at"], revoked_at);
            assert!(first["revocation_actor"].is_null());
        }
        assert_eq!(
            json_ok(request(Method::POST, &path, &key).json(&json!({}))).await,
            first
        );
        assert_eq!(
            json_ok(request(Method::POST, &path, &unique()).json(&json!({}))).await,
            first
        );
        let listed = json_ok(request(
            Method::GET,
            &format!("/credentials?q={id}"),
            &unique(),
        ))
        .await;
        assert_eq!(listed["items"], json!([first.clone()]));
        let stored: Value = sqlx::query_scalar("SELECT jsonb_build_object('revoked_at',revoked_at,'revoked_by',revoked_by,'revocation_actor',revocation_actor,'created_by',created_by) FROM application_credentials WHERE id=$1")
            .bind(id).fetch_one(&upgraded.db).await.unwrap();
        for field in ["revoked_at", "revoked_by", "revocation_actor", "created_by"] {
            assert_eq!(stored[field], first[field]);
        }
        let audits = sqlx::query("SELECT action,actor_id FROM administrative_audit WHERE resource_type='credential' AND resource_id=$1 ORDER BY action")
            .bind(id).fetch_all(&upgraded.db).await.unwrap();
        assert_eq!(audits.len(), 2, "exact replay must not add an audit");
        let actions = audits
            .iter()
            .map(|r| r.get::<String, _>("action"))
            .collect::<Vec<_>>();
        assert_eq!(
            actions,
            if revoked_at.is_null() {
                vec!["credential.revocation_confirmed", "credential.revoke"]
            } else {
                vec![
                    "credential.revocation_confirmed",
                    "credential.revocation_confirmed",
                ]
            }
        );
        assert!(
            audits
                .iter()
                .all(|r| r.get::<String, _>("actor_id") == session["actor_id"].as_str().unwrap())
        );
        let receipts: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM admin_mutations WHERE actor_id=$1 AND response->>'id'=$2",
        )
        .bind(session["actor_id"].as_str().unwrap())
        .bind(id)
        .fetch_one(&upgraded.db)
        .await
        .unwrap();
        assert_eq!(receipts, 2);
    }
    let recorded: String = sqlx::query_scalar("SELECT jsonb_build_object('audit',(SELECT jsonb_agg(to_jsonb(a)) FROM administrative_audit a),'receipts',(SELECT jsonb_agg(to_jsonb(m)) FROM admin_mutations m))::text")
        .fetch_one(&upgraded.db).await.unwrap();
    for secret in [
        enrollment["credential"].as_str().unwrap(),
        session["csrf_token"].as_str().unwrap(),
        cookie.split_once('=').unwrap().1,
        &upgraded.config.server_secret,
        &upgraded.config.admin_password,
    ] {
        assert!(!recorded.contains(secret));
    }
    server.abort();
    let _ = server.await;
    old.close().await;
    upgraded.db.close().await;
    sqlx::query(&format!("DROP SCHEMA {schema} CASCADE"))
        .execute(&f.admin)
        .await
        .unwrap();
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_cleanup_releases_receipts_before_waiting_on_audit_floor() {
    let f = Fixture::new().await;
    sqlx::query("INSERT INTO admin_mutations(actor_id,key,digest,response,created_at) VALUES($1,'expired-cleanup-test','digest','{}',1)").bind(&f.actor_id).execute(&f.app.db).await.unwrap();
    let mut floor = f.app.db.begin().await.unwrap();
    sqlx::query("SELECT singleton FROM operator_audit_retention WHERE singleton FOR UPDATE")
        .fetch_one(&mut *floor)
        .await
        .unwrap();
    let app = f.app.clone();
    let cleanup = tokio::spawn(async move { history::cleanup(&app).await });
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let blocked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'UPDATE operator_audit_retention SET%')").fetch_one(&f.admin).await.unwrap();
        if blocked {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cleanup did not reach the audit floor"
        );
        tokio::task::yield_now().await;
    }
    // The independent phase is blocked, but the old receipt has committed away
    // and ordinary authorized mutations neither need its locks nor the audit floor.
    let mut receipt = f.app.db.begin().await.unwrap();
    let absent=tokio::time::timeout(Duration::from_millis(300),sqlx::query("SELECT key FROM admin_mutations WHERE actor_id=$1 AND key='expired-cleanup-test' FOR UPDATE").bind(&f.actor_id).fetch_optional(&mut *receipt)).await.unwrap().unwrap();
    assert!(absent.is_none());
    receipt.rollback().await.unwrap();
    json_ok(
        f.admin(Method::POST, "/checks")
            .json(&json!({"name":unique()})),
    )
    .await;
    floor.rollback().await.unwrap();
    cleanup.await.unwrap().unwrap();
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn operators_cleanup_uses_expiry_and_grant_indexes_with_retained_population() {
    let f = Fixture::new().await;
    let at: i64 = sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    let floor = at - 365 * 86_400_000;
    sqlx::query("UPDATE operator_audit_retention SET started_at=$1")
        .bind(floor - 900_000)
        .execute(&f.app.db)
        .await
        .unwrap();
    // A year of retained sign-ins with no expired tail must avoid a table scan.
    sqlx::query("INSERT INTO operator_sessions(id,digest,csrf,operator_id,generation,created_at,expires_at) SELECT 'retained_session_'||n,'retained_digest_'||n,'fixture',$1,1,$2,$2+28800000 FROM generate_series(1,50000) n")
        .bind(&f.actor_id).bind(at).execute(&f.app.db).await.unwrap();
    sqlx::query("INSERT INTO operator_recovery_grants(id,digest,reason,created_at,expires_at) SELECT 'retained_grant_'||n,'retained_grant_digest_'||n,'Fixture retained grant',$1,$1+900000 FROM generate_series(1,20000) n")
        .bind(at).execute(&f.app.db).await.unwrap();
    const SESSIONS: &str =
        "SELECT id FROM operator_sessions WHERE expires_at<$1 ORDER BY expires_at,id LIMIT 1000";
    const GRANTS: &str = "SELECT g.id FROM operator_recovery_grants g WHERE expires_at<$1 AND NOT EXISTS(SELECT 1 FROM operator_sessions s WHERE s.recovery_grant_id=g.id) ORDER BY expires_at,id LIMIT 1000";
    async fn plan(f: &Fixture, query: &str, floor: i64) -> Value {
        sqlx::query_scalar(&format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {query}"))
            .bind(floor)
            .fetch_one(&f.app.db)
            .await
            .unwrap()
    }
    fn indexes(plan: &Value) -> Vec<&str> {
        let mut names = Vec::new();
        fn visit<'a>(node: &'a Value, names: &mut Vec<&'a str>) {
            if let Some(relation) = node["Relation Name"].as_str() {
                assert!(
                    !["operator_sessions", "operator_recovery_grants"].contains(&relation)
                        || node["Node Type"] != "Seq Scan",
                    "cleanup scanned retained relation: {node}"
                );
            }
            if let Some(name) = node["Index Name"].as_str() {
                names.push(name);
            }
            for child in node["Plans"].as_array().into_iter().flatten() {
                visit(child, names);
            }
        }
        visit(&plan[0]["Plan"], &mut names);
        names
    }
    for query in [
        "ANALYZE operator_sessions",
        "ANALYZE operator_recovery_grants",
    ] {
        sqlx::query(query).execute(&f.app.db).await.unwrap();
    }
    let empty = plan(&f, SESSIONS, floor).await;
    eprintln!("operator cleanup with 50,000 retained sessions, no expired rows: {empty}");
    assert!(indexes(&empty).contains(&"operator_sessions_expiry"));
    assert_eq!(empty[0]["Plan"]["Actual Rows"], 0);
    let empty_grants = plan(&f, GRANTS, floor).await;
    eprintln!("operator cleanup with 20,000 retained grants, no expired rows: {empty_grants}");
    assert!(indexes(&empty_grants).contains(&"operator_recovery_grants_expiry"));
    assert_eq!(empty_grants[0]["Plan"]["Actual Rows"], 0);

    sqlx::query("INSERT INTO operator_sessions(id,digest,csrf,operator_id,generation,created_at,expires_at) SELECT 'expired_session_'||n,'expired_digest_'||n,'fixture',$1,1,0,$2-1000 FROM generate_series(1,8) n")
        .bind(&f.actor_id).bind(floor).execute(&f.app.db).await.unwrap();
    sqlx::query("INSERT INTO operator_recovery_grants(id,digest,reason,created_at,expires_at) SELECT 'expired_grant_'||n,'expired_grant_digest_'||n,'Fixture expired grant',0,$1-1000 FROM generate_series(1,8) n")
        .bind(floor).execute(&f.app.db).await.unwrap();
    // Recovery sessions can outlive their single-use grant; retain their FK rows
    // until their own retention boundary passes.
    sqlx::query("INSERT INTO operator_sessions(id,digest,csrf,recovery_grant_id,generation,created_at,expires_at) SELECT 'grant_session_'||n,'grant_session_digest_'||n,'fixture','expired_grant_'||n,1,0,$1+899000 FROM generate_series(1,4) n")
        .bind(floor).execute(&f.app.db).await.unwrap();
    for query in [
        "ANALYZE operator_sessions",
        "ANALYZE operator_recovery_grants",
    ] {
        sqlx::query(query).execute(&f.app.db).await.unwrap();
    }
    let tail = plan(&f, SESSIONS, floor).await;
    eprintln!("operator cleanup with eight expired sessions: {tail}");
    assert!(indexes(&tail).contains(&"operator_sessions_expiry"));
    assert_eq!(tail[0]["Plan"]["Actual Rows"], 8);
    let grants = plan(&f, GRANTS, floor).await;
    eprintln!("operator cleanup with eight expired grants, four still referenced: {grants}");
    let names = indexes(&grants);
    assert!(names.contains(&"operator_recovery_grants_expiry"));
    assert!(names.contains(&"operator_sessions_recovery_grant"));
    assert_eq!(grants[0]["Plan"]["Actual Rows"], 4);
    operators::cleanup(&f.app).await.unwrap();
    let sessions: i64 = sqlx::query_scalar("SELECT count(*) FROM operator_sessions WHERE id LIKE 'retained_session_%' OR id LIKE 'grant_session_%'")
        .fetch_one(&f.app.db).await.unwrap();
    assert_eq!(sessions, 50004);
    let grants: i64 = sqlx::query_scalar("SELECT count(*) FROM operator_recovery_grants")
        .fetch_one(&f.app.db)
        .await
        .unwrap();
    assert_eq!(grants, 20004);
    let expired: i64 =
        sqlx::query_scalar("SELECT count(*) FROM operator_sessions WHERE expires_at<$1")
            .bind(floor)
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    assert_eq!(expired, 0);
    f.finish().await;
}
