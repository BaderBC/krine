//! The external provider/widget alone is controlled; SDKs, application, Axum and stores are real.
use super::*;
use std::{
    any::Any,
    future::Future,
    os::unix::{fs::DirBuilderExt, process::CommandExt},
    panic::AssertUnwindSafe,
    path::Path,
    process::{ExitStatus, Stdio},
    task::Poll,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

async fn register_token(
    State(mock): State<Arc<Mutex<MockState>>>,
    Json(input): Json<Value>,
) -> Json<Value> {
    let mode = input["mode"].as_str().unwrap();
    assert!(matches!(
        mode,
        "good" | "hostname" | "action" | "binding" | "failure" | "timeout"
    ));
    let token = unique();
    let timestamp = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let mut response = json!({"success":true,"hostname":"localhost","action":"krine_verify",
        "cdata":input["binding"],"challenge_ts":timestamp});
    match mode {
        "hostname" => response["hostname"] = json!("attacker.example"),
        "action" => response["action"] = json!("different_action"),
        "binding" => response["cdata"] = json!("different_binding"),
        "failure" => response = json!({"success":false,"error-codes":["invalid-input-response"]}),
        _ => {}
    }
    let mut mock = mock.lock().unwrap();
    mock.delay_ms = if mode == "timeout" { 2000 } else { 0 };
    mock.tokens.insert(token.clone(), response);
    Json(json!({"token":token}))
}

#[tokio::test]
#[ignore = "requires three isolated stores, Node.js and pnpm --filter @krine/protected-app... build"]
async fn protected_application_verifies_and_recovers_with_real_sdks_and_stores() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for artifact in [
        "packages/protocol/dist/index.js",
        "packages/browser/dist/index.js",
        "packages/server/dist/index.js",
        "examples/protected-app/dist/server/main.js",
        "examples/protected-app/dist/public/index.html",
    ] {
        assert!(
            root.join(artifact).is_file(),
            "Missing {artifact}; build the real SDKs and example first: pnpm --filter @krine/protected-app... build"
        );
    }
    // Reserve an ephemeral application address before configuring the exact allowed origin.
    let reservation = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = reservation.local_addr().unwrap().port();
    let origin = format!("http://localhost:{port}");
    let f = Fixture::with_browser_origin(Some(origin.clone())).await;
    let mut control = None;
    let mut child = None;
    let mut directory = None;
    let result = catch_panic(async {
        let path = std::env::temp_dir().join(format!("krine-combined-verification-{}", unique()));
        std::fs::DirBuilder::new().mode(0o700).create(&path).expect("create private application directory");
        directory = Some(path);
        f.configure("verification", 0, "combined-provider-secret")
            .await;
        f.policy("can_claim_trial", challenge_policy(2)).await;
        let control_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let control_url = format!("http://{}", control_listener.local_addr().unwrap());
        let control_router = Router::new()
            .route("/tokens", post(register_token))
            .with_state(f.mock.clone());
        control = Some(tokio::spawn(async move {
            axum::serve(control_listener, control_router).await.unwrap();
        }));
        let input = json!({"url":f.url,"origin":origin,"port":port,"controlUrl":control_url,
            "publicKey":f.app.config.public_key,"secretKey":f.app.config.server_secret,"dataDir":directory});
        drop(reservation);
        let mut command = Command::new("node");
        command.as_std_mut().process_group(0);
        child = Some(
            command
                .arg("test/real-verification.mjs")
                .current_dir(root.join("examples/protected-app"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .expect("Node.js 24.21+ is required for the combined verification test"),
        );
        let process = child.as_mut().unwrap();
        process
            .stdin
            .take()
            .unwrap()
            .write_all(input.to_string().as_bytes())
            .await
            .unwrap();
        let mut stdout = process.stdout.take().unwrap();
        let mut stderr = process.stderr.take().unwrap();
        let mut output = Vec::new();
        let mut errors = Vec::new();
        tokio::time::timeout(Duration::from_secs(150), async {
            let (out, err) = tokio::join!(
                stdout.read_to_end(&mut output),
                stderr.read_to_end(&mut errors)
            );
            out.expect("could not read Node stdout");
            err.expect("could not read Node stderr");
        })
        .await
        .expect("combined harness exceeded 150 seconds");
        let status = stop_child(&mut child, true).await.expect("owned Node harness");
        assert!(
            status.success(),
            "combined harness failed:\n{}",
            String::from_utf8_lossy(&errors)
        );
        let evidence: Value = serde_json::from_slice(&output).expect("harness JSON evidence");
        assert_eq!(evidence["grants"], 1);
        assert_eq!(evidence["process_crashes"], 3);
        let operations: i64 = sqlx::query_scalar("SELECT count(*) FROM operations")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
        assert_eq!(operations, 8);
        let pending: i64 =
            sqlx::query_scalar("SELECT count(*) FROM operations WHERE state='pending'")
                .fetch_one(&f.app.db)
                .await
                .unwrap();
        assert_eq!(
            pending, 2,
            "cross-operation and cross-step reused tokens cannot advance"
        );
        let tokens: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM challenge_steps WHERE token_digest IS NOT NULL",
        )
        .fetch_one(&f.app.db)
        .await
        .unwrap();
        assert_eq!(tokens, 8);
        let calls = f.mock.lock().unwrap().calls.clone();
        assert_eq!(
            calls.len(),
            8,
            "lost acknowledgements and reused tokens must not call the provider again"
        );
        let mut uuids = std::collections::BTreeSet::new();
        for call in &calls {
            assert_eq!(call["secret"], "combined-provider-secret");
            assert_eq!(call["remoteip"], "127.0.0.1");
            let id = call["idempotency_key"].as_str().unwrap();
            assert!(uuid::Uuid::parse_str(id).is_ok());
            assert!(uuids.insert(id));
        }
        let events: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM events WHERE envelope->>'name'='trial_started'",
        )
        .fetch_one(&f.app.db)
        .await
        .unwrap();
        assert_eq!(
            events, 1,
            "lost event acknowledgement is recovered with the original event identity"
        );
        history::export(&f.app).await.unwrap();
        let page = json_ok(f.admin(Method::GET, "/activity/decisions?check=can_claim_trial")).await;
        assert_eq!(page["items"].as_array().unwrap().len(), 8);
        for result in evidence["decisions"].as_array().unwrap() {
            let detail = f.detail(result).await;
            assert_eq!(detail["outcome"], result["outcome"]);
            assert_eq!(detail["policy_version"], 1);
            let transitions = detail["verification_transitions"].as_array().unwrap();
            if result["outcome"] == "ALLOW" {
                assert_eq!(
                    transitions
                        .iter()
                        .filter(|row| row["state"] == "passed")
                        .count(),
                    2
                );
                assert_eq!(transitions.len(), 6);
                let session = json_ok(f.admin(
                    Method::GET,
                    &format!(
                        "/entities/session/{}",
                        detail["session_id"].as_str().unwrap()
                    ),
                ))
                .await;
                assert_eq!(
                    session["metrics"]["session.event_count_5m"]["state"]["value"],
                    9.0
                );
                assert_eq!(
                    session["metrics"]["client.user_count_30d"]["state"]["value"],
                    3.0
                );
            } else {
                let expected = if result["case"] == "timeout" {
                    "unavailable"
                } else {
                    "failed"
                };
                assert_eq!(transitions.last().unwrap()["state"], expected);
            }
            let serialized = detail.to_string();
            assert!(!serialized.contains("combined-provider-secret"));
            for call in &calls {
                assert!(!serialized.contains(call["response"].as_str().unwrap()));
            }
        }
    })
    .await;
    // Every failure in verification crosses this awaited cleanup boundary first.
    let process_cleanup = catch_panic(async {
        stop_child(&mut child, false).await;
    })
    .await;
    if let Some(control) = control {
        control.abort();
        let _ = control.await;
    }
    let fixture_cleanup = catch_panic(clean_fixture(f)).await;
    let directory_cleanup = catch_panic(async {
        if let Some(path) = directory {
            std::fs::remove_dir_all(path).expect("remove owned private application directory");
        }
    })
    .await;
    for outcome in [result, process_cleanup, fixture_cleanup, directory_cleanup] {
        if let Err(panic) = outcome {
            std::panic::resume_unwind(panic);
        }
    }
}

