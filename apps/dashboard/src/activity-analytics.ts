import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";

export type ActivityKind = "decision" | "event";
export type Counts = Record<string, number> & { total: number };
export interface ActivityAnalytics {
  schema_version: 1;
  scope: { kind: ActivityKind } & Record<string, string | null>;
  range: {
    from: number;
    to: number;
    time_basis: "accepted_at";
    effective_from: number | null;
    effective_to: number | null;
    bucket_ms: number;
  };
  as_of: number;
  retention: {
    days: number;
    requested_days: number;
    applying: boolean;
    available_since: number;
  };
  visibility: "asynchronous";
  delivery: {
    scope: "installation";
    observed_at: number;
    pending_records: number;
    oldest_record_accepted_at: number | null;
  };
  totals: Counts | null;
  buckets: { from: number; to: number; counts: Counts }[];
  breakdowns: Record<
    string,
    {
      items: { value: string | null; count: number }[];
      other_count: number;
    }
  >;
}

export const ranges = [
  ["24", "Last 24 hours"],
  ["168", "Last 7 days"],
  ["720", "Last 30 days"],
] as const;
export const dimensions = [
  "check",
  "operation_id",
  "outcome",
  "entity",
  "entity_kind",
  "name",
  "reason",
  "provenance",
] as const;

/** A copied address must identify one scope, without silently choosing a value. */
export function activityScopeError(
  params: URLSearchParams,
  kind: ActivityKind,
) {
  const supported = new Set<string>([
    ...dimensions,
    "from",
    "to",
    "range",
    "view",
    "cursor",
  ]);
  for (const key of params.keys()) {
    if (params.getAll(key).length > 1)
      return `The address repeats the “${key}” filter. Remove the duplicate value or reset filters.`;
    if (!supported.has(key))
      return `The address contains an unsupported filter: “${key}”.`;
    if (params.get(key) === "") return `The “${key}” filter cannot be empty.`;
  }
  const incompatible =
    kind === "decision"
      ? ["name", "provenance"]
      : ["check", "operation_id", "outcome", "reason"];
  const conflict = incompatible.find((key) => params.has(key));
  if (conflict)
    return `The “${conflict}” filter does not apply to ${
      kind === "decision" ? "decisions" : "events"
    }.`;
  if (
    params.has("view") &&
    params.get("view") !== (kind === "decision" ? "decisions" : "events")
  )
    return "The activity view in this address is not supported.";
  if (
    params.has("range") &&
    params.get("range") !== "all" &&
    !ranges.some(([value]) => value === params.get("range"))
  )
    return "The time range in this address is not supported.";
  if (params.get("range") === "all" && (params.has("from") || params.has("to")))
    return "All retained records cannot also have fixed time bounds.";
  for (const key of ["from", "to"]) {
    if (
      params.has(key) &&
      (!/^\d+$/.test(params.get(key)!) ||
        !Number.isSafeInteger(Number(params.get(key))) ||
        Number(params.get(key)) > 8.64e15)
    )
      return "The address must use valid, nonnegative millisecond time bounds.";
  }
  if (
    params.has("from") &&
    params.has("to") &&
    Number(params.get("from")) > Number(params.get("to"))
  )
    return "The interval end must be at or after its start.";
  if (
    params.has("entity_kind") &&
    (!params.has("entity") ||
      !["client", "session", "user", "ip"].includes(params.get("entity_kind")!))
  )
    return "An entity type requires an exact client, session, user or IP identifier.";
  if (
    params.has("outcome") &&
    !["ALLOW", "DENY", "CHALLENGE_REQUIRED"].includes(params.get("outcome")!)
  )
    return "The result filter in this address is not supported.";
  if (
    params.has("provenance") &&
    !["backend", "browser"].includes(params.get("provenance")!)
  )
    return "The source filter in this address is not supported.";
  return null;
}

