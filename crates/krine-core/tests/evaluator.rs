use std::collections::BTreeMap;

use krine_core::*;

fn input(name: &str) -> Reference {
    Reference::Input { name: name.into() }
}
fn metric_ref(name: &str) -> Reference {
    Reference::Metric {
        name: name.into(),
        version: 1,
    }
}
fn is_true(name: &str) -> Condition {
    Condition::Compare {
        left: input(name),
        comparison: Comparison::Eq,
        value: Scalar::Boolean(true),
    }
}
fn with_condition(condition: Condition) -> Policy {
    Policy {
        inputs: [
            ("a".into(), ValueType::Boolean),
            ("b".into(), ValueType::Boolean),
            ("c".into(), ValueType::Boolean),
        ]
        .into(),
        rules: vec![Rule {
            id: "first".into(),
            condition,
            then: RuleAction::Allow,
            on_unknown: UnknownAction::Deny,
        }],
        ..Policy::default()
    }
}
fn run(policy: Policy, snapshot: &Snapshot) -> Evaluation {
    evaluate(
        &ValidatedPolicy::try_from(policy).unwrap(),
        snapshot,
        &BTreeMap::new(),
    )
    .unwrap()
}
fn snapshot(values: &[(&str, bool)]) -> Snapshot {
    Snapshot {
        inputs: values
            .iter()
            .map(|(key, value)| ((*key).into(), Scalar::Boolean(*value)))
            .collect(),
        ..Snapshot::default()
    }
}
fn observed(value: Observation) -> MetricObservation {
    MetricObservation {
        version: 1,
        state: value,
        provenance: Provenance {
            source: "test".into(),
            observed_at: 1234,
        },
    }
}

#[test]
fn three_valued_groups_have_complete_truth_tables() {
    let states = [Some(true), Some(false), None];
    for a in states {
        for b in states {
            let values: Vec<_> = [("a", a), ("b", b)]
                .into_iter()
                .filter_map(|(k, v)| v.map(|v| (k, v)))
                .collect();
            let evidence = snapshot(&values);
            let all = run(
                with_condition(Condition::All {
                    conditions: vec![is_true("a"), is_true("b")],
                }),
                &evidence,
            );
            let any = run(
                with_condition(Condition::Any {
                    conditions: vec![is_true("a"), is_true("b")],
                }),
                &evidence,
            );
            let expected_all = match (a, b) {
                (Some(false), _) | (_, Some(false)) => Truth::False,
                (Some(true), Some(true)) => Truth::True,
                _ => Truth::Unknown,
            };
            let expected_any = match (a, b) {
                (Some(true), _) | (_, Some(true)) => Truth::True,
                (Some(false), Some(false)) => Truth::False,
                _ => Truth::Unknown,
            };
            assert_eq!(
                all.trace[0].condition.result, expected_all,
                "all {a:?} {b:?}"
            );
            assert_eq!(
                any.trace[0].condition.result, expected_any,
                "any {a:?} {b:?}"
            );
            assert_eq!(
                all.trace[0].condition.children.len(),
                2,
                "full evidence trace even when result is determined"
            );
        }
    }
}

#[test]
fn not_unknown_remains_unknown_and_known_is_explicit() {
    let result = run(
        with_condition(Condition::Not {
            condition: Box::new(is_true("a")),
        }),
        &Snapshot::default(),
    );
    assert_eq!(result.outcome, Outcome::Deny);
    assert_eq!(result.reason, DecisionReason::UnknownDenied);
    assert_eq!(result.trace[0].condition.result, Truth::Unknown);
    let result = run(
        with_condition(Condition::Not {
            condition: Box::new(Condition::Known { value: input("a") }),
        }),
        &Snapshot::default(),
    );
    assert_eq!(result.outcome, Outcome::Allow);
}

#[test]
fn first_final_rule_wins_and_otherwise_defaults_to_deny() {
    assert_eq!(
        run(Policy::default(), &Snapshot::default()).outcome,
        Outcome::Deny
    );
    let mut policy = with_condition(is_true("a"));
    policy.rules.push(Rule {
        id: "second".into(),
        condition: is_true("b"),
        then: RuleAction::Deny,
        on_unknown: UnknownAction::Deny,
    });
    let result = run(policy, &snapshot(&[("a", true), ("b", true)]));
    assert_eq!(result.outcome, Outcome::Allow);
    assert_eq!(result.trace.len(), 1);
}

