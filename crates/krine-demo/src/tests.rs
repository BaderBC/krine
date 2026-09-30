use super::*;
use krine_core::{Policy, Snapshot, ValidatedPolicy, Verification, capture_reason, evaluate};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    sync::atomic::{AtomicUsize, Ordering},
};
static SEQUENCE: AtomicUsize = AtomicUsize::new(0);
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "krine-demo-test-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        if self.0.exists() {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
}
fn config() -> Configuration {
    Configuration {
        generator_version: VERSION.into(),
        seed: "test-seed".into(),
        anchor_ms: 1_798_675_200_000,
        users: 40,
        attempts: 200,
        max_bytes: 16 * 1024 * 1024,
    }
}
fn generate(
    path: &std::path::Path,
    config: &Configuration,
    verify: bool,
) -> Result<output::Manifest> {
    let mut out = output::Output::open(path.to_path_buf(), config.clone(), verify)?;
    dataset::generate(config, &mut out)?;
    out.finish()
}
fn rows(path: &std::path::Path, manifest: &output::Manifest, table: &str) -> Vec<Value> {
    manifest
        .chunks
        .iter()
        .filter(|c| c.table == table)
        .flat_map(|c| {
            fs::read_to_string(path.join(&c.name))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect::<Vec<Value>>()
        })
        .collect()
}