export function scopeQuery(params: URLSearchParams, kind: ActivityKind) {
  const query = new URLSearchParams();
  const fields =
    kind === "decision"
      ? ["check", "operation_id", "outcome", "entity", "entity_kind", "reason"]
      : ["entity", "entity_kind", "name", "provenance"];
  for (const key of fields) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  for (const key of ["from", "to"]) {
    const value = params.get(key);
    if (value !== null) query.set(key, value);
  }
  return query;
}

/** Relative addresses retain their visible bounds until an explicit refresh. */
export function refreshedWindow(params: URLSearchParams, now: number) {
  const next = new URLSearchParams(params);
  const hours = ranges.find(([value]) => value === params.get("range"))?.[0];
  if (hours) {
    next.delete("cursor");
    next.delete("history_cursor");
    next.set("from", String(Math.max(0, now - Number(hours) * 3_600_000)));
    next.set("to", String(now));
  }
  return next;
}

export function useActivityWindow(kind?: ActivityKind) {
  const [params, setParams] = useSearchParams();
  const scopeError = activityScopeError(
    params,
    kind ?? (params.get("view") === "events" ? "event" : "decision"),
  );
  const all = params.get("range") === "all";
  const ready =
    !scopeError && (all || (params.has("from") && params.has("to")));
  useEffect(() => {
    if (ready || scopeError) return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        const now = Date.now();
        if (!next.has("from")) {
          if (!ranges.some(([value]) => value === next.get("range")))
            next.set("range", "24");
          next.set(
            "from",
            String(Math.max(0, now - Number(next.get("range")) * 3_600_000)),
          );
        }
        if (!next.has("to")) next.set("to", String(now));
        return next;
      },
      { replace: true },
    );
  }, [ready, scopeError, setParams]);
  return { params, setParams, ready, all, scopeError };
}

export function analyticsPath(params: URLSearchParams, kind: ActivityKind) {
  if (activityScopeError(params, kind)) return null;
  if (!params.has("from") || !params.has("to")) return null;
  const from = Number(params.get("from")),
    to = Number(params.get("to"));
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to - from >= 31 * 86_400_000
  )
    return null;
  const query = scopeQuery(params, kind);
  query.set("kind", kind);
  return `/analytics/activity?${query}`;
}

export function activityLink(
  scope: URLSearchParams,
  kind: ActivityKind,
  changes: Record<string, string | number | null> = {},
) {
  const next = scopeQuery(scope, kind);
  next.set("view", kind === "decision" ? "decisions" : "events");
  // A chart drilldown always freezes the exact observed time interval.
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) next.delete(key);
    else next.set(key, String(value));
  }
  return `/activity?${next}`;
}

