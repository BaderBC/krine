use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{Scalar, ValueType};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MetricKind {
    Primitive,
    Derived,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricDefinition {
    pub name: &'static str,
    pub version: u32,
    pub kind: MetricKind,
    pub value_type: ValueType,
    pub range: Option<(f64, f64)>,
    pub description: &'static str,
    pub dependencies: &'static [&'static str],
    pub source: &'static str,
    pub missing: &'static str,
    pub examples: &'static [&'static str],
}

pub static METRICS: &[MetricDefinition] = &[
    MetricDefinition {
        name: "client.age_seconds",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 9_007_199_254_740_991.0)),
        description: "Seconds since Krine first observed this client; a browser can reset client context.",
        dependencies: &[],
        source: "krine_context",
        missing: "Unknown when the client or its first-seen record is unavailable.",
        examples: &["A new client has age 0; age is evidence, not identity."],
    },
    MetricDefinition {
        name: "session.age_seconds",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 86_400.0)),
        description: "Seconds since Krine issued the session; bounded by its 24-hour lifetime.",
        dependencies: &[],
        source: "krine_context",
        missing: "Unknown when session context is unavailable.",
        examples: &["Require verification for a session younger than 10 seconds."],
    },
    MetricDefinition {
        name: "client.user_count_30d",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 9_007_199_254_740_991.0)),
        description: "Distinct users with active backend associations created in the previous 30 days, including the boundary. Revoked edges do not count; restoration retains original association time.",
        dependencies: &[],
        source: "backend_associations",
        missing: "Unknown if relationship state is unavailable; known zero only after a complete read.",
        examples: &["Three active users associated in the window yields 3."],
    },
    MetricDefinition {
        name: "session.event_count_5m",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 9_007_199_254_740_991.0)),
        description: "Distinct authoritative events accepted for this session in the previous 300 seconds, including the boundary. Uses first acceptance time, not customer occurrence time.",
        dependencies: &[],
        source: "backend_events",
        missing: "Unknown while the hot projection is unavailable or rebuilding; known zero only for a ready empty window.",
        examples: &["Retrying one event ID never increases the count twice."],
    },
    MetricDefinition {
        name: "ip.event_count_5m",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 9_007_199_254_740_991.0)),
        description: "Distinct authoritative events accepted for the normalized IP in the previous 300 seconds, including the boundary. Shared IPs do not imply shared identity.",
        dependencies: &[],
        source: "backend_events",
        missing: "Unknown while the hot projection is unavailable or rebuilding; known zero only for a ready empty window.",
        examples: &["An acknowledged event appears in later checks within its window."],
    },
    MetricDefinition {
        name: "browser.automation_observed",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Boolean,
        range: None,
        description: "Browser-reported navigator.webdriver. Spoofable evidence: false does not establish a human and true can describe legitimate automation.",
        dependencies: &[],
        source: "untrusted_browser",
        missing: "Unknown when no valid webdriver observation was provided by this session.",
        examples: &[
            "Route observed automation to verification instead of claiming a bot identity.",
        ],
    },
    MetricDefinition {
        name: "ip.country",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::String,
        range: None,
        description: "Two-letter uppercase ISO country code from the configured IP intelligence capability; it describes an IP estimate, not user nationality.",
        dependencies: &[],
        source: "ip_intelligence",
        missing: "Unknown for absent, invalid, expired or unavailable provider data.",
        examples: &["Compare with a list of countries relevant to the application's policy."],
    },
    MetricDefinition {
        name: "ip.risk",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Number,
        range: Some((0.0, 1.0)),
        description: "Provider-normalized risk in [0,1]. Higher means more provider-reported IP risk; this is not a probability that a person is fraudulent.",
        dependencies: &[],
        source: "ip_intelligence",
        missing: "Unknown when the provider does not supply a supported risk score or its result is invalid, stale or unavailable.",
        examples: &["A provider score of 75/100 normalizes to 0.75."],
    },
    MetricDefinition {
        name: "ip.is_proxy",
        version: 1,
        kind: MetricKind::Primitive,
        value_type: ValueType::Boolean,
        range: None,
        description: "Whether the configured intelligence capability reports proxy use. Proxy use is evidence, not proof of abuse.",
        dependencies: &[],
        source: "ip_intelligence",
        missing: "Unknown if the provider cannot determine proxy use or evidence is invalid, stale or unavailable.",
        examples: &["A known proxy may require additional verification."],
    },
    MetricDefinition {
        name: "client.multi_account",
        version: 1,
        kind: MetricKind::Derived,
        value_type: ValueType::Boolean,
        range: None,
        description: "True iff client.user_count_30d@1 is greater than 2. Shared clients can be legitimate; this is a transparent threshold, not a fraud score.",
        dependencies: &["client.user_count_30d@1"],
        source: "krine_derived",
        missing: "Preserves unknown dependency state; never treats absent relationships as zero.",
        examples: &["2 users → false; 3 users → true."],
    },
    MetricDefinition {
        name: "ip.high_risk",
        version: 1,
        kind: MetricKind::Derived,
        value_type: ValueType::Boolean,
        range: None,
        description: "True iff ip.risk@1 is at least 0.8. A provider score threshold, not an independent fraud probability.",
        dependencies: &["ip.risk@1"],
        source: "krine_derived",
        missing: "Preserves unknown dependency state.",
        examples: &["0.79 → false; 0.8 → true."],
    },
];

