import {
  validHistoryCoverage,
  type HistoryCoverage,
  ranges,
} from "./activity-analytics";
import type { Decision, Entity, MetricObservation } from "./types";

export const subjectKinds = ["client", "session", "user", "ip"] as const;
export type SubjectKind = (typeof subjectKinds)[number];
export type SampleMarker = { dataset_id: string; generator_version: string };
export interface EventSummary {
  event_id: string;
  name: string | null;
  accepted_at: number;
  occurred_at: number | null;
  client_id: string | null;
  session_id: string | null;
  user_id: string | null;
  ip: string | null;
  provenance: string | null;
  sample_data?: SampleMarker;
}
export type TimelineEntry =
  | { kind: "event"; id: string; accepted_at: number; summary: EventSummary }
  | {
      kind: "decision";
      id: string;
      accepted_at: number;
      summary: Decision & { sample_data?: SampleMarker };
    };
export type SubjectTimeline = HistoryCoverage & {
  schema_version: 1;
  scope: { kind: SubjectKind; id: string };
  items: TimelineEntry[];
  next_cursor: string | null;
};
export type SubjectContext = Omit<
  Entity,
  "recent_events" | "recent_decisions"
> & { observed_at: number };
export const pageSize = 50;
export const maximumInterval = 31 * 86_400_000;
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown): v is number => integer(v) && v <= 8.64e15;
const nullableTime = (v: unknown) => v === null || time(v);
const text = (v: unknown): v is string => typeof v === "string";
const id = (v: unknown): v is string =>
  text(v) &&
  v.length > 0 &&
  new TextEncoder().encode(v).length <= 256 &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v);
const nullableId = (v: unknown) => v === null || id(v);
const subjectField = (kind: string) => (kind === "ip" ? "ip" : `${kind}_id`);
export const subjectLabel = (kind: string) =>
  kind === "ip" ? "IP address" : `${kind[0]?.toUpperCase()}${kind.slice(1)}`;
export const provenanceLabel = (value: string | null | undefined) =>
  value === "backend"
    ? "Backend assertion"
    : value === "browser"
      ? "Client evidence"
      : "Unknown source";

function validMetric(value: unknown): value is MetricObservation {
  return (
    object(value) &&
    integer(value.version) &&
    value.version > 0 &&
    object(value.state) &&
    (value.state.status === "known"
      ? text(value.state.value) ||
        typeof value.state.value === "boolean" ||
        (typeof value.state.value === "number" &&
          Number.isFinite(value.state.value) &&
          Math.abs(value.state.value) <= Number.MAX_SAFE_INTEGER)
      : value.state.status === "unknown" && text(value.state.reason)) &&
    object(value.provenance) &&
    text(value.provenance.source) &&
    time(value.provenance.observed_at)
  );
}
export function validContext(
  value: unknown,
  kind: string,
  subject: string,
): value is SubjectContext {
  return (
    object(value) &&
    value.kind === kind &&
    value.id === subject &&
    time(value.first_seen) &&
    time(value.observed_at) &&
    object(value.metadata) &&
    object(value.metrics) &&
    Object.values(value.metrics).every(validMetric) &&
    Array.isArray(value.associations) &&
    (value.associations_next_cursor === null ||
      text(value.associations_next_cursor))
  );
}
const sample = (value: unknown) =>
  value === undefined ||
  (object(value) && id(value.dataset_id) && id(value.generator_version));
