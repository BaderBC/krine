export type Scalar = string | number | boolean;
export type ValueType = "string" | "number" | "boolean";
export type Reference =
  | { source: "metric"; name: string; version: number }
  | { source: "input"; name: string };
export type Comparison = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
export type Condition =
  | { op: "compare"; left: Reference; comparison: Comparison; value: Scalar }
  | { op: "in"; left: Reference; values: Scalar[] }
  | { op: "between"; left: Reference; min: number; max: number }
  | { op: "known"; value: Reference }
  | { op: "all"; conditions: Condition[] }
  | { op: "any"; conditions: Condition[] }
  | { op: "not"; condition: Condition };
export interface Rule {
  id: string;
  condition: Condition;
  then: "ALLOW" | "DENY" | "CHALLENGE";
  on_unknown: "DENY" | "NEXT" | "CHALLENGE";
}
export interface Policy {
  schema_version: 1;
  inputs: Record<string, ValueType>;
  rules: Rule[];
  otherwise: "ALLOW" | "DENY";
}
export interface Check {
  name: string;
  description: string;
  active_version: number | null;
  draft_revision: number;
  has_draft_changes: boolean;
  draft: Policy;
  updated_at: number;
  restored_from_version?: number | null;
}
export interface CheckSummary extends Omit<Check, "draft"> {
  recent: {
    allow: number;
    deny: number;
    challenge: number;
    errors: number;
    p95_ms: number | null;
  } | null;
}
export interface Version {
  version: number;
  published_at: number;
  policy: Policy;
  restored_from_version?: number | null;
}
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export interface Metric {
  name: string;
  version: number;
  kind: "primitive" | "derived";
  value_type: ValueType;
  range: [number, number] | null;
  description: string;
  dependencies: string[];
  source: string;
  missing: string;
  examples: string[];
}
export type Observation =
  | { status: "known"; value: Scalar }
  | { status: "unknown"; reason: string };
export interface MetricObservation {
  version: number;
  state: Observation;
  provenance: { source: string; observed_at: number };
}
export interface Snapshot {
  metrics: Record<string, MetricObservation>;
  inputs: Record<string, Scalar>;
}
export interface ConditionTrace {
  result: "true" | "false" | "unknown";
  reference?: Reference;
  observed?: Observation;
  children?: ConditionTrace[];
}
export interface RuleTrace {
  rule_id: string;
  condition: ConditionTrace;
  route: string;
}
export interface Decision {
  decision_id: string;
  operation_id: string;
  check: string;
  policy_version: number | null;
  outcome: string | null;
  reason: string;
  accepted_at: number;
  completed_at: number | null;
  client_id: string | null;
  session_id: string | null;
  user_id: string | null;
  ip: string | null;
  source: "evaluation" | "request_error" | "fallback";
}
export interface DecisionDetail extends Decision {
  policy?: Policy;
  snapshot?: Snapshot;
  evaluation?: {
    outcome: string;
    reason: string;
    rule_id: string | null;
    trace: RuleTrace[];
  };
  relationship_ids?: string[];
  relationship_context?: {
    items: RelationshipSummary[];
    total: number;
    truncated: boolean;
    observed_at: number;
    observed_ip: RelationshipSummary | null;
  };
  provider_revisions?: Record<string, { revision: number; enabled: boolean }>;
  provider_observations?: Record<
    string,
    { revision: number; status: string; detail: string; observed_at: number }
  >;
  verification_transitions?: {
    sequence: number;
    at: number;
    challenge_id: string | null;
    state: string;
    detail: string;
  }[];
  requests?: { at: number; kind: string; result: string }[];
}
export interface Event {
  event_id: string;
  name: string;
  occurred_at?: number | null;
  accepted_at: number;
  provenance: "backend" | "browser";
  client_id?: string | null;
  session_id?: string | null;
  user_id?: string | null;
  ip?: string | null;
  properties?: Record<string, unknown>;
}
export interface Association {
  association_id: string;
  client_id: string;
  user_id: string;
  created_at: number;
  revoked_at: number | null;
  provenance: string;
  metadata: Record<string, unknown>;
  revocation_reason?: string;
  revoked_by?: string;
}
export interface Entity {
  kind: string;
  id: string;
  first_seen: number;
  metadata: Record<string, unknown>;
  metrics: Record<string, MetricObservation>;
  associations: Association[];
  associations_next_cursor: string | null;
  recent_decisions: Decision[];
  recent_events: Event[];
}
export interface Setup {
  public_key: string | null;
  browser_credential_id: string | null;
  active_credentials: { browser: number; server: number };
  browser_url: string;
  server_url: string;
  allowed_origins: string[];
  sdk: { browser_package: string; server_package: string };
}
export interface Provider {
  capability: "ip_intelligence" | "verification";
  provider: "proxycheck" | "turnstile";
  enabled: boolean;
  revision: number;
  config: Record<string, unknown>;
  has_secret: boolean;
  status: string;
  message: string;
  checked_at: number | null;
  dependent_checks: string[];
  dependent_versions: { check: string; version: number }[];
  dependents_token: string;
}

export interface Credential {
  id: string;
  kind: "browser" | "server";
  label: string;
  source: "bootstrap" | "administrator";
  public_key: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: "administrator" | null;
}
export interface CredentialCreation {
  credential: Credential;
  secret: string | null;
  secret_status: "revealed" | "unrecoverable" | "not_applicable";
}

export interface RelationshipSummary {
  id: string;
  kind: "backend" | "observed_ip";
  client_id: string;
  session_id: string | null;
  user_id: string | null;
  ip: string | null;
  first_seen: number;
  last_seen: number;
  source: "backend" | "browser_observation";
  credential_id: string | null;
  last_credential_id: string | null;
  first_source: "backend" | "browser.context" | "browser.proof" | "legacy";
  last_source: "backend" | "browser.context" | "browser.proof" | "legacy";
  first_event_id: string | null;
  last_event_id: string | null;
  revision: number;
  revoked_at: number | null;
  revocation_reason: string | null;
  revoked_by: string | null;
}
export interface Relationship extends RelationshipSummary {
  metadata: Record<string, unknown>;
}
export interface RelationshipAudit {
  id: string;
  at: number;
  action: string;
  reason: string;
  actor: string | null;
  revision: number | null;
  relationship: Relationship | null;
}
export interface RelationshipDetail {
  relationship: Relationship;
  audit: Page<RelationshipAudit>;
  recalculation: "complete";
}
