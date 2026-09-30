//! Fictional history is evaluated by the same policy and captured-reason code as
//! live requests. No proofs, credentials, receipts or hot counters are generated.
use crate::{
    Configuration, DAY, Result,
    output::{Output, digest},
};
use krine_core::{
    METRICS, MetricObservation, Observation, Policy, Provenance, Scalar, Snapshot, UnknownReason,
    ValidatedPolicy, Verification, capture_reason, derive_metrics, evaluate,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

const CHECK_OFFSET: i64 = 100_000;
const CHECKS: [&str; 3] = ["can_claim_trial", "can_login", "can_publish_listing"];
const CORRECTION_REASON: &str =
    "Fictional support review: this account was linked to the household client by mistake.";

struct Attempt {
    index: usize,
    at: i64,
    user: String,
    client: String,
    session: String,
    ip: String,
    check: &'static str,
    scenario: &'static str,
    automation: Option<bool>,
    provider_timeout: bool,
    late: bool,
    verification: Option<Verification>,
    event_offsets: Vec<i64>,
}
struct Association {
    id: String,
    client: String,
    user: String,
    session: String,
    at: i64,
    revoked_at: Option<i64>,
}
impl Association {
    fn summary(&self, at: i64) -> Value {
        let revoked = self.revoked_at.filter(|revoked| *revoked <= at);
        json!({"id":self.id,"kind":"backend","client_id":self.client,"session_id":self.session,"user_id":self.user,"ip":null,
            "first_seen":self.at,"last_seen":self.at,"source":"backend","credential_id":null,"last_credential_id":null,
            "first_source":"backend","last_source":"backend","first_event_id":null,"last_event_id":null,
            "revision":if revoked.is_some(){2}else{1},"revoked_at":revoked,"revocation_reason":revoked.map(|_|CORRECTION_REASON),"revoked_by":revoked.map(|_|"synthetic_operator")})
    }
}
fn id(config: &Configuration, kind: &str, key: impl std::fmt::Display) -> String {
    // Length-delimited JSON prevents distinct logical labels from aliasing.
    let bytes = serde_json::to_vec(&json!([
        config.seed,
        config.anchor_ms,
        config.users,
        config.attempts,
        kind,
        key.to_string()
    ]))
    .expect("JSON strings serialize");
    format!("{kind}_{}", &digest(&bytes)[..24])
}
fn user(index: usize) -> String {
    format!("demo-user-{:05}", index + 1)
}
fn random(config: &Configuration, label: &str, index: usize) -> u64 {
    let hash = digest(format!("{}:{label}:{index}", config.seed).as_bytes());
    u64::from_str_radix(&hash[..16], 16).expect("hex digest")
}
fn attempts(config: &Configuration) -> Vec<Attempt> {
    let start = config.anchor_ms - 28 * DAY;
    let household = id(config, "cl", "household");
    let burst = id(config, "cl", "burst");
    let mut attempts = Vec::with_capacity(config.attempts);
    for index in 0..config.attempts {
        let grouped = index >= 140;
        let visit = if grouped { (index - 140) / 3 } else { index };
        let step = if grouped { (index - 140) % 3 } else { 0 };
        let account = visit % config.users;
        // UTC weekdays are busier than weekends, and activity follows a daytime
        // rhythm. Each seed fixes the rhythm without depending on iteration order.
        let day = random(config, "day", visit) % 28;
        let midnight = start.div_euclid(DAY) * DAY + day as i64 * DAY;
        let weekday = (midnight.div_euclid(DAY) + 3).rem_euclid(7);
        let adjustment = if weekday >= 5 && visit % 4 != 0 {
            -(weekday - 4) * DAY
        } else {
            0
        };
        let hour = 8 + random(config, "hour", visit) % 12;
        let mut at = (midnight
            + adjustment
            + hour as i64 * 3_600_000
            + (random(config, "minute", visit) % 3_600_000) as i64)
            .clamp(start, config.anchor_ms - 1_800_000)
            + step as i64 * (150_000 + (random(config, "gap", visit) % 90_000) as i64);
        let mut account = account;
        let mut client = if account < 2 {
            household.clone()
        } else {
            id(
                config,
                "cl",
                format!(
                    "{account}:{}",
                    usize::from(visit >= config.users && visit % 7 == 0)
                ),
            )
        };
        let mut ip = format!("192.0.2.{}", 1 + account % 200);
        if account < 2 {
            ip = "198.51.100.23".into();
        }
        let mut check = CHECKS[if grouped { [1, 0, 2][step] } else { index % 3 }];
        let mut scenario = "returning_use";
        let mut automation = Some(false);
        let mut provider_timeout = false;
        let mut late = false;
        let mut verification = None;
        match index {
            0..=2 => {
                account = index;
                client = household.clone();
                ip = "198.51.100.23".into();
                at = config.anchor_ms - 20 * DAY + index as i64 * 120_000;
                check = CHECKS[0];
                scenario = "relationship_correction";
            }
            3..=4 => {
                account = 0;
                client = household.clone();
                ip = "198.51.100.23".into();
                at = config.anchor_ms - if index == 3 { 3 * DAY } else { DAY };
                check = CHECKS[0];
                scenario = "relationship_correction";
            }
            10..=49 => {
                account = index - 10;
                client = burst.clone();
                ip = "203.0.113.8".into();
                at = config.anchor_ms - DAY + 18 * 3_600_000 + (index - 10) as i64 * 6_000;
                check = CHECKS[0];
                scenario = "account_burst";
                automation = Some(true);
            }
            50..=79 => {
                at = config.anchor_ms - 6 * 3_600_000 + (index - 50) as i64 * 30_000;
                check = CHECKS[1];
                scenario = "provider_timeout";
                provider_timeout = true;
            }
            80..=95 => {
                at = config.anchor_ms - 4 * 3_600_000 + (index - 80) as i64 * 120_000;
                check = CHECKS[2];
                scenario = "verification_results";
                automation = Some(true);
                verification = Some(match (index - 80) % 4 {
                    0 => Verification::Passed,
                    1 => Verification::Failed,
                    2 => Verification::Expired,
                    _ => Verification::Unavailable,
                });
            }
            96..=99 => {
                at = config.anchor_ms - 3 * 3_600_000 + (index - 96) as i64 * 120_000;
                check = CHECKS[2];
                scenario = "missing_browser_signal";
                automation = None;
            }
            100..=119 => {
                account = (index - 100) % 2;
                client = id(config, "cl", "policy-household");
                ip = "198.51.100.24".into();
                at = config.anchor_ms - 7 * DAY
                    + if index < 110 {
                        -3_600_000 + (index - 100) as i64 * 120_000
                    } else {
                        3_600_000 + (index - 110) as i64 * 120_000
                    };
                check = CHECKS[0];
                scenario = "policy_change";
            }
            120..=139 => {
                at = config.anchor_ms - 2 * DAY + (index - 120) as i64 * 180_000;
                scenario = "late_event";
                late = true;
            }
            _ => {}
        }
        let event_count = 3 + (random(config, "event_count", index) % 5) as i64;
        let event_offsets = (0..event_count)
            .map(|step| step * step * 90_000 / ((event_count - 1) * (event_count - 1)))
            .collect();
        attempts.push(Attempt {
            index,
            at,
            user: user(account),
            client,
            session: id(
                config,
                "ses",
                if grouped {
                    format!("visit:{visit}")
                } else {
                    format!("scenario:{index}")
                },
            ),
            ip,
            check,
            scenario,
            automation,
            provider_timeout,
            late,
            verification,
            event_offsets,
        });
    }
    attempts.sort_by_key(|attempt| (attempt.at, attempt.index));
    attempts
}
fn policy(config: &Configuration, check: &str, version: i64) -> Result<(Value, ValidatedPolicy)> {
    let (rule, metric, comparison, value, action) = match check {
        "can_claim_trial" => (
            "shared_client",
            "client.user_count_30d",
            "gte",
            json!(if version == 1 { 3 } else { 2 }),
            "DENY",
        ),
        "can_login" => ("risky_ip", "ip.risk", "gte", json!(0.8), "DENY"),
        _ => (
            "automation",
            "browser.automation_observed",
            "eq",
            json!(true),
            "CHALLENGE",
        ),
    };
    let value = json!({"schema_version":1,"rules":[{"id":rule,"condition":{"op":"compare","left":{"source":"metric","name":metric,"version":1},"comparison":comparison,"value":value},"then":action,"on_unknown":"DENY"}],"otherwise":"ALLOW"});
    let policy: Policy = serde_json::from_value(value.clone())?;
    let validated = ValidatedPolicy::try_from(policy.clone())?;
    // Version 1 verification must reproduce the original immutable bundle bytes.
    let value = if config.generator_version == "1" {
        value
    } else {
        serde_json::to_value(policy)?
    };
    Ok((value, validated))
}
fn observe(snapshot: &mut Snapshot, name: &str, value: Scalar) {
    snapshot
        .metrics
        .get_mut(name)
        .expect("catalog metric")
        .state = Observation::Known { value };
}
fn observed(
    attempt: &Attempt,
    config: &Configuration,
    sessions: &BTreeMap<&str, Vec<&Attempt>>,
    at: i64,
) -> Value {
    let observations = &sessions[attempt.session.as_str()];
    let first = observations[0];
    let last = observations
        .iter()
        .rev()
        .find(|job| job.at <= at)
        .expect("observed session");
    json!({"id":id(config,"oip",&attempt.session),"kind":"observed_ip","client_id":attempt.client,"session_id":attempt.session,"user_id":null,"ip":attempt.ip,
        "first_seen":first.at,"last_seen":last.at,"source":"browser_observation","credential_id":null,"last_credential_id":null,
        "first_source":"browser.context","last_source":"browser.context","first_event_id":id(config,"evt",format!("{}:0",first.index)),"last_event_id":id(config,"evt",format!("{}:0",last.index)),
        "revision":1,"revoked_at":null,"revocation_reason":null,"revoked_by":null})
}
fn event_name(job: &Attempt, step: usize) -> &'static str {
    if step == 0 {
        return "browser.context";
    }
    if step == job.event_offsets.len() - 1 {
        return match job.check {
            "can_login" => "signin.requested",
            "can_claim_trial" => "trial.requested",
            _ => "listing.publish_requested",
        };
    }
    match job.check {
        "can_login" => [
            "signin.viewed",
            "account.identified",
            "password.checked",
            "signin.help_viewed",
            "signin.form_reviewed",
        ][step - 1],
        "can_claim_trial" => [
            "pricing.viewed",
            "plan.selected",
            "terms.viewed",
            "billing.details_submitted",
            "trial.form_reviewed",
        ][step - 1],
        _ => [
            "listing.editor_opened",
            "listing.draft_saved",
            "listing.photo_added",
            "listing.previewed",
            "listing.form_reviewed",
        ][step - 1],
    }
}
fn history(
    output: &mut Output,
    kind: &str,
    id: &str,
    at: i64,
    revision: u64,
    payload: Value,
) -> Result<()> {
    output.row("clickhouse","history_v2",json!({"kind":kind,"id":format!("{kind}:{id}"),"at":at,"revision":revision,"payload":serde_json::to_string(&payload)?}))?;
    output.count(format!("physical/{kind}"));
    Ok(())
}