#[test]
fn deterministic_generation_resume_and_corruption_detection() {
    let first = Directory::new();
    let second = Directory::new();
    let cfg = config();
    let manifest = generate(&first.0, &cfg, false).unwrap();
    assert_eq!(manifest, generate(&second.0, &cfg, false).unwrap());
    assert_eq!(manifest, generate(&first.0, &cfg, true).unwrap());
    let removed = &manifest.chunks[2].name;
    fs::remove_file(first.0.join(removed)).unwrap();
    assert!(generate(&first.0, &cfg, true).is_err());
    assert_eq!(manifest, generate(&first.0, &cfg, false).unwrap());
    let altered = &manifest.chunks[0].name;
    fs::write(first.0.join(altered), b"corrupt\n").unwrap();
    assert!(generate(&first.0, &cfg, false).is_err());
    assert!(generate(&first.0, &cfg, true).is_err());
}
#[test]
fn resource_bounds_lock_and_configuration_ownership_are_enforced() {
    let directory = Directory::new();
    let cfg = config();
    let lock = output::Output::open(directory.0.clone(), cfg.clone(), false).unwrap();
    assert!(output::Output::open(directory.0.clone(), cfg.clone(), false).is_err());
    drop(lock);
    let mut changed = cfg.clone();
    changed.seed = "another".into();
    assert!(generate(&directory.0, &changed, false).is_err());
    let small = Directory::new();
    let mut cfg = cfg;
    cfg.max_bytes = 1_048_576;
    assert!(generate(&small.0, &cfg, false).is_err());
    assert!(!small.0.join("manifest.json").exists());
    let foreign = Directory::new();
    fs::create_dir(&foreign.0).unwrap();
    fs::write(foreign.0.join("unrelated"), b"preserve").unwrap();
    assert!(generate(&foreign.0, &config(), false).is_err());
    assert_eq!(fs::read(foreign.0.join("unrelated")).unwrap(), b"preserve");
}
#[cfg(unix)]
#[test]
fn artifact_symlinks_are_rejected() {
    let directory = Directory::new();
    let target = Directory::new();
    let cfg = config();
    let manifest = generate(&directory.0, &cfg, false).unwrap();
    fs::create_dir(&target.0).unwrap();
    let sentinel = target.0.join("sentinel");
    fs::write(&sentinel, b"preserve").unwrap();
    let path = directory.0.join(&manifest.chunks[0].name);
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(&sentinel, &path).unwrap();
    assert!(generate(&directory.0, &cfg, false).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"preserve");
}
#[test]
fn history_ledger_counters_relationships_and_captured_evaluations_agree() {
    let directory = Directory::new();
    let cfg = config();
    let manifest = generate(&directory.0, &cfg, false).unwrap();
    assert_eq!(manifest.counts["history/event"], 996);
    assert_eq!(manifest.counts["history/decision"], 200);
    assert_eq!(manifest.counts["physical/decision"], 200);
    assert_eq!(manifest.counts["entities/user"], 40);
    assert!(
        manifest
            .chunks
            .iter()
            .all(|c| c.rows <= 500 && c.bytes <= 2 * 1024 * 1024)
    );
    assert_eq!(
        manifest.bytes,
        manifest.chunks.iter().map(|c| c.bytes).sum::<u64>()
    );
    let mut latest: BTreeMap<String, (u64, Value)> = BTreeMap::new();
    for row in rows(&directory.0, &manifest, "history_v2") {
        let id = row["id"].as_str().unwrap().to_owned();
        let revision = row["revision"].as_u64().unwrap();
        let payload: Value = serde_json::from_str(row["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload["sample_data"]["dataset_id"], manifest.dataset_id);
        let at = row["at"].as_i64().unwrap();
        assert!((manifest.from..=manifest.to).contains(&at));
        if latest.get(&id).is_none_or(|(prior, _)| revision > *prior) {
            latest.insert(id, (revision, payload));
        }
    }
    let events = latest
        .iter()
        .filter(|(key, _)| key.starts_with("event:"))
        .map(|(_, (_, payload))| payload)
        .collect::<Vec<_>>();
    let decisions = latest
        .iter()
        .filter(|(key, _)| key.starts_with("decision:"))
        .map(|(_, (_, payload))| payload)
        .collect::<Vec<_>>();
    assert_eq!(manifest.counts["entities/session"], 160);
    assert_eq!(manifest.counts["relationships/observed_ip"], 160);
    let mut per_session: BTreeMap<&str, usize> = BTreeMap::new();
    for decision in &decisions {
        *per_session
            .entry(decision["session_id"].as_str().unwrap())
            .or_default() += 1;
    }
    assert_eq!(
        per_session.values().filter(|count| **count == 3).count(),
        20
    );
    let ages = decisions
        .iter()
        .map(|decision| {
            decision["snapshot"]["metrics"]["session.age_seconds"]["state"]["value"]
                .as_f64()
                .unwrap() as u64
        })
        .collect::<std::collections::BTreeSet<_>>();
    assert!(ages.len() > 3);
    assert!(
        manifest
            .counts
            .keys()
            .filter(|key| key.starts_with("event_name/"))
            .count()
            > 12
    );
    let edges = rows(&directory.0, &manifest, "associations");
    let mut outcomes: BTreeMap<String, u64> = BTreeMap::new();
    let mut policy_before = 0;
    let mut policy_after = 0;
    let mut correction_before = 0;
    let mut correction_after = 0;
    for decision in decisions {
        let at = decision["accepted_at"].as_i64().unwrap();
        let completed = decision["completed_at"].as_i64().unwrap();
        assert!((at..=manifest.to).contains(&completed));
        let observations = events
            .iter()
            .filter(|event| {
                event["session_id"] == decision["session_id"]
                    && event["provenance"] == "browser"
                    && event["accepted_at"].as_i64().unwrap() <= at
            })
            .collect::<Vec<_>>();
        let first = observations
            .iter()
            .min_by_key(|event| event["accepted_at"].as_i64().unwrap())
            .unwrap();
        let last = observations
            .iter()
            .max_by_key(|event| event["accepted_at"].as_i64().unwrap())
            .unwrap();
        let observed = &decision["relationship_context"]["observed_ip"];
        assert_eq!(observed["first_seen"], first["accepted_at"]);
        assert_eq!(observed["last_seen"], last["accepted_at"]);
        assert_eq!(observed["first_event_id"], first["event_id"]);
        assert_eq!(observed["last_event_id"], last["event_id"]);
        let snapshot: Snapshot = serde_json::from_value(decision["snapshot"].clone()).unwrap();
        let policy = ValidatedPolicy::try_from(
            serde_json::from_value::<Policy>(decision["policy"].clone()).unwrap(),
        )
        .unwrap();
        let verified = decision["verification_transitions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|transition| {
                serde_json::from_value::<Verification>(transition["state"].clone()).ok()
            })
            .map(|value| ("automation".into(), value))
            .collect();
        let evaluation = evaluate(&policy, &snapshot, &verified).unwrap();
        assert_eq!(
            serde_json::to_value(evaluation).unwrap(),
            decision["evaluation"]
        );
        assert_eq!(
            capture_reason(decision).unwrap(),
            decision["reason_summary"]
        );
        let backend = events
            .iter()
            .filter(|event| {
                event["provenance"] == "backend"
                    && event["accepted_at"]
                        .as_i64()
                        .is_some_and(|t| t >= at - 300_000 && t <= at)
            })
            .collect::<Vec<_>>();
        for (metric, key) in [
            ("ip.event_count_5m", "ip"),
            ("session.event_count_5m", "session_id"),
        ] {
            let expected = backend
                .iter()
                .filter(|event| event[key] == decision[key])
                .count();
            assert_eq!(
                decision["snapshot"]["metrics"][metric]["state"]["value"]
                    .as_f64()
                    .unwrap(),
                expected as f64
            );
        }
        let active = edges
            .iter()
            .filter(|edge| {
                edge["client_id"] == decision["client_id"]
                    && edge["created_at"]
                        .as_i64()
                        .is_some_and(|t| t <= at && t >= at - 30 * DAY)
                    && edge["revoked_at"].as_i64().is_none_or(|t| t > at)
            })
            .count();
        assert_eq!(
            decision["snapshot"]["metrics"]["client.user_count_30d"]["state"]["value"]
                .as_f64()
                .unwrap(),
            active as f64
        );
        *outcomes
            .entry(decision["outcome"].as_str().unwrap().into())
            .or_default() += 1;
        let scenario = events
            .iter()
            .find(|event| {
                event["session_id"] == decision["session_id"] && event["provenance"] == "backend"
            })
            .unwrap()["properties"]["scenario"]
            .as_str()
            .unwrap();
        if scenario == "policy_change" {
            if decision["policy_version"] == 1 {
                assert_eq!(decision["outcome"], "ALLOW");
                policy_before += 1;
            } else {
                assert_eq!(decision["outcome"], "DENY");
                policy_after += 1;
            }
        }
        if scenario == "relationship_correction" && active == 3 {
            correction_before += 1;
        }
        if scenario == "relationship_correction" && at > cfg.anchor_ms - 2 * DAY {
            assert_eq!(active, 2);
            correction_after += 1;
        }
    }
    assert_eq!((policy_before, policy_after), (10, 10));
    assert!(correction_before > 0);
    assert_eq!(correction_after, 1);
    for (outcome, count) in outcomes {
        assert_eq!(manifest.counts[&format!("outcome/{outcome}")], count);
    }
    assert_eq!(manifest.scenarios.len(), 8);
}

#[test]
fn version_one_verification_preserves_original_bundle_bytes() {
    let directory = Directory::new();
    let mut cfg = config();
    cfg.generator_version = "1".into();
    cfg.validate().unwrap();
    let manifest = generate(&directory.0, &cfg, false).unwrap();
    assert_eq!(
        output::digest(&fs::read(directory.0.join("manifest.json")).unwrap()),
        "2924d0b642f89789f77e9bf1c9ece6bd4e86f2e536f36bf0b9cb3b7734b76eee"
    );
    assert_eq!(manifest, generate(&directory.0, &cfg, true).unwrap());
    for row in rows(&directory.0, &manifest, "policy_versions") {
        assert!(row["policy"].get("inputs").is_none());
    }
}

#[test]
fn new_bundles_serialize_every_policy_from_its_validated_type() {
    let directory = Directory::new();
    let cfg = config();
    assert_eq!(cfg.generator_version, "2");
    let manifest = generate(&directory.0, &cfg, false).unwrap();
    let mut policies = Vec::new();
    for row in rows(&directory.0, &manifest, "checks") {
        policies.push(row["draft"].clone());
    }
    for row in rows(&directory.0, &manifest, "policy_versions") {
        policies.push(row["policy"].clone());
    }
    for row in rows(&directory.0, &manifest, "history_v2") {
        let payload: Value = serde_json::from_str(row["payload"].as_str().unwrap()).unwrap();
        if let Some(policy) = payload.get("policy") {
            policies.push(policy.clone());
        }
    }
    assert_eq!(policies.len(), 207);
    for value in policies {
        let policy: Policy = serde_json::from_value(value.clone()).unwrap();
        ValidatedPolicy::try_from(policy.clone()).unwrap();
        assert_eq!(value, serde_json::to_value(policy).unwrap());
        assert_eq!(value["inputs"], serde_json::json!({}));
    }
}