const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === "object" && !Array.isArray(v));
const integer = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0;
const time = (v: unknown): v is number => integer(v) && v <= 8.64e15;
const nullableTime = (v: unknown) => v === null || time(v);
export function validAnalytics(value: unknown): value is ActivityAnalytics {
  if (
    !object(value) ||
    value.schema_version !== 1 ||
    !object(value.scope) ||
    !["decision", "event"].includes(String(value.scope.kind)) ||
    !object(value.range) ||
    !object(value.retention) ||
    !object(value.delivery) ||
    !object(value.breakdowns) ||
    !Array.isArray(value.buckets) ||
    value.buckets.length > 400 ||
    !time(value.as_of) ||
    value.visibility !== "asynchronous"
  )
    return false;
  const { range, retention, delivery, scope } = value;
  if (
    !time(range.from) ||
    !time(range.to) ||
    range.from > range.to ||
    !nullableTime(range.effective_from) ||
    !nullableTime(range.effective_to) ||
    ![300_000, 3_600_000, 86_400_000].includes(Number(range.bucket_ms)) ||
    typeof range.bucket_ms !== "number" ||
    range.time_basis !== "accepted_at" ||
    !integer(retention.days) ||
    !integer(retention.requested_days) ||
    !time(retention.available_since) ||
    typeof retention.applying !== "boolean" ||
    delivery.scope !== "installation" ||
    !time(delivery.observed_at) ||
    !integer(delivery.pending_records) ||
    !nullableTime(delivery.oldest_record_accepted_at) ||
    !dimensions.every(
      (key) => scope[key] === null || typeof scope[key] === "string",
    )
  )
    return false;
  const keys =
    value.scope.kind === "decision"
      ? ["allow", "deny", "awaiting_verification", "unknown"]
      : ["backend", "browser", "unknown"];
  const counts = (v: unknown): v is Counts =>
    object(v) &&
    integer(v.total) &&
    keys.every((key) => integer(v[key])) &&
    keys.reduce((sum, key) => sum + Number(v[key]), 0) === v.total;
  const effectiveFrom = Math.max(range.from, retention.available_since);
  const effectiveTo = Math.min(range.to, value.as_of);
  if (effectiveFrom > effectiveTo)
    return (
      value.totals === null &&
      range.effective_from === null &&
      range.effective_to === null &&
      value.buckets.length === 0 &&
      Object.keys(value.breakdowns).length === 0
    );
  if (
    !counts(value.totals) ||
    !time(range.effective_from) ||
    !time(range.effective_to) ||
    range.effective_from !== effectiveFrom ||
    range.effective_to !== effectiveTo ||
    !value.buckets.length
  )
    return false;
  let start = range.effective_from;
  const sums: Record<string, number> = Object.fromEntries(
    ["total", ...keys].map((key) => [key, 0]),
  );
  for (const bucket of value.buckets) {
    if (
      !object(bucket) ||
      !time(bucket.from) ||
      !time(bucket.to) ||
      bucket.from !== start ||
      bucket.to < bucket.from ||
      bucket.to > range.effective_to ||
      bucket.to !==
        Math.min(
          Math.floor(bucket.from / range.bucket_ms) * range.bucket_ms +
            range.bucket_ms -
            1,
          range.effective_to,
        ) ||
      !counts(bucket.counts)
    )
      return false;
    for (const key of Object.keys(sums))
      sums[key] = sums[key]! + bucket.counts[key]!;
    start = bucket.to + 1;
  }
  if (
    start !== range.effective_to + 1 ||
    Object.keys(sums).some((key) => sums[key] !== (value.totals as Counts)[key])
  )
    return false;
  for (const breakdown of Object.values(value.breakdowns)) {
    if (
      !object(breakdown) ||
      !Array.isArray(breakdown.items) ||
      breakdown.items.length > 10 ||
      !integer(breakdown.other_count) ||
      !breakdown.items.every(
        (row) =>
          object(row) &&
          (row.value === null || typeof row.value === "string") &&
          integer(row.count),
      )
    )
      return false;
    if (
      breakdown.items.reduce(
        (sum, row) => sum + Number(row.count),
        breakdown.other_count,
      ) !== value.totals.total
    )
      return false;
  }
  return (
    value.scope.kind === "event" ||
    (object(value.breakdowns.checks) && object(value.breakdowns.reasons))
  );
}

export const countLabel = (value: number) =>
  new Intl.NumberFormat().format(value);
export const exactUtc = (value: number) => new Date(value).toISOString();
export const reasonName = (reason: string) =>
  ({
    rule_matched: "Rule matched",
    otherwise: "Default outcome",
    unknown_denied: "Denied on unknown evidence",
    verification_required: "Verification required",
    verification_failed: "Verification failed",
    verification_expired: "Verification expired",
    verification_unavailable: "Verification unavailable",
  }[reason] ?? reason.replaceAll("_", " "));

export const series = (kind: ActivityKind) =>
  kind === "decision"
    ? [
        { key: "allow", label: "Allow", filter: "ALLOW" },
        { key: "deny", label: "Deny", filter: "DENY" },
        {
          key: "awaiting_verification",
          label: "Awaiting verification",
          filter: "CHALLENGE_REQUIRED",
        },
        { key: "unknown", label: "Other / unknown", filter: null },
      ]
    : [
        { key: "backend", label: "Backend assertions", filter: "backend" },
        { key: "browser", label: "Client evidence", filter: "browser" },
        { key: "unknown", label: "Unknown source", filter: null },
      ];