pub fn generate(config: &Configuration, output: &mut Output) -> Result<()> {
    let jobs = attempts(config);
    let marker = output.marker();
    let correction_at = config.anchor_ms - 2 * DAY;
    let household = id(config, "cl", "household");
    let mut entities: BTreeMap<(String, String), Value> = BTreeMap::new();
    let mut associations: BTreeMap<(String, String), Association> = BTreeMap::new();
    let mut ip_events: BTreeMap<&str, Vec<i64>> = BTreeMap::new();
    let mut session_events: BTreeMap<&str, Vec<i64>> = BTreeMap::new();
    let mut sessions: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
    for job in &jobs {
        for (kind, key, at) in [
            ("user", &job.user, job.at + 50),
            ("client", &job.client, job.at),
            ("session", &job.session, job.at),
            ("ip", &job.ip, job.at),
        ] {
            entities.entry((kind.into(),key.clone())).or_insert_with(||json!({"kind":kind,"id":key,"client_id":if kind=="session" {json!(job.client)}else{Value::Null},"first_seen":at,"metadata":{"sample_data":marker,"label":if kind=="user" {format!("{}@example.test",key)}else{key.clone()}}}));
        }
        associations
            .entry((job.client.clone(), job.user.clone()))
            .or_insert_with(|| Association {
                id: id(config, "asc", format!("{}:{}", job.client, job.user)),
                client: job.client.clone(),
                user: job.user.clone(),
                session: job.session.clone(),
                at: job.at + 50,
                revoked_at: if job.client == household && job.user == user(2) {
                    Some(correction_at)
                } else {
                    None
                },
            });
        ip_events
            .entry(&job.ip)
            .or_default()
            .extend(job.event_offsets[1..].iter().map(|offset| job.at + offset));
        session_events
            .entry(&job.session)
            .or_default()
            .extend(job.event_offsets[1..].iter().map(|offset| job.at + offset));
        sessions.entry(&job.session).or_default().push(job);
    }
    for times in ip_events.values_mut().chain(session_events.values_mut()) {
        times.sort_unstable();
    }
    let mut by_client: BTreeMap<&str, Vec<&Association>> = BTreeMap::new();
    for edge in associations.values() {
        by_client.entry(&edge.client).or_default().push(edge);
    }
    let mut scenario_examples: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for job in &jobs {
        for (step, offset) in job.event_offsets.iter().enumerate() {
            let at = job.at + offset;
            let provenance = if step == 0 { "browser" } else { "backend" };
            let name = event_name(job, step);
            let event_id = id(config, "evt", format!("{}:{step}", job.index));
            let mut event = json!({"event_id":event_id,"name":name,"client_id":job.client,"session_id":job.session,"ip":job.ip,"accepted_at":at,"provenance":provenance,"sample_data":marker});
            if step == 0 {
                event["properties"] = json!({"webdriver":job.automation,"language":"en-GB","timezone":"Europe/Warsaw","platform":"Linux","screen_width":1440,"screen_height":900});
            } else {
                event["user_id"] = json!(job.user);
                event["occurred_at"] = json!(if job.late { at - 2 * 3_600_000 } else { at });
                event["properties"] = json!({"check":job.check,"scenario":job.scenario});
            }
            history(output, "event", &event_id, at, 1, event)?;
            output.count("history/event");
            output.count(format!("provenance/{provenance}"));
            output.count(format!("event_name/{name}"));
            output.count(format!("events/day/{}", at.div_euclid(DAY)));
        }
        let at = job.at + CHECK_OFFSET;
        let version = if job.check == CHECKS[0] && at >= config.anchor_ms - 7 * DAY {
            2
        } else {
            1
        };
        let (policy, validated) = policy(config, job.check, version)?;
        let mut active = by_client[job.client.as_str()]
            .iter()
            .copied()
            .filter(|edge| {
                edge.at <= at && edge.at >= at - 30 * DAY && edge.revoked_at.is_none_or(|t| t > at)
            })
            .collect::<Vec<_>>();
        active.sort_by(|a, b| (b.at, &b.id).cmp(&(a.at, &a.id)));
        let users = active
            .iter()
            .map(|edge| &edge.user)
            .collect::<BTreeSet<_>>()
            .len();
        let relationships = json!({"items":active.iter().take(100).map(|edge|edge.summary(at)).collect::<Vec<_>>(),"total":active.len(),"truncated":active.len()>100,"observed_at":at,"observed_ip":observed(job,config,&sessions,at)});
        let mut snapshot = Snapshot::default();
        for metric in METRICS {
            snapshot.metrics.insert(
                metric.name.into(),
                MetricObservation {
                    version: metric.version,
                    state: Observation::unknown(UnknownReason::Missing),
                    provenance: Provenance {
                        source: metric.source.into(),
                        observed_at: at as u64,
                    },
                },
            );
        }
        let first = entities[&("client".into(), job.client.clone())]["first_seen"]
            .as_i64()
            .ok_or("Client first seen missing")?;
        observe(
            &mut snapshot,
            "client.age_seconds",
            Scalar::Number(((at - first) / 1000) as f64),
        );
        observe(
            &mut snapshot,
            "session.age_seconds",
            Scalar::Number(((at - sessions[job.session.as_str()][0].at) / 1000) as f64),
        );
        observe(
            &mut snapshot,
            "client.user_count_30d",
            Scalar::Number(users as f64),
        );
        for (metric, times) in [
            ("ip.event_count_5m", &ip_events[job.ip.as_str()]),
            (
                "session.event_count_5m",
                &session_events[job.session.as_str()],
            ),
        ] {
            let count =
                times.partition_point(|t| *t <= at) - times.partition_point(|t| *t < at - 300_000);
            observe(&mut snapshot, metric, Scalar::Number(count as f64));
        }
        if let Some(value) = job.automation {
            observe(
                &mut snapshot,
                "browser.automation_observed",
                Scalar::Boolean(value),
            );
        }
        let uses_ip = job.check == CHECKS[1];
        if uses_ip {
            for name in ["ip.risk", "ip.country", "ip.is_proxy"] {
                let metric = snapshot.metrics.get_mut(name).expect("catalog metric");
                metric.provenance.source = "synthetic_ip_intelligence@1".into();
                metric.state = Observation::unknown(UnknownReason::Timeout);
            }
            if !job.provider_timeout {
                let risky = job.scenario == "late_event" && job.index % 7 == 0;
                observe(
                    &mut snapshot,
                    "ip.risk",
                    Scalar::Number(if risky { 0.94 } else { 0.03 }),
                );
                observe(
                    &mut snapshot,
                    "ip.country",
                    Scalar::String(if job.index % 3 == 0 { "PL" } else { "GB" }.into()),
                );
                observe(&mut snapshot, "ip.is_proxy", Scalar::Boolean(risky));
            }
        }
        derive_metrics(&mut snapshot, at as u64);
        let initial = evaluate(&validated, &snapshot, &BTreeMap::new())?;
        let decision_id = id(config, "dec", job.index);
        let operation_id = id(config, "op", job.index);
        let challenge_id = id(config, "ch", job.index);
        let mut detail = json!({"decision_id":decision_id,"operation_id":operation_id,"hostname":"demo.example.test","check":job.check,"policy_version":version,"accepted_at":at,"retry_until":at+DAY,"completed_at":at,
            "client_id":job.client,"session_id":job.session,"user_id":job.user,"ip":job.ip,"policy":policy,"snapshot":snapshot,"relationship_ids":relationships["items"].as_array().ok_or("Missing relationship items")?.iter().map(|r|r["id"].clone()).collect::<Vec<_>>(),"relationship_context":relationships,
            "provider_revisions":{},"provider_observations":{},"source":"evaluation","sample_data":marker,"verification_transitions":[],"requests":[{"at":at,"kind":"initial","result":initial.outcome}],"evaluation":initial,"outcome":initial.outcome,"reason":initial.reason});
        if uses_ip {
            detail["provider_revisions"] = json!({"ip_intelligence":{"revision":1,"enabled":true}});
            detail["provider_observations"] = json!({"ip_intelligence":{"revision":1,"status":if job.provider_timeout {"unknown"}else{"known"},"detail":if job.provider_timeout {"timeout"}else{"synthetic_observation"},"observed_at":at}});
        }
        if let Some(verification) = job.verification {
            if initial.outcome != krine_core::Outcome::ChallengeRequired {
                return Err("Verification scenario did not reach its challenge rule".into());
            }
            detail["provider_revisions"]["verification"] = json!({"revision":1,"enabled":true});
            detail["verification_transitions"] = json!([{"sequence":1,"at":at,"challenge_id":challenge_id,"state":"pending","detail":"verification_required"}]);
            let completed = at
                + if verification == Verification::Expired {
                    300_000
                } else {
                    30_000
                };
            let verified = BTreeMap::from([("automation".into(), verification)]);
            let final_evaluation = evaluate(&validated, &snapshot, &verified)?;
            detail["completed_at"] = json!(completed);
            detail["evaluation"] = json!(final_evaluation);
            detail["outcome"] = json!(final_evaluation.outcome);
            detail["reason"] = json!(final_evaluation.reason);
            detail["verification_transitions"].as_array_mut().ok_or("Missing transitions")?.push(json!({"sequence":2,"at":completed,"challenge_id":challenge_id,"state":verification,"detail":match verification {Verification::Passed=>"synthetic_passed",Verification::Failed=>"synthetic_failed",Verification::Expired=>"attempt_expired",Verification::Unavailable=>"synthetic_provider_unavailable"}}));
            detail["requests"] = json!([{"at":at,"kind":"initial","result":"CHALLENGE_REQUIRED"},{"at":at,"kind":"verification","result":"pending"},{"at":completed,"kind":"verification","result":verification}]);
        }
        detail["reason_summary"] = capture_reason(&detail)?;
        if detail["outcome"] == "CHALLENGE_REQUIRED" {
            return Err("Historical sample cannot leave an active challenge".into());
        }
        output.count("history/decision");
        output.count(format!(
            "outcome/{}",
            detail["outcome"].as_str().ok_or("Missing outcome")?
        ));
        output.count(format!(
            "reason/{}",
            detail["reason"].as_str().ok_or("Missing reason")?
        ));
        output.count(format!("check/{}", job.check));
        output.count(format!("decisions/day/{}", at.div_euclid(DAY)));
        output.count(format!("scenario/{}", job.scenario));
        let examples = scenario_examples.entry(job.scenario).or_default();
        if examples.len() >= 8 {
            examples.pop();
        }
        examples.push(json!({"decision_id":decision_id,"user_id":job.user,"client_id":job.client,"at":at,"outcome":detail["outcome"],"reason":detail["reason"],"decision_path":format!("/activity/decisions/{decision_id}"),"user_path":format!("/inspect/entity?kind=user&id={}",job.user)}));
        history(
            output,
            "decision",
            &decision_id,
            at,
            if job.verification.is_some() { 2 } else { 1 },
            detail,
        )?;
    }
    for check in CHECKS {
        let version = if check == CHECKS[0] { 2 } else { 1 };
        output.row("postgres","checks",json!({"name":check,"description":match check {"can_claim_trial"=>"Sample: investigate shared clients and policy changes.","can_login"=>"Sample: distinguish unknown provider evidence from high risk.",_=>"Sample: follow verification outcomes and missing browser signals."},"draft":policy(config,check,version)?.0,"draft_revision":version,"active_version":version,"restored_from_version":null,"created_at":config.anchor_ms-28*DAY,"updated_at":if version==2 {config.anchor_ms-7*DAY}else{config.anchor_ms-28*DAY}}))?;
    }
    for check in CHECKS {
        for version in 1..=if check == CHECKS[0] { 2 } else { 1 } {
            output.row("postgres","policy_versions",json!({"check_name":check,"version":version,"policy":policy(config,check,version)?.0,"published_at":if version==2 {config.anchor_ms-7*DAY}else{config.anchor_ms-28*DAY},"restored_from_version":null}))?;
        }
    }
    for ((kind, _), entity) in entities {
        output.count(format!("entities/{kind}"));
        output.row("postgres", "entities", entity)?;
    }
    for edge in associations.values() {
        let summary = edge.summary(config.anchor_ms);
        let metadata = json!({"sample_data":marker});
        let envelope = json!({"association_id":edge.id,"client_id":edge.client,"user_id":edge.user,"session_id":edge.session,"metadata":metadata});
        output.row("postgres","associations",json!({"id":edge.id,"digest":digest(&serde_json::to_vec(&envelope)?),"client_id":edge.client,"user_id":edge.user,"session_id":edge.session,"credential_id":null,"metadata":metadata,"created_at":edge.at,"revoked_at":summary["revoked_at"],"revocation_reason":summary["revocation_reason"],"revoked_by":summary["revoked_by"],"revision":summary["revision"]}))?;
        output.count("relationships/backend");
    }
    for observations in sessions.values() {
        let job = observations[0];
        let summary = observed(job, config, &sessions, config.anchor_ms);
        let mut row = summary.clone();
        let object = row.as_object_mut().ok_or("Missing observed IP object")?;
        for key in ["kind", "user_id", "source"] {
            object.remove(key);
        }
        object.insert("has_corrections".into(), json!(false));
        output.row("postgres", "observed_ips", row)?;
        output.count("relationships/observed_ip");
    }
    let correction = associations
        .get(&(household, user(2)))
        .ok_or("Missing correction scenario")?;
    output.row("postgres","relationship_audit",json!({"id":id(config,"audit","correction"),"kind":"backend","relationship_id":correction.id,"at":correction_at,"action":"correct","reason":CORRECTION_REASON,"actor":"synthetic_operator","revision":2,"relationship":correction.summary(config.anchor_ms)}))?;
    for (name, examples) in scenario_examples {
        let description = match name {
            "account_burst" => {
                "Forty accounts share a client and IP within four minutes; inspect increasing authoritative counts and the deny rule."
            }
            "provider_timeout" => {
                "A provider timeout is explicitly unknown, not a safe score; the login policy denies it."
            }
            "verification_results" => {
                "Four examples each of passed, failed, expired and unavailable synthetic verification; latest decisions are final."
            }
            "missing_browser_signal" => {
                "Missing automation evidence follows the policy's unknown route."
            }
            "policy_change" => {
                "Version 2 lowers the shared-client threshold from three accounts to two; compare captured versions around publication."
            }
            "relationship_correction" => {
                "An incorrect third household association is corrected; old snapshots remain intact while current relationships exclude it."
            }
            "late_event" => {
                "Events occurred two hours before acceptance; five-minute counts use acceptance time."
            }
            _ => {
                "Returning fictional users, multiple devices and shared networks over 28 days; varied events lead through login, trial and listing decisions within related sessions."
            }
        };
        output.scenario(json!({"name":name,"description":description,"examples":examples}));
    }
    Ok(())
}

