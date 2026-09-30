//! Uses the existing private-store fixture; Node's WHATWG fetch is the client.
use super::*;

#[tokio::test]
#[ignore = "requires three isolated stores and Node.js"]
async fn query_selectors_preserve_identifiers_and_logical_mutation_identity() {
    let fixture = Fixture::new().await;
    let app = fixture.app.clone();
    let export = tokio::spawn(async move {
        loop {
            history::export(&app).await.unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });
    let input = json!({
        "url": fixture.url,
        "cookie": fixture.cookie,
        "csrf": fixture.csrf,
        "actor_id": fixture.actor_id,
        "origin": fixture.app.config.admin_origin,
        "browserOrigin": fixture.app.config.allowed_origins[0],
        "publicKey": fixture.app.config.public_key,
        "serverSecret": fixture.app.config.server_secret,
    });
    let result = tokio::process::Command::new("node")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/addressing.mjs"))
        .env("KRINE_ADDRESSING_FIXTURE", input.to_string())
        .output()
        .await;
    export.abort();
    fixture.finish().await;
    let output = result.expect("Node.js must be available for WHATWG fetch verification");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("addressing HTTP checks passed"));
}
