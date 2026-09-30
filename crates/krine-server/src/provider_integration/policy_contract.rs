use super::*;

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn legacy_policy_defaults_survive_reads_saves_restoration_and_replay() {
    let fixture = Fixture::new().await;
    let variants = [
        json!({"schema_version":1}),
        json!({"schema_version":1,"rules":[{"id":"known","condition":{"op":"known","value":{"source":"metric","name":"ip.risk","version":1}},"then":"ALLOW"}]}),
        json!({"schema_version":1,"rules":[{"id":"shared_client","condition":{"op":"compare","left":{"source":"metric","name":"client.user_count_30d","version":1},"comparison":"gte","value":3},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"}),
    ];
    for (index, original) in variants.iter().enumerate() {
        let name = format!("legacy_policy_{index}");
        let canonical = serde_json::to_value(
            serde_json::from_value::<krine_core::Policy>(original.clone()).unwrap(),
        )
        .unwrap();
        sqlx::query("INSERT INTO checks(name,description,draft,draft_revision,active_version,created_at,updated_at) VALUES($1,'Legacy',$2,1,1,1,1)")
            .bind(&name).bind(original).execute(&fixture.app.db).await.unwrap();
        sqlx::query(
            "INSERT INTO policy_versions(check_name,version,policy,published_at) VALUES($1,1,$2,1)",
        )
        .bind(&name)
        .bind(original)
        .execute(&fixture.app.db)
        .await
        .unwrap();
        let path = format!("/lookup/checks?name={name}");
        let initial = json_ok(fixture.admin(Method::GET, &path)).await;
        assert_eq!(initial["draft"], canonical);
        assert_eq!(initial["has_draft_changes"], false);
        for suffix in [
            format!("/lookup/checks/versions/1?name={name}"),
            format!("/checks/{name}/versions/1"),
        ] {
            let version = json_ok(fixture.admin(Method::GET, &suffix)).await;
            assert_eq!(version["policy"], canonical);
        }
        let versions =
            json_ok(fixture.admin(Method::GET, &format!("/lookup/checks/versions?name={name}")))
                .await;
        assert_eq!(versions["items"][0]["policy"], canonical);
        let key = unique();
        let payload = json!({"revision":1,"description":"Description only","policy":canonical});
        let saved = json_ok(
            fixture
                .admin_key(
                    Method::PUT,
                    &format!("/lookup/checks/draft?name={name}"),
                    &key,
                )
                .json(&payload),
        )
        .await;
        assert_eq!(saved["draft_revision"], 2);
        assert_eq!(saved["has_draft_changes"], false);
        assert_eq!(
            saved,
            json_ok(
                fixture
                    .admin_key(
                        Method::PUT,
                        &format!("/lookup/checks/draft?name={name}"),
                        &key
                    )
                    .json(&payload)
            )
            .await
        );
        let summary = json_ok(fixture.admin(Method::GET, &format!("/checks?q={name}"))).await;
        assert_eq!(summary["items"][0]["has_draft_changes"], false);
        let restored = json_ok(
            fixture
                .admin(
                    Method::POST,
                    &format!("/lookup/checks/restorations?name={name}"),
                )
                .json(&json!({"revision":2,"version":1,"replace_draft":true})),
        )
        .await;
        assert_eq!(restored["draft"], canonical);
        assert_eq!(restored["restored_from_version"], 1);
        assert_eq!(restored["has_draft_changes"], false);
        let stored: Value = sqlx::query_scalar(
            "SELECT policy FROM policy_versions WHERE check_name=$1 AND version=1",
        )
        .bind(&name)
        .fetch_one(&fixture.app.db)
        .await
        .unwrap();
        assert_eq!(
            &stored, original,
            "Reading and restoring must not rewrite captured policy bytes"
        );
        let mut changed = canonical;
        changed["otherwise"] = json!(if changed["otherwise"] == "ALLOW" {
            "DENY"
        } else {
            "ALLOW"
        });
        let changed = json_ok(
            fixture
                .admin(Method::PUT, &format!("/lookup/checks/draft?name={name}"))
                .json(&json!({"revision":3,"description":"Changed policy","policy":changed})),
        )
        .await;
        assert_eq!(changed["has_draft_changes"], true);
    }
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires three isolated stores"]
async fn malformed_stored_policy_is_unavailable_without_history_or_draft_changes() {
    let fixture = Fixture::new().await;
    let name = "malformed_policy";
    sqlx::query("INSERT INTO checks(name,description,draft,draft_revision,active_version,created_at,updated_at) VALUES($1,'Legacy',$2,1,1,1,1)")
        .bind(name).bind(json!({"schema_version":1})).execute(&fixture.app.db).await.unwrap();
    sqlx::query(
        "INSERT INTO policy_versions(check_name,version,policy,published_at) VALUES($1,1,$2,1)",
    )
    .bind(name)
    .bind(json!({"schema_version":1}))
    .execute(&fixture.app.db)
    .await
    .unwrap();
    for invalid in [
        json!({"schema_version":1,"inputs":null}),
        json!({"schema_version":1,"otherwise":"UNKNOWN"}),
        json!({"schema_version":99}),
    ] {
        sqlx::query("UPDATE policy_versions SET policy=$1 WHERE check_name=$2")
            .bind(&invalid)
            .bind(name)
            .execute(&fixture.app.db)
            .await
            .unwrap();
        for path in [
            format!("/lookup/checks?name={name}"),
            "/checks".into(),
            format!("/lookup/checks/versions?name={name}"),
            format!("/lookup/checks/versions/1?name={name}"),
        ] {
            let response = fixture.admin(Method::GET, &path).send().await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE, "{path}");
        }
        let restored = fixture
            .admin(
                Method::POST,
                &format!("/lookup/checks/restorations?name={name}"),
            )
            .json(&json!({"revision":1,"version":1,"replace_draft":true}))
            .send()
            .await
            .unwrap();
        assert_eq!(restored.status(), StatusCode::SERVICE_UNAVAILABLE);
        let row = sqlx::query("SELECT draft_revision,draft FROM checks WHERE name=$1")
            .bind(name)
            .fetch_one(&fixture.app.db)
            .await
            .unwrap();
        assert_eq!(row.get::<i64, _>("draft_revision"), 1);
        assert_eq!(row.get::<Value, _>("draft"), json!({"schema_version":1}));
    }
    fixture.finish().await;
}