#[cfg(test)]
mod plan_tests {
    use super::*;
    #[test]
    fn standard_profile_has_returning_multi_action_sessions_with_bounded_variation() {
        let config = Configuration {
            generator_version: "1".into(),
            seed: "krine-demo-v1".into(),
            anchor_ms: 1_790_000_000_000,
            users: 2000,
            attempts: 10_000,
            max_bytes: 536_870_912,
        };
        let jobs = attempts(&config);
        assert_eq!(jobs.len(), 10_000);
        assert_eq!(
            jobs.iter()
                .map(|job| &job.user)
                .collect::<BTreeSet<_>>()
                .len(),
            2000
        );
        let event_count: usize = jobs.iter().map(|job| job.event_offsets.len()).sum();
        assert!((49_000..51_000).contains(&event_count));
        let mut sessions: BTreeMap<&str, Vec<&Attempt>> = BTreeMap::new();
        for job in &jobs {
            sessions.entry(&job.session).or_default().push(job);
        }
        assert!(sessions.len() < 3500);
        assert!(sessions.values().filter(|jobs| jobs.len() == 3).count() > 3200);
        for session in sessions.values() {
            assert!(session.iter().all(|job| job.client == session[0].client
                && job.user == session[0].user
                && job.ip == session[0].ip));
            assert!(session.last().unwrap().at - session[0].at < 600_000);
        }
        let mut visits: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for job in &jobs {
            visits.entry(&job.user).or_default().insert(&job.session);
        }
        assert!(
            visits
                .values()
                .filter(|sessions| sessions.len() > 1)
                .count()
                > 1200
        );
    }
}