// std provides synchronous catch_unwind; catch each poll without requiring a new test dependency.
async fn catch_panic<F: Future>(future: F) -> std::result::Result<F::Output, Box<dyn Any + Send>> {
    let mut future = Box::pin(future);
    std::future::poll_fn(|context| {
        match std::panic::catch_unwind(AssertUnwindSafe(|| future.as_mut().poll(context))) {
            Ok(Poll::Ready(value)) => Poll::Ready(Ok(value)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(panic) => Poll::Ready(Err(panic)),
        }
    })
    .await
}

async fn stop_child(child: &mut Option<Child>, output_complete: bool) -> Option<ExitStatus> {
    let process = child.as_mut()?;
    // Do not poll wait/try_wait before group shutdown. The unreaped leader reserves this ID
    // even after an abrupt exit, so a later signal cannot target a reused process group.
    let id = process.id().expect("unreaped Node harness PID");
    if output_complete {
        // EOF can precede the final OS exit by a moment. Preserve its natural exit status.
        let deadline = Instant::now() + Duration::from_secs(5);
        while group_has_live_members(id, true).await && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    for signal in ["-TERM", "-KILL"] {
        let _ = Command::new("/bin/kill")
            .args([signal, &format!("-{id}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .expect("signal owned process group");
        let deadline = Instant::now() + Duration::from_secs(5);
        while group_has_live_members(id, false).await {
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        if !group_has_live_members(id, false).await {
            let status = process.wait().await.expect("reap Node harness");
            child.take();
            return Some(status);
        }
    }
    panic!("owned Node process group did not stop");
}

async fn group_has_live_members(id: u32, leader_only: bool) -> bool {
    let output = Command::new("ps")
        .args(["-axo", "pid=,pgid=,stat="])
        .output()
        .await
        .expect("inspect owned process group");
    assert!(
        output.status.success(),
        "could not inspect owned process group"
    );
    String::from_utf8(output.stdout)
        .expect("process inventory UTF-8")
        .lines()
        .any(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next().and_then(|pid| pid.parse::<u32>().ok());
            fields.next().and_then(|group| group.parse::<u32>().ok()) == Some(id)
                && (!leader_only || pid == Some(id))
                && fields.next().is_some_and(|state| !state.starts_with('Z'))
        })
}

async fn clean_fixture(f: Fixture) {
    f.server.abort();
    f.mock_server.abort();
    let _ = f.server.await;
    let _ = f.mock_server.await;
    let mut failures = Vec::new();
    for table in [
        format!("history_{}", f.schema),
        format!("history_v2_{}", f.schema),
    ] {
        if history::clickhouse(
            &f.app,
            &format!("DROP TABLE IF EXISTS {table}"),
            vec![],
            None,
        )
        .await
        .is_err()
        {
            failures.push(format!("could not drop {table}"));
        }
    }
    f.app.db.close().await;
    if sqlx::query(&format!("DROP SCHEMA {} CASCADE", f.schema))
        .execute(&f.admin)
        .await
        .is_err()
    {
        failures.push(format!("could not drop schema {}", f.schema));
    }
    f.admin.close().await;
    assert!(failures.is_empty(), "{}", failures.join("; "));
}
