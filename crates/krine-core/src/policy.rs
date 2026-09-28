use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

use serde::{Deserialize, Serialize};

use crate::{Observation, Snapshot, UnknownReason, metric, validated_observation};

pub const MAX_RULES: usize = 32;
pub const MAX_NODES: usize = 256;
pub const MAX_DEPTH: usize = 8;
pub const MAX_INPUTS: usize = 32;
pub const MAX_LIST_VALUES: usize = 32;
pub const MAX_STRING_BYTES: usize = 1024;
pub const MAX_SAFE_NUMBER: f64 = 9_007_199_254_740_991.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValueType {
    Number,
    Boolean,
    String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Scalar {
    Boolean(bool),
    Number(f64),
    String(String),
}

impl Scalar {
    pub fn value_type(&self) -> ValueType {
        match self {
            Self::Boolean(_) => ValueType::Boolean,
            Self::Number(_) => ValueType::Number,
            Self::String(_) => ValueType::String,
        }
    }

    pub fn is_valid(&self) -> bool {
        match self {
            Self::Number(n) => n.is_finite() && n.abs() <= MAX_SAFE_NUMBER,
            Self::String(s) => s.len() <= MAX_STRING_BYTES,
            Self::Boolean(_) => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reference {
    Metric { name: String, version: u32 },
    Input { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Comparison {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Condition {
    Compare {
        left: Reference,
        comparison: Comparison,
        value: Scalar,
    },
    In {
        left: Reference,
        values: Vec<Scalar>,
    },
    Between {
        left: Reference,
        min: f64,
        max: f64,
    },
    Known {
        value: Reference,
    },
    All {
        conditions: Vec<Condition>,
    },
    Any {
        conditions: Vec<Condition>,
    },
    Not {
        condition: Box<Condition>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FinalAction {
    Allow,
    #[default]
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RuleAction {
    Allow,
    Deny,
    Challenge,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UnknownAction {
    #[default]
    Deny,
    Next,
    Challenge,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub condition: Condition,
    pub then: RuleAction,
    #[serde(default)]
    pub on_unknown: UnknownAction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub schema_version: u32,
    #[serde(default)]
    pub inputs: BTreeMap<String, ValueType>,
    #[serde(default)]
    pub rules: Vec<Rule>,
    #[serde(default)]
    pub otherwise: FinalAction,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            schema_version: 1,
            inputs: BTreeMap::new(),
            rules: Vec::new(),
            otherwise: FinalAction::Deny,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ValidationError {
    pub path: String,
    pub message: String,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.path, self.message)
    }
}

impl std::error::Error for ValidationError {}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> ValidationError {
    ValidationError {
        path: path.into(),
        message: message.into(),
    }
}

pub fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-.:".contains(&b))
}

/// Validated policies cannot be mutated without repeating boundary validation.
#[derive(Debug, Clone)]
pub struct ValidatedPolicy(Policy);

impl ValidatedPolicy {
    pub fn policy(&self) -> &Policy {
        &self.0
    }

    /// Validate trusted input names and types before recording an operation.
    /// Omitted declared inputs are permitted and evaluate as unknown.
    pub fn validate_inputs(
        &self,
        inputs: &BTreeMap<String, Scalar>,
    ) -> Result<(), ValidationError> {
        if inputs.len() > MAX_INPUTS {
            return Err(invalid("inputs", "at most 32 inputs are supported"));
        }
        for (name, value) in inputs {
            let Some(expected) = self.0.inputs.get(name) else {
                return Err(invalid(
                    format!("inputs.{name}"),
                    "input is not declared by this policy",
                ));
            };
            if !value.is_valid() || value.value_type() != *expected {
                return Err(invalid(
                    format!("inputs.{name}"),
                    "input has the wrong type or exceeds its value limit",
                ));
            }
        }
        Ok(())
    }
}

impl TryFrom<Policy> for ValidatedPolicy {
    type Error = ValidationError;

    fn try_from(policy: Policy) -> Result<Self, Self::Error> {
        if policy.schema_version != 1 {
            return Err(invalid(
                "schema_version",
                "only policy schema 1 is supported",
            ));
        }
        if policy.rules.len() > MAX_RULES {
            return Err(invalid("rules", "at most 32 rules are supported"));
        }
        if policy.inputs.len() > MAX_INPUTS
            || policy.inputs.keys().any(|name| !valid_identifier(name))
        {
            return Err(invalid(
                "inputs",
                "declare at most 32 inputs with valid identifiers",
            ));
        }
        let mut ids = BTreeSet::new();
        let mut nodes = 0;
        for (index, rule) in policy.rules.iter().enumerate() {
            if !valid_identifier(&rule.id) || !ids.insert(&rule.id) {
                return Err(invalid(
                    format!("rules.{index}.id"),
                    "rule IDs must be valid and unique",
                ));
            }
            let mut pending = vec![(&rule.condition, 1, format!("rules.{index}.condition"))];
            while let Some((condition, depth, path)) = pending.pop() {
                nodes += 1;
                if depth > MAX_DEPTH || nodes > MAX_NODES {
                    return Err(invalid(
                        path,
                        "condition exceeds the depth 8 or total 256 node limit",
                    ));
                }
                match condition {
                    Condition::Compare {
                        left,
                        comparison,
                        value,
                    } => {
                        let expected = reference_type(left, &policy.inputs, &path)?;
                        validate_scalar(value, expected, &path)?;
                        if !matches!(comparison, Comparison::Eq | Comparison::Ne)
                            && expected != ValueType::Number
                        {
                            return Err(invalid(path, "ordered comparisons require numbers"));
                        }
                    }
                    Condition::In { left, values } => {
                        let expected = reference_type(left, &policy.inputs, &path)?;
                        if values.is_empty() || values.len() > MAX_LIST_VALUES {
                            return Err(invalid(path, "membership requires 1 to 32 values"));
                        }
                        for value in values {
                            validate_scalar(value, expected, &path)?;
                        }
                    }
                    Condition::Between { left, min, max } => {
                        if reference_type(left, &policy.inputs, &path)? != ValueType::Number
                            || !Scalar::Number(*min).is_valid()
                            || !Scalar::Number(*max).is_valid()
                            || min > max
                        {
                            return Err(invalid(
                                path,
                                "range requires finite ordered numeric bounds and a numeric reference",
                            ));
                        }
                    }
                    Condition::Known { value } => {
                        reference_type(value, &policy.inputs, &path)?;
                    }
                    Condition::All { conditions } | Condition::Any { conditions } => {
                        if conditions.is_empty() || conditions.len() > MAX_NODES {
                            return Err(invalid(
                                path,
                                "boolean groups must contain 1 to 256 conditions",
                            ));
                        }
                        for (index, child) in conditions.iter().enumerate().rev() {
                            pending.push((child, depth + 1, format!("{path}.conditions.{index}")));
                        }
                    }
                    Condition::Not { condition } => {
                        pending.push((condition, depth + 1, format!("{path}.condition")))
                    }
                }
            }
        }
        Ok(Self(policy))
    }
}

fn reference_type(
    reference: &Reference,
    inputs: &BTreeMap<String, ValueType>,
    path: &str,
) -> Result<ValueType, ValidationError> {
    match reference {
        Reference::Metric { name, version } => metric(name, *version)
            .map(|entry| entry.value_type)
            .ok_or_else(|| invalid(path, "unknown metric name or unsupported metric version")),
        Reference::Input { name } => inputs
            .get(name)
            .copied()
            .ok_or_else(|| invalid(path, "trusted input must be declared")),
    }
}

fn validate_scalar(value: &Scalar, expected: ValueType, path: &str) -> Result<(), ValidationError> {
    if value.is_valid() && value.value_type() == expected {
        Ok(())
    } else {
        Err(invalid(
            path,
            "comparison value has the wrong type or exceeds its value limit",
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Truth {
    True,
    False,
    Unknown,
}

impl Truth {
    fn from_bool(value: bool) -> Self {
        if value { Self::True } else { Self::False }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Outcome {
    Allow,
    Deny,
    ChallengeRequired,
}

/// Supplied only by the application's authenticated verification state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    Passed,
    Failed,
    Expired,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionReason {
    RuleMatched,
    UnknownDenied,
    Otherwise,
    VerificationRequired,
    VerificationFailed,
    VerificationExpired,
    VerificationUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Route {
    Next,
    Allow,
    Deny,
    Challenge,
    VerificationPassed,
    VerificationFailed,
    VerificationExpired,
    VerificationUnavailable,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionTrace {
    pub result: Truth,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reference: Option<Reference>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub observed: Option<Observation>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub children: Vec<ConditionTrace>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuleTrace {
    pub rule_id: String,
    pub condition: ConditionTrace,
    pub route: Route,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evaluation {
    pub outcome: Outcome,
    pub reason: DecisionReason,
    pub rule_id: Option<String>,
    pub trace: Vec<RuleTrace>,
}

/// Evaluate a pinned policy and snapshot. Caller-owned verification results must
/// be bound to this exact operation, rule and provider revision before entry.
/// Invalid trusted inputs are errors; corrupt metric evidence becomes unknown.
pub fn evaluate(
    policy: &ValidatedPolicy,
    snapshot: &Snapshot,
    verified: &BTreeMap<String, Verification>,
) -> Result<Evaluation, ValidationError> {
    policy.validate_inputs(&snapshot.inputs)?;
    if verified.len() > MAX_RULES
        || verified
            .keys()
            .any(|id| !policy.0.rules.iter().any(|rule| &rule.id == id))
    {
        return Err(invalid(
            "verification",
            "verification refers to an unknown rule",
        ));
    }
    let mut trace = Vec::new();
    for rule in &policy.0.rules {
        let condition = evaluate_condition(&rule.condition, snapshot);
        let (action, reason) = match condition.result {
            Truth::False => (None, DecisionReason::RuleMatched),
            Truth::True => (Some(rule.then), DecisionReason::RuleMatched),
            Truth::Unknown => (
                match rule.on_unknown {
                    UnknownAction::Deny => Some(RuleAction::Deny),
                    UnknownAction::Next => None,
                    UnknownAction::Challenge => Some(RuleAction::Challenge),
                },
                DecisionReason::UnknownDenied,
            ),
        };
        let (outcome, reason, route) = match action {
            None => (None, reason, Route::Next),
            Some(RuleAction::Allow) => (Some(Outcome::Allow), reason, Route::Allow),
            Some(RuleAction::Deny) => (Some(Outcome::Deny), reason, Route::Deny),
            Some(RuleAction::Challenge) => match verified.get(&rule.id) {
                None => (
                    Some(Outcome::ChallengeRequired),
                    DecisionReason::VerificationRequired,
                    Route::Challenge,
                ),
                Some(Verification::Passed) => {
                    (None, DecisionReason::RuleMatched, Route::VerificationPassed)
                }
                Some(Verification::Failed) => (
                    Some(Outcome::Deny),
                    DecisionReason::VerificationFailed,
                    Route::VerificationFailed,
                ),
                Some(Verification::Expired) => (
                    Some(Outcome::Deny),
                    DecisionReason::VerificationExpired,
                    Route::VerificationExpired,
                ),
                Some(Verification::Unavailable) => (
                    Some(Outcome::Deny),
                    DecisionReason::VerificationUnavailable,
                    Route::VerificationUnavailable,
                ),
            },
        };
        trace.push(RuleTrace {
            rule_id: rule.id.clone(),
            condition,
            route,
        });
        if let Some(outcome) = outcome {
            return Ok(Evaluation {
                outcome,
                reason,
                rule_id: Some(rule.id.clone()),
                trace,
            });
        }
    }
    Ok(Evaluation {
        outcome: match policy.0.otherwise {
            FinalAction::Allow => Outcome::Allow,
            FinalAction::Deny => Outcome::Deny,
        },
        reason: DecisionReason::Otherwise,
        rule_id: None,
        trace,
    })
}

fn observe(reference: &Reference, snapshot: &Snapshot) -> Observation {
    match reference {
        Reference::Metric { name, version } => validated_observation(snapshot, name, *version),
        Reference::Input { name } => snapshot
            .inputs
            .get(name)
            .map(|value| Observation::Known {
                value: value.clone(),
            })
            .unwrap_or_else(|| Observation::unknown(UnknownReason::Missing)),
    }
}

fn evaluate_condition(condition: &Condition, snapshot: &Snapshot) -> ConditionTrace {
    let (reference, children) = match condition {
        Condition::Compare { left, .. }
        | Condition::In { left, .. }
        | Condition::Between { left, .. } => (Some(left), Vec::new()),
        Condition::Known { value } => (Some(value), Vec::new()),
        Condition::All { conditions } | Condition::Any { conditions } => (
            None,
            conditions
                .iter()
                .map(|c| evaluate_condition(c, snapshot))
                .collect(),
        ),
        Condition::Not { condition } => (None, vec![evaluate_condition(condition, snapshot)]),
    };
    let observed = reference.map(|reference| observe(reference, snapshot));
    let result = match condition {
        Condition::All { .. } => {
            if children.iter().any(|child| child.result == Truth::False) {
                Truth::False
            } else if children.iter().any(|child| child.result == Truth::Unknown) {
                Truth::Unknown
            } else {
                Truth::True
            }
        }
        Condition::Any { .. } => {
            if children.iter().any(|child| child.result == Truth::True) {
                Truth::True
            } else if children.iter().any(|child| child.result == Truth::Unknown) {
                Truth::Unknown
            } else {
                Truth::False
            }
        }
        Condition::Not { .. } => match children[0].result {
            Truth::True => Truth::False,
            Truth::False => Truth::True,
            Truth::Unknown => Truth::Unknown,
        },
        Condition::Known { .. } => {
            Truth::from_bool(matches!(observed, Some(Observation::Known { .. })))
        }
        _ => match &observed {
            Some(Observation::Known { value: actual }) => Truth::from_bool(match condition {
                Condition::Compare {
                    comparison, value, ..
                } => compare(actual, *comparison, value),
                Condition::In { values, .. } => values.contains(actual),
                Condition::Between { min, max, .. } => {
                    matches!(actual, Scalar::Number(n) if n >= min && n <= max)
                }
                _ => false,
            }),
            _ => Truth::Unknown,
        },
    };
    ConditionTrace {
        result,
        reference: reference.cloned(),
        observed,
        children,
    }
}

fn compare(left: &Scalar, comparison: Comparison, right: &Scalar) -> bool {
    match comparison {
        Comparison::Eq => left == right,
        Comparison::Ne => left != right,
        _ => match (left, right) {
            (Scalar::Number(left), Scalar::Number(right)) => match comparison {
                Comparison::Gt => left > right,
                Comparison::Gte => left >= right,
                Comparison::Lt => left < right,
                Comparison::Lte => left <= right,
                _ => false,
            },
            _ => false,
        },
    }
}