pub fn metric(name: &str, version: u32) -> Option<&'static MetricDefinition> {
    METRICS
        .iter()
        .find(|entry| entry.name == name && entry.version == version)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnknownReason {
    Missing,
    Unavailable,
    Timeout,
    Stale,
    Invalid,
    TypeMismatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Observation {
    Known { value: Scalar },
    Unknown { reason: UnknownReason },
}

impl Observation {
    pub fn unknown(reason: UnknownReason) -> Self {
        Self::Unknown { reason }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub source: String,
    pub observed_at: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetricObservation {
    pub version: u32,
    pub state: Observation,
    pub provenance: Provenance,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub metrics: BTreeMap<String, MetricObservation>,
    pub inputs: BTreeMap<String, Scalar>,
}

/// Calculate shipped derived metrics from their pinned primitive versions.
/// Invalid dependencies remain unknown, including type and range failures.
pub fn derive_metrics(snapshot: &mut Snapshot, observed_at: u64) {
    for (name, dependency, threshold, inclusive) in [
        ("client.multi_account", "client.user_count_30d", 2.0, false),
        ("ip.high_risk", "ip.risk", 0.8, true),
    ] {
        let state = match validated_observation(snapshot, dependency, 1) {
            Observation::Known {
                value: Scalar::Number(value),
            } => Observation::Known {
                value: Scalar::Boolean(if inclusive {
                    value >= threshold
                } else {
                    value > threshold
                }),
            },
            other => other,
        };
        snapshot.metrics.insert(
            name.into(),
            MetricObservation {
                version: 1,
                state,
                provenance: Provenance {
                    source: "krine_derived".into(),
                    observed_at,
                },
            },
        );
    }
}

pub(crate) fn validated_observation(snapshot: &Snapshot, name: &str, version: u32) -> Observation {
    let Some(definition) = metric(name, version) else {
        return Observation::unknown(UnknownReason::Invalid);
    };
    let Some(observation) = snapshot.metrics.get(name) else {
        return Observation::unknown(UnknownReason::Missing);
    };
    if observation.version != version {
        return Observation::unknown(UnknownReason::Invalid);
    }
    if let Observation::Known { value } = &observation.state {
        if value.value_type() != definition.value_type {
            return Observation::unknown(UnknownReason::TypeMismatch);
        }
        let invalid_shape = match (name, value) {
            ("ip.country", Scalar::String(country)) => {
                country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_uppercase())
            }
            (
                "client.age_seconds"
                | "session.age_seconds"
                | "client.user_count_30d"
                | "session.event_count_5m"
                | "ip.event_count_5m",
                Scalar::Number(number),
            ) => number.fract() != 0.0,
            _ => false,
        };
        if invalid_shape
            || !value.is_valid()
            || matches!((value, definition.range), (Scalar::Number(n), Some((min,max))) if *n < min || *n > max)
        {
            return Observation::unknown(UnknownReason::Invalid);
        }
    }
    observation.state.clone()
}
