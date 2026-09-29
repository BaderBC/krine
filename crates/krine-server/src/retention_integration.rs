use super::*;

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn qa_retention_extension_does_not_lose_newly_retained_row() {
    let f = Fixture::new().await;
    history::configure_retention(&f.app.db, 2).await.unwrap();
    history::export(&f.app).await.unwrap();
    retire(&f.app).await;
    let clock_at = pg_now(&f.app).await;
    let at = clock_at - 2 * 86_400_000 + 2500;
    let id = unique();
    let payload = json!({"event_id":id,"name":"qa_retention_edge","accepted_at":at,"user_id":"qa","provenance":"backend"});
    let row = json!({"id":format!("event:{id}"),"revision":1,"kind":"event","at":at,"payload":payload.to_string()});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{row}\n")),
    )
    .await
    .unwrap();
    let clock = history::clickhouse(
        &f.app,
        "SELECT toUnixTimestamp64Milli(now64(3)) AS at FORMAT JSONEachRow",
        vec![],
        None,
    )
    .await
    .unwrap();
    println!("Host clock {}, ClickHouse {clock}", util::now());
    let ddl = history::clickhouse(
        &f.app,
        &format!("SHOW CREATE TABLE history_v2_{}", f.schema),
        vec![],
        None,
    )
    .await
    .unwrap();
    assert!(
        !ddl.contains("TTL "),
        "rolling TTL must be retired before extension"
    );
    history::configure_retention(&f.app.db, 30).await.unwrap();
    let before = json_ok(f.admin(Method::GET, &format!("/activity/events/{id}"))).await;
    assert_eq!(before["event_id"], id);
    assert!(history::retention(&f.app).await.unwrap().cutoff < at);
    // The old implementation still had a rolling two-day TTL here and lost
    // this row. Force delayed physical work with the pre-extension committed
    // cutoff: it must remain harmless after the old window would have elapsed.
    tokio::time::sleep(Duration::from_millis(6500)).await;
    history::clickhouse(
        &f.app,
        &format!(
            "ALTER TABLE history_v2_{} DELETE WHERE at < {} SETTINGS mutations_sync=1",
            f.schema,
            history::retention(&f.app).await.unwrap().cutoff
        ),
        vec![],
        None,
    )
    .await
    .unwrap();
    let raw = history::clickhouse(
        &f.app,
        &format!(
            "SELECT count() AS n FROM history_v2_{} FORMAT JSONEachRow",
            f.schema
        ),
        vec![],
        None,
    )
    .await
    .unwrap();
    println!("Rows after delayed cleanup: {raw}");
    history::export(&f.app).await.unwrap();
    let response = f
        .admin(Method::GET, &format!("/activity/events/{id}"))
        .send()
        .await
        .unwrap();
    let status = response.status();
    let body = response.text().await.unwrap();
    f.finish().await;
    assert_eq!(
        status,
        StatusCode::OK,
        "A row retained at the extension was deleted by the old ClickHouse TTL: {body}"
    );
}

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn retention_cutoff_uses_the_same_database_clock_as_configuration() {
    let f = Fixture::new().await;
    history::configure_retention(&f.app.db, 2).await.unwrap();
    let before: i64 =
        sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    let observed = history::retention(&f.app).await.unwrap().cutoff;
    let after: i64 =
        sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
            .fetch_one(&f.app.db)
            .await
            .unwrap();
    eprintln!("Host/PG offset: {} ms", util::now() - after);
    f.finish().await;
    assert!(
        (before - 2 * 86_400_000..=after - 2 * 86_400_000).contains(&observed),
        "retention cutoff {observed} used a different clock from the configuration bounds {before}..{after}"
    );
}