#[test]
fn unknown_next_is_an_explicit_policy_choice() {
    let mut policy = with_condition(is_true("a"));
    policy.rules[0].on_unknown = UnknownAction::Next;
    policy.otherwise = FinalAction::Allow;
    let result = run(policy, &Snapshot::default());
    assert_eq!(result.outcome, Outcome::Allow);
    assert_eq!(result.trace[0].condition.result, Truth::Unknown);
    assert_eq!(result.trace[0].route, Route::Next);
}

#[test]
fn verification_never_directly_authorizes_and_cannot_skip_next_challenge() {
    let mut policy = with_condition(is_true("a"));
    policy.rules[0].then = RuleAction::Challenge;
    policy.rules.push(Rule {
        id: "second".into(),
        condition: is_true("b"),
        then: RuleAction::Challenge,
        on_unknown: UnknownAction::Deny,
    });
    let policy = ValidatedPolicy::try_from(policy).unwrap();
    let evidence = snapshot(&[("a", true), ("b", true)]);
    let result = evaluate(&policy, &evidence, &BTreeMap::new()).unwrap();
    assert_eq!(result.outcome, Outcome::ChallengeRequired);
    assert_eq!(result.rule_id.as_deref(), Some("first"));
    let result = evaluate(
        &policy,
        &evidence,
        &[("first".into(), Verification::Passed)].into(),
    )
    .unwrap();
    assert_eq!(result.outcome, Outcome::ChallengeRequired);
    assert_eq!(result.rule_id.as_deref(), Some("second"));
    assert_eq!(result.trace[0].route, Route::VerificationPassed);
    let result = evaluate(
        &policy,
        &evidence,
        &[
            ("first".into(), Verification::Passed),
            ("second".into(), Verification::Passed),
        ]
        .into(),
    )
    .unwrap();
    assert_eq!(
        result.outcome,
        Outcome::Deny,
        "otherwise remains deny after both verifications"
    );
}

#[test]
fn unknown_can_require_verification_and_every_failure_denies_with_cause() {
    let mut policy = with_condition(is_true("a"));
    policy.rules[0].on_unknown = UnknownAction::Challenge;
    policy.otherwise = FinalAction::Allow;
    let policy = ValidatedPolicy::try_from(policy).unwrap();
    for (verification, reason) in [
        (Verification::Failed, DecisionReason::VerificationFailed),
        (Verification::Expired, DecisionReason::VerificationExpired),
        (
            Verification::Unavailable,
            DecisionReason::VerificationUnavailable,
        ),
    ] {
        let result = evaluate(
            &policy,
            &Snapshot::default(),
            &[("first".into(), verification)].into(),
        )
        .unwrap();
        assert_eq!(result.outcome, Outcome::Deny);
        assert_eq!(result.reason, reason);
    }
    let result = evaluate(
        &policy,
        &Snapshot::default(),
        &[("first".into(), Verification::Passed)].into(),
    )
    .unwrap();
    assert_eq!(result.outcome, Outcome::Allow);
    assert_eq!(result.trace[0].condition.result, Truth::Unknown);
}

#[test]
fn missing_and_corrupt_metric_evidence_never_becomes_safe() {
    let condition = Condition::Compare {
        left: metric_ref("ip.risk"),
        comparison: Comparison::Lt,
        value: Scalar::Number(0.8),
    };
    for state in [
        Observation::unknown(UnknownReason::Timeout),
        Observation::Known {
            value: Scalar::Number(f64::NAN),
        },
        Observation::Known {
            value: Scalar::Number(-0.1),
        },
        Observation::Known {
            value: Scalar::Number(1.1),
        },
        Observation::Known {
            value: Scalar::String("0".into()),
        },
    ] {
        let evidence = Snapshot {
            metrics: [("ip.risk".into(), observed(state))].into(),
            ..Snapshot::default()
        };
        let result = run(with_condition(condition.clone()), &evidence);
        assert_eq!(result.outcome, Outcome::Deny);
        assert_eq!(result.trace[0].condition.result, Truth::Unknown);
    }
    let mut evidence = Snapshot::default();
    evidence.metrics.insert(
        "ip.risk".into(),
        MetricObservation {
            version: 2,
            ..observed(Observation::Known {
                value: Scalar::Number(0.0),
            })
        },
    );
    assert_eq!(
        run(with_condition(condition), &evidence).reason,
        DecisionReason::UnknownDenied
    );
}

