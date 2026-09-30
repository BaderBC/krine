import type { Decision } from "./types";
import type {
  SubjectTimeline,
  SubjectContext,
  TimelineEntry,
} from "./subject-profile";
import type { ActivityAnalytics } from "./activity-analytics";
export const subject = "user / 雪\\x41 ";
export const decision: Decision = {
  decision_id: "decision_one",
  operation_id: "operation_one",
  check: "can_claim_trial",
  policy_version: 3,
  outcome: "DENY",
  reason: "unknown_denied",
  accepted_at: 900,
  completed_at: 901,
  client_id: "client_one",
  session_id: "session_one",
  user_id: subject,
  ip: "192.0.2.1",
  source: "evaluation",
  reason_summary: {
    schema_version: 1,
    reason: "unknown_denied",
    outcome: "DENY",
    scope: "decisive_rule",
    rule_id: "risk",
    rules: [
      {
        rule_id: "risk",
        position: 1,
        result: "unknown",
        route: "deny",
        compound: false,
        evidence_truncated: false,
        evidence: [
          {
            reference: { source: "metric", name: "ip.risk", version: 1 },
            observed: { status: "unknown", reason: "timeout" },
            test: { op: "compare", comparison: "gt", value: 0.8 },
            path: [],
            result: "unknown",
            observed_truncated: false,
            test_truncated: false,
            provenance: { source: "provider", observed_at: 899 },
          },
        ],
      },
    ],
    rules_truncated: false,
    truncated: false,
    provider_revisions: {},
  },
};
export function entries(): TimelineEntry[] {
  return [
    {
      kind: "event",
      id: "event_late",
      accepted_at: 950,
      summary: {
        event_id: "event_late",
        name: "trial.requested",
        accepted_at: 950,
        occurred_at: 120,
        client_id: "client_one",
        session_id: "session_one",
        user_id: subject,
        ip: "192.0.2.1",
        provenance: "backend",
        sample_data: { dataset_id: "synthetic-demo", generator_version: "1" },
      },
    },
    {
      kind: "decision",
      id: decision.decision_id,
      accepted_at: decision.accepted_at,
      summary: structuredClone(decision),
    },
    {
      kind: "event",
      id: "event_old",
      accepted_at: 800,
      summary: {
        event_id: "event_old",
        name: "browser.context",
        accepted_at: 800,
        occurred_at: null,
        client_id: "client_one",
        session_id: "session_one",
        user_id: subject,
        ip: "192.0.2.1",
        provenance: null,
      },
    },
  ];
}
export function timeline(
  overrides: Partial<SubjectTimeline> = {},
): SubjectTimeline {
  return {
    schema_version: 1,
    scope: { kind: "user", id: subject },
    range: {
      from: 100,
      to: 1000,
      time_basis: "accepted_at",
      effective_from: 100,
      effective_to: 1000,
    },
    as_of: 1100,
    retention: {
      days: 30,
      requested_days: 30,
      available_since: 0,
      applying: false,
    },
    visibility: "asynchronous",
    delivery: {
      scope: "installation",
      observed_at: 1100,
      pending_records: 3,
      oldest_record_accepted_at: 80,
    },
    items: entries(),
    next_cursor: "older",
    ...overrides,
  };
}
export function context(
  overrides: Partial<SubjectContext> = {},
): SubjectContext {
  return {
    kind: "user",
    id: subject,
    first_seen: 1,
    observed_at: 1100,
    metadata: { plan: "Team", email: "user@example.test" },
    metrics: {},
    associations: [],
    associations_next_cursor: null,
    ...overrides,
  };
}
export function analytics(q: URLSearchParams): ActivityAnalytics {
  const from = Number(q.get("from")),
    to = Number(q.get("to")),
    kind = q.get("kind") === "event" ? "event" : "decision";
  const counts =
    kind === "event"
      ? { total: 0, backend: 0, browser: 0, unknown: 0 }
      : { total: 0, allow: 0, deny: 0, awaiting_verification: 0, unknown: 0 };
  const bucketMs = to - from >= 400 * 300000 ? 86_400_000 : 300000;
  const buckets = [];
  for (let start = from; start <= to; ) {
    const end = Math.min(
      to,
      Math.floor(start / bucketMs) * bucketMs + bucketMs - 1,
    );
    buckets.push({ from: start, to: end, counts: { ...counts } });
    start = end + 1;
  }
  return {
    ...timeline(),
    scope: {
      kind,
      ...Object.fromEntries(
        [
          "check",
          "operation_id",
          "outcome",
          "entity",
          "entity_kind",
          "name",
          "reason",
          "provenance",
        ].map((key) => [key, q.get(key)]),
      ),
    },
    range: {
      from,
      to,
      effective_from: from,
      effective_to: to,
      time_basis: "accepted_at",
      bucket_ms: bucketMs,
    },
    as_of: Math.max(Date.now(), to),
    totals: counts,
    buckets,
    breakdowns:
      kind === "decision"
        ? {
            checks: { items: [], other_count: 0 },
            reasons: { items: [], other_count: 0 },
          }
        : {},
  };
}