async fn pg_now(app: &App) -> i64 {
    sqlx::query_scalar("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint")
        .fetch_one(&app.db)
        .await
        .unwrap()
}
pub(super) async fn retire(app: &App) {
    for _ in 0..100 {
        retention::maintain(app).await.unwrap();
        let done: bool = sqlx::query_scalar("SELECT bool_and(retired) FROM analytical_cleanup")
            .fetch_one(&app.db)
            .await
            .unwrap();
        if done {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("retirement did not finish");
}
async fn mutation_counts(f: &Fixture) -> (u64, u64) {
    let raw=history::clickhouse(&f.app,"SELECT toString(count()) AS total,toString(countIf(is_done=0)) AS pending FROM system.mutations WHERE database='krine' AND table={table:String} FORMAT JSONEachRow",vec![("param_table",format!("history_v2_{}",f.schema))],None).await.unwrap();
    let value: Value = serde_json::from_str(raw.trim()).unwrap();
    (
        value["total"].as_str().unwrap().parse().unwrap(),
        value["pending"].as_str().unwrap().parse().unwrap(),
    )
}
async fn seed_rows(f: &Fixture, count: usize, at: i64) {
    history::clickhouse(&f.app,&format!("INSERT INTO history_v2_{} SELECT 'event',concat('seed:{at}:',toString(number)),{at},'{{}}',1 FROM numbers({count})",f.schema),vec![],None).await.unwrap();
}

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn pending_retirement_and_lost_cleanup_ack_do_not_block_export_or_queue_work() {
    let mut f = Fixture::new().await;
    history::configure_retention(&f.app.db, 2).await.unwrap();
    history::export(&f.app).await.unwrap();
    seed_rows(&f, 200, pg_now(&f.app).await - 3 * 86_400_000).await;
    // An actual slow old TTL materialization keeps source parts active while
    // the application removes TTL. No fake completion flag or paused clock.
    history::clickhouse(&f.app,&format!("ALTER TABLE history_v2_{} MODIFY TTL toDateTime(intDiv(at,1000)) + INTERVAL 2 DAY DELETE WHERE sleepEachRow(0.01)=0 SETTINGS alter_sync=0,allow_nondeterministic_mutations=1,materialize_ttl_after_modify=1",f.schema),vec![],None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(mutation_counts(&f).await.1, 1);
    history::configure_retention(&f.app.db, 30).await.unwrap();
    let r = history::retention(&f.app).await.unwrap();
    assert_eq!((r.days, r.requested_days), (2, 30));
    // Simulate process death after ClickHouse accepts the first cleanup job,
    // before PostgreSQL records its completion. Durable intent survives.
    f.app.provider_test.lose_cleanup_ack = true;
    assert!(retention::maintain(&f.app).await.is_err());
    f.app.provider_test.lose_cleanup_ack = false;
    f.restart().await;
    let before = mutation_counts(&f).await;
    let (a, b) = tokio::join!(retention::maintain(&f.app), retention::maintain(&f.app));
    a.unwrap();
    b.unwrap();
    let after = mutation_counts(&f).await;
    assert_eq!(
        before, after,
        "pending job must not multiply across replicas"
    );
    assert_eq!(history::retention(&f.app).await.unwrap().days, 2);
    let event = unique();
    json_ok(
        f.http
            .post(format!("{}/v1/events", f.url))
            .bearer_auth(&f.app.config.server_secret)
            .json(&json!({"event_id":event,"name":"signup","user_id":"pending-cleanup"})),
    )
    .await;
    history::export(&f.app).await.unwrap();
    let raw = history::clickhouse(
        &f.app,
        &format!(
            "SELECT count() FROM history_v2_{} WHERE id={{id:String}}",
            f.schema
        ),
        vec![("param_id", format!("event:{event}"))],
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        raw.trim(),
        "1",
        "export must continue with retirement pending"
    );
    assert_eq!(mutation_counts(&f).await.1, 1);
    tokio::time::sleep(Duration::from_secs(3)).await;
    retire(&f.app).await;
    assert_eq!(history::retention(&f.app).await.unwrap().days, 30);
    let before = mutation_counts(&f).await;
    for _ in 0..5 {
        retention::maintain(&f.app).await.unwrap();
    }
    assert_eq!(
        mutation_counts(&f).await,
        before,
        "no maintenance mutation before four-hour cadence"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn clock_floor_and_outage_extension_cannot_resurrect_expired_physical_rows() {
    let f = Fixture::new().await;
    history::configure_retention(&f.app.db, 2).await.unwrap();
    history::export(&f.app).await.unwrap();
    retire(&f.app).await;
    let pg = pg_now(&f.app).await;
    let host = util::now();
    // Store a row that the old host-clock implementation classified expired,
    // but could resurrect when configuration used the lagging database clock.
    let at = pg - 2 * 86_400_000 + (host - pg).max(1000) / 2;
    let id = unique();
    let payload = json!({"event_id":id,"name":"clock-edge","accepted_at":at});
    let row = json!({"kind":"event","id":format!("event:{id}"),"at":at,"payload":payload.to_string(),"revision":1});
    history::clickhouse(
        &f.app,
        &format!("INSERT INTO history_v2_{} FORMAT JSONEachRow", f.schema),
        vec![],
        Some(format!("{row}\n")),
    )
    .await
    .unwrap();
    let first = history::retention(&f.app).await.unwrap().cutoff;
    assert!(first < at);
    // A previously committed future floor represents a database clock step
    // backward. Neither a read nor a larger window may lower it.
    sqlx::query("UPDATE analytical_retention SET expired_before=$1")
        .bind(at + 1)
        .execute(&f.app.db)
        .await
        .unwrap();
    rejected(
        f.admin(Method::GET, &format!("/activity/events/{id}")),
        "not_found",
    )
    .await;
    let mut config = Config::load().unwrap();
    config.database_url = f.app.config.database_url.clone();
    config.valkey_url = f.app.config.valkey_url.clone();
    config.clickhouse_url = "http://127.0.0.1:1".into();
    let outage = App::connect(config).await.unwrap();
    history::configure_retention(&outage.db, 30).await.unwrap();
    assert_eq!(history::retention(&outage).await.unwrap().days, 30);
    assert!(retention::maintain(&outage).await.is_ok()); // Not due: no CH reads.
    assert!(history::retention(&f.app).await.unwrap().cutoff > at);
    rejected(
        f.admin(Method::GET, &format!("/activity/events/{id}")),
        "not_found",
    )
    .await;
    let raw = history::clickhouse(
        &f.app,
        &format!(
            "SELECT count() FROM history_v2_{} WHERE id={{id:String}}",
            f.schema
        ),
        vec![("param_id", format!("event:{id}"))],
        None,
    )
    .await
    .unwrap();
    assert_eq!(
        raw.trim(),
        "1",
        "logical expiry must not depend on physical deletion"
    );
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn cleanup_query_identity_queue_guard_and_permissions_are_narrow() {
    let f = Fixture::new().await;
    history::export(&f.app).await.unwrap();
    retire(&f.app).await;
    seed_rows(&f, 200, pg_now(&f.app).await).await;
    let query_id = format!("krine-history-cleanup-history_v2_{}", f.schema);
    let occupied = tokio::spawn({
        let app = f.app.clone();
        let query_id = query_id.clone();
        async move {
            history::clickhouse(&app, "SELECT sleep(1)", vec![("query_id", query_id)], None).await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    sqlx::query("UPDATE analytical_cleanup SET next_cleanup=0 WHERE table_name='history_v2'")
        .execute(&f.app.db)
        .await
        .unwrap();
    assert!(
        retention::maintain(&f.app).await.is_err(),
        "fixed query ID rejects concurrent submission"
    );
    occupied.await.unwrap().unwrap();
    retention::maintain(&f.app).await.unwrap();
    // The real engine queue limit also rejects a different submission while a
    // prior accepted mutation remains unfinished after its caller disappears.
    history::clickhouse(&f.app,&format!("ALTER TABLE history_v2_{} UPDATE at=at+toInt64(sleepEachRow(0.01)) WHERE 1 SETTINGS mutations_sync=0,allow_nondeterministic_mutations=1",f.schema),vec![],None).await.unwrap();
    let pending = mutation_counts(&f).await;
    assert_eq!(pending.1, 1);
    assert!(history::clickhouse(&f.app,&format!("ALTER TABLE history_v2_{} DELETE WHERE at<0 SETTINGS mutations_sync=0,number_of_mutations_to_throw=1",f.schema),vec![("query_id",query_id)],None).await.is_err());
    assert_eq!(mutation_counts(&f).await, pending);
    // Deployment only grants the columns needed by the application. Mutation
    // command text and error messages can include data and remain inaccessible.
    assert!(
        history::clickhouse(
            &f.app,
            "SELECT command FROM system.mutations WHERE database='krine'",
            vec![],
            None
        )
        .await
        .is_err()
    );
    assert!(
        history::clickhouse(
            &f.app,
            "SELECT latest_fail_reason FROM system.mutations WHERE database='krine'",
            vec![],
            None
        )
        .await
        .is_err()
    );
    tokio::time::sleep(Duration::from_secs(3)).await;
    f.finish().await;
}

#[tokio::test]
#[ignore = "requires the guarded isolated stores"]
async fn cleanup_cadence_cost_and_activation_recovery_are_bounded() {
    let f = Fixture::new().await;
    history::export(&f.app).await.unwrap();
    retire(&f.app).await;
    let now = pg_now(&f.app).await;
    seed_rows(&f, 60_000, now - 3 * 86_400_000).await;
    seed_rows(&f, 200, now).await;
    history::configure_retention(&f.app.db, 2).await.unwrap();
    // Represent a crash after both retirement checkpoints, before activation.
    // No cleanup is due; recovery must still make the requested window effective.
    sqlx::query("UPDATE analytical_retention SET requested_days=30")
        .execute(&f.app.db)
        .await
        .unwrap();
    let count = mutation_counts(&f).await;
    retention::maintain(&f.app).await.unwrap();
    assert_eq!(history::retention(&f.app).await.unwrap().days, 30);
    assert_eq!(mutation_counts(&f).await, count);
    sqlx::query("UPDATE analytical_cleanup SET next_cleanup=0 WHERE table_name='history_v2'")
        .execute(&f.app.db)
        .await
        .unwrap();
    let started = Instant::now();
    retention::maintain(&f.app).await.unwrap();
    let submitted = started.elapsed();
    for _ in 0..100 {
        retention::maintain(&f.app).await.unwrap();
        let job: Option<i64> = sqlx::query_scalar(
            "SELECT baseline FROM analytical_cleanup WHERE table_name='history_v2'",
        )
        .fetch_one(&f.app.db)
        .await
        .unwrap();
        if job.is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let raw = history::clickhouse(
        &f.app,
        &format!("SELECT count() FROM history_v2_{}", f.schema),
        vec![],
        None,
    )
    .await
    .unwrap();
    assert_eq!(raw.trim(), "200");
    let after = mutation_counts(&f).await;
    assert_eq!(after.0, count.0 + 1, "one mutation for the whole due table");
    assert_eq!(after.1, 0);
    let until: i64 = sqlx::query_scalar(
        "SELECT next_cleanup FROM analytical_cleanup WHERE table_name='history_v2'",
    )
    .fetch_one(&f.app.db)
    .await
    .unwrap();
    assert!(until >= now + 4 * 3_600_000);
    println!(
        "60,200-row cleanup: submission {:?}, completion {:?}; 60,000 expired, 200 retained",
        submitted,
        started.elapsed()
    );
    for _ in 0..5 {
        retention::maintain(&f.app).await.unwrap();
    }
    assert_eq!(mutation_counts(&f).await, after);
    f.finish().await;
}