function validDecision(value: Record<string, unknown>) {
  return (
    id(value.decision_id) &&
    id(value.operation_id) &&
    id(value.check) &&
    text(value.reason) &&
    (value.outcome === null || text(value.outcome)) &&
    text(value.source) &&
    ["evaluation", "request_error", "fallback"].includes(value.source) &&
    nullableTime(value.completed_at) &&
    (value.policy_version === null ||
      (integer(value.policy_version) && value.policy_version > 0))
  );
}
function validEvent(value: Record<string, unknown>) {
  return (
    id(value.event_id) &&
    (value.name === null || text(value.name)) &&
    nullableTime(value.occurred_at) &&
    (value.provenance === null || text(value.provenance))
  );
}
function byteCompare(a: string, b: string) {
  const first = new TextEncoder().encode(a),
    second = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(first.length, second.length); i++) {
    if (first[i] !== second[i]) return first[i]! - second[i]!;
  }
  return first.length - second.length;
}
export function validTimeline(
  value: unknown,
  kind: string,
  subject: string,
  from: number,
  to: number,
  cursor: string | null = null,
): value is SubjectTimeline {
  if (
    !object(value) ||
    !validHistoryCoverage(value) ||
    value.schema_version !== 1 ||
    !object(value.scope) ||
    value.scope.kind !== kind ||
    value.scope.id !== subject ||
    value.range.from !== from ||
    value.range.to !== to ||
    !Array.isArray(value.items) ||
    value.items.length > pageSize ||
    !(
      value.next_cursor === null ||
      (text(value.next_cursor) &&
        value.next_cursor.length > 0 &&
        value.next_cursor.length <= 4096 &&
        value.next_cursor !== cursor)
    )
  )
    return false;
  if (value.range.effective_from === null)
    return value.items.length === 0 && value.next_cursor === null;
  if (value.items.length === 0 && value.next_cursor !== null) return false;
  const seen = new Set<string>();
  let previous: TimelineEntry | undefined;
  for (const item of value.items) {
    if (
      !object(item) ||
      (item.kind !== "event" && item.kind !== "decision") ||
      !id(item.id) ||
      !time(item.accepted_at) ||
      item.accepted_at < value.range.effective_from ||
      item.accepted_at > value.range.effective_to! ||
      !object(item.summary)
    )
      return false;
    const summary = item.summary;
    if (
      summary.accepted_at !== item.accepted_at ||
      summary[subjectField(kind)] !== subject ||
      !["client_id", "session_id", "user_id", "ip"].every((key) =>
        nullableId(summary[key]),
      ) ||
      !sample(summary.sample_data) ||
      (item.kind === "event"
        ? !validEvent(summary) || summary.event_id !== item.id
        : !validDecision(summary) || summary.decision_id !== item.id)
    )
      return false;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const entry = item as TimelineEntry;
    if (
      previous &&
      (entry.accepted_at > previous.accepted_at ||
        (entry.accepted_at === previous.accepted_at &&
          (byteCompare(entry.kind, previous.kind) > 0 ||
            (entry.kind === previous.kind &&
              byteCompare(entry.id, previous.id) > 0))))
    )
      return false;
    previous = entry;
  }
  return true;
}

export const profileSelectors = [
  "kind",
  "id",
  "from",
  "to",
  "range",
  "cursor",
  "trend",
  "return_to",
  "relationships_cursor",
  "relationship_kind",
  "relationship_id",
  "relationship_audit_cursor",
] as const;
export function profileScopeError(
  params: URLSearchParams,
  kind: string,
  subject: string,
) {
  for (const key of params.keys()) {
    if (!profileSelectors.includes(key as (typeof profileSelectors)[number]))
      return `The address contains an unsupported filter: “${key}”.`;
    if (params.getAll(key).length > 1)
      return `The address repeats the “${key}” filter. Remove the duplicate value or reset the profile.`;
    if (params.get(key) === "") return `The “${key}” filter cannot be empty.`;
  }
  if (
    (params.has("kind") && params.get("kind") !== kind) ||
    (params.has("id") && params.get("id") !== subject)
  )
    return "The address contains conflicting subject identifiers.";
  for (const key of [
    "cursor",
    "relationships_cursor",
    "relationship_audit_cursor",
  ]) {
    if ((params.get(key)?.length ?? 0) > 4096)
      return "The page cursor in this address is too long. Reset the profile.";
  }
  if ((params.get("return_to")?.length ?? 0) > 16384)
    return "The return address is too long. Reset the profile.";
  if (!subjectKinds.includes(kind as SubjectKind) || !id(subject))
    return "Provide one valid subject type and exact identifier in the address.";
  if (
    params.has("trend") &&
    !["decisions", "events"].includes(params.get("trend")!)
  )
    return "Choose either the check or event trend.";
  if (
    params.has("range") &&
    !ranges.some(([value]) => value === params.get("range"))
  )
    return "Choose a supported time interval.";
  if (params.has("from") !== params.has("to"))
    return "Provide both the start and end of the investigation interval.";
  if (params.has("from")) {
    for (const key of ["from", "to"])
      if (!/^\d+$/.test(params.get(key)!) || !time(Number(params.get(key))))
        return "Use valid, nonnegative millisecond time bounds.";
    const from = Number(params.get("from")),
      to = Number(params.get("to"));
    if (from > to || to - from >= maximumInterval)
      return "Choose an interval of at most 31 days, with its end at or after its start.";
  }
  if (params.has("cursor") && !params.has("from"))
    return "A timeline page requires its original start and end time.";
  return null;
}

export function visibleGroups(items: TimelineEntry[]) {
  const groups: {
    day: string;
    session: string | null;
    entries: TimelineEntry[];
  }[] = [];
  for (const entry of items) {
    const day = new Date(entry.accepted_at).toISOString().slice(0, 10);
    const session = entry.summary.session_id;
    const last = groups.at(-1);
    if (last && last.day === day && last.session === session)
      last.entries.push(entry);
    else groups.push({ day, session, entries: [entry] });
  }
  return groups;
}