#[test]
fn malformed_country_and_fractional_counts_are_unknown() {
    for (name, value) in [
        ("ip.country", Scalar::String("us".into())),
        ("ip.country", Scalar::String("USA".into())),
        ("session.event_count_5m", Scalar::Number(1.5)),
        ("client.user_count_30d", Scalar::Number(-1.0)),
    ] {
        let evidence = Snapshot {
            metrics: [(name.into(), observed(Observation::Known { value }))].into(),
            ..Snapshot::default()
        };
        let result = run(
            with_condition(Condition::Known {
                value: metric_ref(name),
            }),
            &evidence,
        );
        assert_eq!(result.trace[0].condition.result, Truth::False);
        assert_eq!(
            result.trace[0].condition.observed,
            Some(Observation::unknown(UnknownReason::Invalid))
        );
    }
}

#[test]
fn rejects_adversarial_policy_shapes_and_limits() {
    let bad_conditions = [
        Condition::All { conditions: vec![] },
        Condition::Any { conditions: vec![] },
        Condition::Compare {
            left: input("undeclared"),
            comparison: Comparison::Eq,
            value: Scalar::Boolean(true),
        },
        Condition::Compare {
            left: input("a"),
            comparison: Comparison::Lt,
            value: Scalar::Boolean(true),
        },
        Condition::Compare {
            left: metric_ref("missing.metric"),
            comparison: Comparison::Eq,
            value: Scalar::Boolean(true),
        },
        Condition::Compare {
            left: Reference::Metric {
                name: "ip.risk".into(),
                version: 2,
            },
            comparison: Comparison::Eq,
            value: Scalar::Number(0.0),
        },
        Condition::Compare {
            left: metric_ref("ip.risk"),
            comparison: Comparison::Eq,
            value: Scalar::Number(f64::INFINITY),
        },
        Condition::Compare {
            left: metric_ref("ip.risk"),
            comparison: Comparison::Eq,
            value: Scalar::Number(MAX_SAFE_NUMBER + 1.0),
        },
        Condition::In {
            left: input("a"),
            values: vec![],
        },
        Condition::In {
            left: input("a"),
            values: vec![Scalar::Boolean(true); MAX_LIST_VALUES + 1],
        },
        Condition::In {
            left: input("a"),
            values: vec![Scalar::Boolean(true), Scalar::String("true".into())],
        },
        Condition::Between {
            left: metric_ref("ip.risk"),
            min: 1.0,
            max: 0.0,
        },
        Condition::Between {
            left: metric_ref("ip.risk"),
            min: f64::NAN,
            max: 1.0,
        },
    ];
    for condition in bad_conditions {
        assert!(ValidatedPolicy::try_from(with_condition(condition)).is_err());
    }
    let mut deep = is_true("a");
    for _ in 0..MAX_DEPTH {
        deep = Condition::Not {
            condition: Box::new(deep),
        };
    }
    assert!(ValidatedPolicy::try_from(with_condition(deep)).is_err());
    let large = Condition::All {
        conditions: vec![is_true("a"); MAX_NODES],
    };
    assert!(ValidatedPolicy::try_from(with_condition(large)).is_err());
    let mut duplicate = with_condition(is_true("a"));
    duplicate.rules.push(duplicate.rules[0].clone());
    assert!(ValidatedPolicy::try_from(duplicate).is_err());
    let mut too_many = with_condition(is_true("a"));
    too_many.rules = (0..=MAX_RULES)
        .map(|i| Rule {
            id: format!("rule_{i}"),
            ..too_many.rules[0].clone()
        })
        .collect();
    assert!(ValidatedPolicy::try_from(too_many).is_err());
}

#[test]
fn rejects_wrong_typed_unknown_and_oversized_trusted_inputs() {
    let policy = ValidatedPolicy::try_from(with_condition(is_true("a"))).unwrap();
    for inputs in [
        [("a".into(), Scalar::String("true".into()))].into(),
        [("unknown".into(), Scalar::Boolean(true))].into(),
    ] {
        assert!(
            evaluate(
                &policy,
                &Snapshot {
                    inputs,
                    ..Snapshot::default()
                },
                &BTreeMap::new()
            )
            .is_err()
        );
    }
    assert!(!Scalar::String("a".repeat(MAX_STRING_BYTES + 1)).is_valid());
    assert!(!Scalar::Number(f64::NEG_INFINITY).is_valid());
}

