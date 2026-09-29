//! Small captured evidence samples for Activity. Full policy logic stays in detail.
use crate::error::{ApiError, Result};
use krine_core::{
    Condition, ConditionTrace, Evaluation, Observation, Policy, Reference, Scalar, Snapshot,
};
use serde_json::{Value, json};

const MAX_RULES: usize = 3;
const MAX_EVIDENCE: usize = 4;
const MAX_BYTES: usize = 8192;

pub(crate) fn capture(detail: &Value) -> Result<Value> {
    let evaluation: Evaluation = serde_json::from_value(detail["evaluation"].clone())
        .map_err(|_| ApiError::unavailable())?;
    let policy: Policy =
        serde_json::from_value(detail["policy"].clone()).map_err(|_| ApiError::unavailable())?;
    let snapshot: Snapshot =
        serde_json::from_value(detail["snapshot"].clone()).map_err(|_| ApiError::unavailable())?;
    let selected = evaluation
        .trace
        .iter()
        .filter(|rule| {
            evaluation
                .rule_id
                .as_ref()
                .is_none_or(|id| id == &rule.rule_id)
        })
        .collect::<Vec<_>>();
    let mut remaining = MAX_EVIDENCE;
    let mut rules = Vec::new();
    for trace in selected.iter().take(MAX_RULES) {
        let Some((index, rule)) = policy
            .rules
            .iter()
            .enumerate()
            .find(|(_, rule)| rule.id == trace.rule_id)
        else {
            return Err(ApiError::unavailable());
        };
        let mut evidence = Vec::new();
        let mut total = 0;
        leaves(
            &rule.condition,
            &trace.condition,
            &snapshot,
            &mut Vec::new(),
            &mut evidence,
            &mut total,
            remaining,
        )?;
        remaining -= evidence.len();
        rules.push(json!({"rule_id":rule.id,"position":index+1,"route":trace.route,"result":trace.condition.result,"compound":matches!(rule.condition,Condition::All{..}|Condition::Any{..}|Condition::Not{..}),"evidence":evidence,"evidence_truncated":total>evidence.len()}));
    }
    let truncated = selected.len() > MAX_RULES
        || rules.iter().any(|rule| {
            rule["evidence_truncated"] == true
                || rule["evidence"].as_array().is_some_and(|items| {
                    items.iter().any(|leaf| {
                        leaf["observed_truncated"] == true || leaf["test_truncated"] == true
                    })
                })
        });
    let mut summary = json!({"schema_version":1,"reason":detail["reason"],"outcome":detail["outcome"],"scope":if evaluation.rule_id.is_some(){"decisive_rule"}else{"otherwise"},"rule_id":evaluation.rule_id,"rules":rules,"rules_truncated":selected.len()>MAX_RULES,"provider_revisions":detail["provider_revisions"],"truncated":truncated});
    // Control characters in strings expand under JSON escaping. Enforce the
    // serialized budget too, without silently substituting a different value.
    while serde_json::to_vec(&summary)
        .map_err(|_| ApiError::unavailable())?
        .len()
        > MAX_BYTES
    {
        summary["truncated"] = json!(true);
        let rules = summary["rules"]
            .as_array_mut()
            .ok_or_else(ApiError::unavailable)?;
        let Some(rule) = rules.iter_mut().rev().find(|rule| {
            rule["evidence"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        }) else {
            return Err(ApiError::unavailable());
        };
        rule["evidence"]
            .as_array_mut()
            .ok_or_else(ApiError::unavailable)?
            .pop();
        rule["evidence_truncated"] = json!(true);
    }
    Ok(summary)
}
fn leaves(
    condition: &Condition,
    trace: &ConditionTrace,
    snapshot: &Snapshot,
    path: &mut Vec<usize>,
    evidence: &mut Vec<Value>,
    total: &mut usize,
    limit: usize,
) -> Result<()> {
    let children: Vec<&Condition> = match condition {
        Condition::All { conditions } | Condition::Any { conditions } => {
            conditions.iter().collect()
        }
        Condition::Not { condition } => vec![condition],
        _ => Vec::new(),
    };
    if !children.is_empty() {
        if children.len() != trace.children.len() {
            return Err(ApiError::unavailable());
        }
        for (index, (condition, trace)) in children.iter().zip(&trace.children).enumerate() {
            path.push(index);
            leaves(condition, trace, snapshot, path, evidence, total, limit)?;
            path.pop();
        }
        return Ok(());
    }
    *total += 1;
    if evidence.len() >= limit {
        return Ok(());
    }
    let reference = trace.reference.as_ref().ok_or_else(ApiError::unavailable)?;
    let observed = trace.observed.as_ref().ok_or_else(ApiError::unavailable)?;
    let (observed, observed_truncated) = match observed {
        Observation::Known { value } => {
            let (value, truncated) = scalar(value);
            (json!({"status":"known","value":value}), truncated)
        }
        Observation::Unknown { reason } => (json!({"status":"unknown","reason":reason}), false),
    };
    let (test, test_truncated) = match condition {
        Condition::Compare {
            comparison, value, ..
        } => {
            let (value, truncated) = scalar(value);
            (
                json!({"op":"compare","comparison":comparison,"value":value}),
                truncated,
            )
        }
        Condition::In { values, .. } => {
            let previews = values.iter().take(3).map(scalar).collect::<Vec<_>>();
            let truncated = values.len() > 3 || previews.iter().any(|(_, truncated)| *truncated);
            (
                json!({"op":"in","values":previews.into_iter().map(|(value,_)|value).collect::<Vec<_>>()}),
                truncated,
            )
        }
        Condition::Between { min, max, .. } => (json!({"op":"between","min":min,"max":max}), false),
        Condition::Known { .. } => (json!({"op":"known"}), false),
        _ => return Err(ApiError::unavailable()),
    };
    let provenance = match reference {
        Reference::Metric { name, .. } => snapshot
            .metrics
            .get(name)
            .map(|metric| json!(metric.provenance)),
        Reference::Input { .. } => None,
    };
    evidence.push(json!({"path":path,"reference":reference,"observed":observed,"observed_truncated":observed_truncated,"test":test,"test_truncated":test_truncated,"result":trace.result,"provenance":provenance}));
    Ok(())
}
fn scalar(value: &Scalar) -> (Value, bool) {
    match value {
        Scalar::String(value) if value.len() > 64 => {
            let mut end = 64;
            while !value.is_char_boundary(end) {
                end -= 1;
            }
            (json!(&value[..end]), true)
        }
        _ => (json!(value), false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use krine_core::{MetricObservation, Provenance, ValidatedPolicy, derive_metrics, evaluate};
    use std::collections::BTreeMap;
    fn detail(policy: Value, snapshot: Snapshot) -> Value {
        let policy: Policy = serde_json::from_value(policy).unwrap();
        let evaluation = evaluate(
            &ValidatedPolicy::try_from(policy.clone()).unwrap(),
            &snapshot,
            &BTreeMap::new(),
        )
        .unwrap();
        json!({"reason":evaluation.reason,"outcome":evaluation.outcome,"policy":policy,"evaluation":evaluation,"snapshot":snapshot,"provider_revisions":{"ip_intelligence":{"revision":7,"enabled":true}}})
    }
    #[test]
    fn captured_unknowns_keep_metric_version_provenance_and_unknown_route() {
        let mut snapshot = Snapshot::default();
        snapshot.metrics.insert(
            "ip.risk".into(),
            MetricObservation {
                version: 1,
                state: Observation::unknown(krine_core::UnknownReason::Timeout),
                provenance: Provenance {
                    source: "proxycheck@7".into(),
                    observed_at: 123,
                },
            },
        );
        let policy = json!({"schema_version":1,"rules":[{"id":"risk","condition":{"op":"compare","left":{"source":"metric","name":"ip.risk","version":1},"comparison":"gte","value":0.8},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
        let summary = capture(&detail(policy, snapshot)).unwrap();
        assert_eq!(summary["reason"], "unknown_denied");
        assert_eq!(summary["rules"][0]["route"], "deny");
        let leaf = &summary["rules"][0]["evidence"][0];
        assert_eq!(leaf["observed"]["reason"], "timeout");
        assert_eq!(leaf["reference"]["version"], 1);
        assert_eq!(leaf["provenance"]["source"], "proxycheck@7");
        assert_eq!(leaf["provenance"]["observed_at"], 123);
    }
    #[test]
    fn otherwise_contains_only_captured_continuations_with_explicit_bounds() {
        let mut snapshot = Snapshot::default();
        snapshot.metrics.insert(
            "client.user_count_30d".into(),
            MetricObservation {
                version: 1,
                state: Observation::Known {
                    value: Scalar::Number(0.0),
                },
                provenance: Provenance {
                    source: "backend_associations".into(),
                    observed_at: 1,
                },
            },
        );
        derive_metrics(&mut snapshot, 1);
        let rules=(0..8).map(|i|json!({"id":format!("r{i}"),"condition":{"op":"compare","left":{"source":"metric","name":"client.user_count_30d","version":1},"comparison":"gte","value":1},"then":"DENY","on_unknown":"DENY"})).collect::<Vec<_>>();
        let summary = capture(&detail(
            json!({"schema_version":1,"rules":rules,"otherwise":"ALLOW"}),
            snapshot,
        ))
        .unwrap();
        assert_eq!(summary["scope"], "otherwise");
        assert_eq!(summary["rules"].as_array().unwrap().len(), 3);
        assert_eq!(summary["rules_truncated"], true);
        for rule in summary["rules"].as_array().unwrap() {
            assert_eq!(rule["route"], "next");
            assert_eq!(rule["result"], "false");
            assert_eq!(rule["evidence"][0]["observed"]["value"], 0.0);
        }
    }
    #[test]
    fn value_preview_marks_the_whole_summary_incomplete() {
        let value = "é".repeat(40);
        let mut snapshot = Snapshot::default();
        snapshot
            .inputs
            .insert("text".into(), Scalar::String(value.clone()));
        let policy = json!({"schema_version":1,"inputs":{"text":"string"},"rules":[{"id":"text","condition":{"op":"compare","left":{"source":"input","name":"text"},"comparison":"eq","value":value},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
        let summary = capture(&detail(policy, snapshot)).unwrap();
        assert_eq!(summary["rules_truncated"], false);
        assert_eq!(summary["rules"][0]["evidence_truncated"], false);
        assert_eq!(summary["truncated"], true);
        assert_eq!(
            summary["rules"][0]["evidence"][0]["observed"]["value"]
                .as_str()
                .unwrap()
                .len(),
            64
        );
    }
    #[test]
    fn serialized_budget_and_string_previews_do_not_claim_complete_values() {
        let value = "\\\"\n😀".repeat(100);
        let mut snapshot = Snapshot::default();
        snapshot
            .inputs
            .insert("text".into(), Scalar::String(value.clone()));
        let leaf = json!({"op":"in","left":{"source":"input","name":"text"},"values":(0..32).map(|_|value.clone()).collect::<Vec<_>>()});
        let policy = json!({"schema_version":1,"inputs":{"text":"string"},"rules":[{"id":"long","condition":{"op":"all","conditions":vec![leaf;8]},"then":"DENY","on_unknown":"DENY"}],"otherwise":"ALLOW"});
        let summary = capture(&detail(policy, snapshot)).unwrap();
        assert!(serde_json::to_vec(&summary).unwrap().len() <= 8192);
        assert_eq!(summary["truncated"], true);
        assert_eq!(summary["rules"][0]["compound"], true);
        for leaf in summary["rules"][0]["evidence"].as_array().unwrap() {
            assert_eq!(leaf["observed_truncated"], true);
            assert_eq!(leaf["test_truncated"], true);
            assert!(leaf["observed"]["value"].as_str().unwrap().len() <= 64);
        }
    }
}