#[test]
fn numeric_comparisons_ranges_and_membership_are_exact() {
    let mut evidence = Snapshot::default();
    evidence.metrics.insert(
        "ip.risk".into(),
        observed(Observation::Known {
            value: Scalar::Number(0.8),
        }),
    );
    for (comparison, expected) in [
        (Comparison::Eq, true),
        (Comparison::Ne, false),
        (Comparison::Gt, false),
        (Comparison::Gte, true),
        (Comparison::Lt, false),
        (Comparison::Lte, true),
    ] {
        let result = run(
            with_condition(Condition::Compare {
                left: metric_ref("ip.risk"),
                comparison,
                value: Scalar::Number(0.8),
            }),
            &evidence,
        );
        assert_eq!(result.outcome == Outcome::Allow, expected);
    }
    assert_eq!(
        run(
            with_condition(Condition::Between {
                left: metric_ref("ip.risk"),
                min: 0.8,
                max: 1.0
            }),
            &evidence
        )
        .outcome,
        Outcome::Allow
    );
    assert_eq!(
        run(
            with_condition(Condition::In {
                left: metric_ref("ip.risk"),
                values: vec![Scalar::Number(0.1), Scalar::Number(0.8)]
            }),
            &evidence
        )
        .outcome,
        Outcome::Allow
    );
}

#[test]
fn derived_metrics_preserve_unknown_and_documented_thresholds() {
    let mut evidence = Snapshot::default();
    derive_metrics(&mut evidence, 5000);
    assert_eq!(
        evidence.metrics["ip.high_risk"].state,
        Observation::unknown(UnknownReason::Missing)
    );
    evidence.metrics.insert(
        "ip.risk".into(),
        observed(Observation::unknown(UnknownReason::Timeout)),
    );
    derive_metrics(&mut evidence, 5000);
    assert_eq!(
        evidence.metrics["ip.high_risk"].state,
        Observation::unknown(UnknownReason::Timeout)
    );
    for (count, multi) in [(2.0, false), (3.0, true)] {
        evidence.metrics.insert(
            "client.user_count_30d".into(),
            observed(Observation::Known {
                value: Scalar::Number(count),
            }),
        );
        evidence.metrics.insert(
            "ip.risk".into(),
            observed(Observation::Known {
                value: Scalar::Number(0.8),
            }),
        );
        derive_metrics(&mut evidence, 5000);
        assert_eq!(
            evidence.metrics["client.multi_account"].state,
            Observation::Known {
                value: Scalar::Boolean(multi)
            }
        );
        assert_eq!(
            evidence.metrics["ip.high_risk"].state,
            Observation::Known {
                value: Scalar::Boolean(true)
            }
        );
    }
}

#[test]
fn wire_defaults_are_safe_and_unknown_fields_are_rejected() {
    let policy: Policy = serde_json::from_str(r#"{"schema_version":1}"#).unwrap();
    assert_eq!(policy, Policy::default());
    let policy = with_condition(is_true("a"));
    let serialized = serde_json::to_string(&policy).unwrap();
    assert_eq!(serde_json::from_str::<Policy>(&serialized).unwrap(), policy);
    assert!(
        serde_json::from_str::<Policy>(
            r#"{"schema_version":1,"otherwise":"ALLOW","ignore_security":true}"#
        )
        .is_err()
    );
    assert!(
        serde_json::from_str::<Condition>(
            r#"{"op":"known","value":{"source":"input","name":"a"},"ignored":true}"#
        )
        .is_err()
    );
    assert!(serde_json::from_str::<Condition>(r#"{"op":"compare","left":{"source":"input","name":"a"},"comparison":"eq","value":null}"#).is_err());
}

#[test]
fn trace_roundtrip_retains_unknown_cause_and_observed_input() {
    let result = run(
        with_condition(Condition::All {
            conditions: vec![is_true("a"), is_true("b")],
        }),
        &snapshot(&[("a", true)]),
    );
    let encoded = serde_json::to_string(&result).unwrap();
    let decoded: Evaluation = serde_json::from_str(&encoded).unwrap();
    assert_eq!(decoded, result);
    assert_eq!(
        decoded.trace[0].condition.children[1].observed,
        Some(Observation::unknown(UnknownReason::Missing))
    );
    assert_eq!(
        decoded.trace[0].condition.children[0].observed,
        Some(Observation::Known {
            value: Scalar::Boolean(true)
        })
    );
}
