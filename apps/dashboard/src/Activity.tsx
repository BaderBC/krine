import { useCallback, useEffect, useMemo } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  checkUrl,
  eventPath,
  eventUrl,
  entityPath,
  entityUrl,
  useAddressedParam,
} from "./addresses";
import { encode } from "./api";
import { CapturedRelationships, Relationships } from "./Relationships";
import {
  InvestigationLink as Link,
  ActivityReturn,
  useActivityOrigin,
  useActivityScroll,
  rememberActivityPosition,
} from "./navigation";
import { actionLabel, conditionLabel, refLabel, scalarLabel } from "./policy";
import {
  EntityLink,
  Identifiers,
  JsonDetails,
  Loading,
  Notice,
  ResourceError,
  PageTitle,
  Pagination,
  Time,
  useResource,
} from "./shared";
import type {
  ConditionTrace,
  Decision,
  DecisionDetail,
  Entity,
  Event,
  MetricObservation,
  Page,
} from "./types";

export function resultLabel(decision: Decision) {
  if (decision.source === "request_error") return "Request rejected";
  if (decision.source === "fallback")
    return `SDK fallback · ${actionLabel(decision.outcome ?? "Unknown")}`;
  return decision.outcome ? actionLabel(decision.outcome) : "Evaluation error";
}
function reasonLabel(reason: string) {
  return reason.replaceAll("_", " ");
}

export function DecisionRows({ items }: { items: Decision[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Check</th>
            <th>Result</th>
            <th>Subject</th>
          </tr>
        </thead>
        <tbody>
          {items.map((decision) => (
            <tr key={decision.decision_id}>
              <td>
                <Link
                  to={`/activity/decisions/${encode(decision.decision_id)}`}
                >
                  <Time at={decision.accepted_at} />
                </Link>
              </td>
              <td>
                <Link className="identifier" to={checkUrl(decision.check)}>
                  {decision.check}
                </Link>
              </td>
              <td>
                <Link
                  to={`/activity/decisions/${encode(decision.decision_id)}`}
                >
                  {resultLabel(decision)}
                </Link>
                <p className="help">{reasonLabel(decision.reason)}</p>
              </td>
              <td>
                <EntityLink
                  kind={decision.user_id ? "user" : "client"}
                  id={decision.user_id ?? decision.client_id}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function EventRows({ items }: { items: Event[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Source</th>
            <th>Subject</th>
          </tr>
        </thead>
        <tbody>
          {items.map((event) => (
            <tr key={event.event_id}>
              <td>
                <Time at={event.accepted_at} />
              </td>
              <td>
                <Link className="identifier" to={eventUrl(event.event_id)}>
                  {event.name}
                </Link>
              </td>
              <td>
                {event.provenance === "backend"
                  ? "Backend assertion"
                  : "Client evidence"}
              </td>
              <td>
                <EntityLink
                  kind={event.user_id ? "user" : "client"}
                  id={event.user_id ?? event.client_id}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Activity() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const events = params.get("view") === "events";
  const origin = useActivityOrigin();
  const entityKind =
    params.has("entity") &&
    ["client", "session", "user", "ip"].includes(
      params.get("entity_kind") ?? "",
    )
      ? params.get("entity_kind")
      : null;
  function viewUrl(view: "events" | "decisions") {
    const next = new URLSearchParams(params);
    next.set("view", view);
    next.delete("cursor");
    for (const key of view === "events"
      ? ["check", "operation_id", "outcome"]
      : ["name"])
      next.delete(key);
    return `/activity?${next}`;
  }
  const defaultFrom = useMemo(() => Date.now() - 86_400_000, []);
  useEffect(() => {
    if (params.has("from") || params.get("range") === "all") return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set("from", String(defaultFrom));
        return next;
      },
      { replace: true },
    );
  }, [params, setParams, defaultFrom]);
  const query = new URLSearchParams();
  for (const key of [
    "cursor",
    "check",
    "operation_id",
    "outcome",
    "entity",
    "name",
    "from",
    "to",
  ]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  if (entityKind) query.set("entity_kind", entityKind);
  if (!query.has("from") && params.get("range") !== "all")
    query.set("from", String(defaultFrom));
  const resource = useResource<Page<Decision | Event>>(
    `/activity/${events ? "events" : "decisions"}?${query}`,
  );
  useActivityScroll(Boolean(resource.data));
  const searchKey =
    ["check", "operation_id", "entity", "name"].find(
      (key) => params.has(key) && !(key === "entity" && entityKind),
    ) ?? (events ? "name" : "check");
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (events) next.set("view", "events");
    const key = String(form.get("search_kind"));
    const search = String(form.get("search") ?? "");
    const value = key === "entity" ? search : search.trim();
    if (key === "record" && value) {
      rememberActivityPosition(origin);
      navigate(
        `${events ? eventUrl(value) : `/activity/decisions/${encode(value)}`}${origin ? `${events ? "&" : "?"}return_to=${encode(origin)}` : ""}`,
      );
      return;
    }
    if (entityKind && (key !== "entity" || value === params.get("entity"))) {
      next.set("entity", params.get("entity")!);
      next.set("entity_kind", entityKind);
    }
    if (value) next.set(key, value);
    const range = String(form.get("range"));
    next.set("range", range);
    if (range === (params.get("range") ?? "24")) {
      for (const key of ["from", "to"])
        if (params.has(key)) next.set(key, params.get(key)!);
    } else if (range !== "all")
      next.set("from", String(Date.now() - Number(range) * 3_600_000));
    const outcome = String(form.get("outcome") ?? "");
    if (outcome && !events) next.set("outcome", outcome);
    setParams(next);
  }
  return (
    <>
      <PageTitle title="Activity">
        <button
          disabled={resource.loading}
          onClick={() => void resource.refresh()}
        >
          {resource.loading && resource.data
            ? "Refreshing…"
            : "Refresh activity"}
        </button>
      </PageTitle>
      <nav className="view-switch" aria-label="Activity view">
        <Link
          aria-current={!events ? "page" : undefined}
          to={viewUrl("decisions")}
        >
          Decisions
        </Link>
        <Link aria-current={events ? "page" : undefined} to={viewUrl("events")}>
          Events
        </Link>
      </nav>
      <form
        className="activity-filter"
        key={params.toString()}
        onSubmit={filter}
      >
        <label>
          Find by
          <select name="search_kind" defaultValue={searchKey}>
            {events ? (
              <option value="name">Event name</option>
            ) : (
              <>
                <option value="check">Check name</option>
                <option value="operation_id">Operation ID</option>
              </>
            )}
            <option value="entity">Exact entity identifier</option>
            <option value="record">Record ID</option>
          </select>
        </label>
        <label>
          Search
          <input
            name="search"
            type="search"
            autoComplete="off"
            spellCheck={false}
            defaultValue={params.get(searchKey) ?? ""}
            maxLength={256}
            placeholder="Name or identifier…"
          />
        </label>
        <label>
          Time
          <select name="range" defaultValue={params.get("range") ?? "24"}>
            <option value="24">Last 24 hours</option>
            <option value="168">Last 7 days</option>
            <option value="720">Last 30 days</option>
            <option value="all">All retained records</option>
          </select>
        </label>
        {!events && (
          <label>
            Result
            <select name="outcome" defaultValue={params.get("outcome") ?? ""}>
              <option value="">Any result</option>
              <option value="ALLOW">Allow</option>
              <option value="DENY">Deny</option>
              <option value="CHALLENGE_REQUIRED">Awaiting verification</option>
            </select>
          </label>
        )}
        <button type="submit">Find</button>
      </form>
      {entityKind ? (
        <p className="help">
          Scoped to {entityKind === "ip" ? "IP" : entityKind}:{" "}
          <EntityLink kind={entityKind} id={params.get("entity")} /> ·{" "}
          <Link
            to={(() => {
              const next = new URLSearchParams(params);
              next.delete("entity");
              next.delete("entity_kind");
              next.delete("cursor");
              return `/activity?${next}`;
            })()}
          >
            Clear entity scope
          </Link>
        </p>
      ) : (
        params.has("entity") && (
          <p className="help">
            Open entity:{" "}
            <Link to={entityUrl("client", params.get("entity")!)}>Client</Link>{" "}
            · <Link to={entityUrl("user", params.get("entity")!)}>User</Link> ·{" "}
            <Link to={entityUrl("ip", params.get("entity")!)}>IP</Link> ·{" "}
            <Link to={entityUrl("session", params.get("entity")!)}>
              Session
            </Link>
          </p>
        )
      )}
      <ResourceError resource={resource} />
      {resource.refreshed && (
        <p className="help">
          Last refreshed <Time at={resource.refreshed} />. New records appear
          when you refresh.
        </p>
      )}
      {resource.data ? (
        <>
          {resource.data.items.length ? (
            events ? (
              <EventRows items={resource.data.items as Event[]} />
            ) : (
              <DecisionRows items={resource.data.items as Decision[]} />
            )
          ) : (
            <div className="empty">
              <h2>No matching records.</h2>
              <p>
                Change your filters or time range. Records appear after
                analytical export.
              </p>
              <Link
                to={
                  events
                    ? "/activity?view=events&range=all"
                    : "/activity?range=all"
                }
              >
                Clear filters and show retained records
              </Link>
            </div>
          )}
          <Pagination
            page={resource.data}
            onNext={(cursor) =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("cursor", cursor);
                return next;
              })
            }
          />
        </>
      ) : resource.loading ? (
        <Loading />
      ) : null}
      <p className="help footnote">
        Activity shows records Krine received and retained. Your application
        must record local SDK fallback; the SDK does not report it
        automatically. An absent record does not prove no action occurred.
      </p>
    </>
  );
}

function Trace({ trace }: { trace: ConditionTrace }) {
  return (
    <div className="trace">
      <p>
        {trace.reference && (
          <>
            <strong>
              {trace.reference.source === "metric" ? (
                <Link
                  to={`/metrics/${encode(trace.reference.name)}?version=${trace.reference.version}`}
                >
                  {refLabel(trace.reference)}
                </Link>
              ) : (
                refLabel(trace.reference)
              )}
            </strong>{" "}
            ·{" "}
          </>
        )}
        {trace.observed
          ? trace.observed.status === "known"
            ? scalarLabel(trace.observed.value)
            : `Unknown: ${reasonLabel(trace.observed.reason)}`
          : null}{" "}
        <span className="muted">→ {trace.result}</span>
      </p>
      {trace.children?.map((child, index) => (
        <Trace key={index} trace={child} />
      ))}
    </div>
  );
}

function continuationReason(
  trace: NonNullable<DecisionDetail["evaluation"]>["trace"][number],
) {
  if (trace.route === "verification_passed")
    return "Verification passed; evaluation continued.";
  if (trace.condition.result === "unknown")
    return "Condition unknown; the policy explicitly continued.";
  return "Condition false; evaluation continued.";
}
function capturedLeaves(trace: ConditionTrace): ConditionTrace[] {
  return trace.reference
    ? [trace]
    : (trace.children ?? []).flatMap(capturedLeaves);
}
function OtherwiseEvidence({ record }: { record: DecisionDetail }) {
  const traces = record.evaluation?.trace ?? [];
  return (
    <div className="decisive-evidence" aria-label="Otherwise captured evidence">
      <p>
        {traces.length ? "Every rule continued." : "This policy has no rules."}{" "}
        Otherwise {actionLabel(record.policy!.otherwise)}.
      </p>
      {traces.slice(0, 3).map((trace) => {
        const index = record.policy!.rules.findIndex(
          (rule) => rule.id === trace.rule_id,
        );
        const condition =
          index >= 0
            ? conditionLabel(record.policy!.rules[index]!.condition)
            : "";
        const leaves = capturedLeaves(trace.condition);
        return (
          <div className="continuation-evidence" key={trace.rule_id}>
            <p>
              <strong>Rule {index + 1}</strong> · {continuationReason(trace)}
            </p>
            {condition.length <= 220 && <p className="help">{condition}</p>}
            {leaves.slice(0, 4).map((leaf, at) => (
              <Trace key={at} trace={leaf} />
            ))}
            {(leaves.length > 4 || condition.length > 220) && (
              <p className="help">
                Inspect the policy path below for the complete condition and its
                captured values.
              </p>
            )}
          </div>
        );
      })}
      {traces.length > 3 && (
        <p className="help">
          {traces.length - 3} further rules continued. Inspect the full policy
          path below.
        </p>
      )}
    </div>
  );
}
function VerificationHistory({ record }: { record: DecisionDetail }) {
  const transitions = record.verification_transitions;
  if (!transitions?.length) return null;
  const steps = [
    ...new Set(
      transitions.map((transition) => transition.challenge_id).filter(Boolean),
    ),
  ];
  const labels: Record<string, string> = {
    pending: "Awaiting verification",
    verifying: "Verifying evidence",
    passed: "Verified; continued to the next rule",
    failed: "Verification failed",
    expired: "Verification expired",
    unavailable: "Verification unavailable",
  };
  return (
    <details id="verification-steps">
      <summary>Verification steps</summary>
      <p className="help">
        These transitions belong to the same protected attempt. Passing a step
        continues the policy; only a final Allow authorizes the action.
      </p>
      <ol className="verification-history">
        {transitions.map((transition) => (
          <li key={transition.sequence}>
            <Time at={transition.at} /> ·{" "}
            {transition.challenge_id &&
              `Step ${steps.indexOf(transition.challenge_id) + 1} · `}
            {labels[transition.state] ?? reasonLabel(transition.state)}
            <p className="help">{reasonLabel(transition.detail)}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

function ProviderEvidence({ record }: { record: DecisionDetail }) {
  if (
    !record.provider_revisions ||
    !Object.keys(record.provider_revisions).length
  )
    return null;
  return (
    <>
      <h3>Provider contribution</h3>
      {Object.entries(record.provider_revisions).map(([capability, pinned]) => {
        const observation = record.provider_observations?.[capability];
        return (
          <div key={capability}>
            <p>
              {capability === "verification"
                ? "Verification"
                : "IP intelligence"}{" "}
              ·{" "}
              {pinned.enabled
                ? `Configuration revision ${pinned.revision}`
                : "Not configured for this attempt"}
            </p>
            {observation && (
              <p className="help">
                {reasonLabel(observation.status)} ·{" "}
                {reasonLabel(observation.detail)} · Observed{" "}
                <Time at={observation.observed_at} />.
              </p>
            )}
            {capability === "verification" && pinned.enabled && (
              <p className="help">
                {record.verification_transitions?.length
                  ? "Verification results are recorded in this attempt’s verification steps."
                  : "This attempt did not reach a verification step."}
              </p>
            )}
            {capability === "ip_intelligence" &&
              pinned.enabled &&
              !observation && (
                <p className="help">No provider observation was recorded.</p>
              )}
            <Link
              className="small"
              to={`/settings?provider=${encode(capability)}#providers`}
            >
              Provider settings
            </Link>
          </div>
        );
      })}
    </>
  );
}
function MetricValues({
  metrics,
}: {
  metrics: Record<string, MetricObservation>;
}) {
  return (
    <dl className="metric-values">
      {Object.entries(metrics).map(([name, observation]) => (
        <div key={name}>
          <dt>
            <Link
              translate="no"
              to={`/metrics/${encode(name)}?version=${observation.version}`}
            >
              {name} v{observation.version}
            </Link>
          </dt>
          <dd>
            {observation.state.status === "known"
              ? scalarLabel(observation.state.value)
              : `Unknown · ${reasonLabel(observation.state.reason)}`}
            <p className="help">
              {reasonLabel(observation.provenance.source)} · Observed{" "}
              <Time at={observation.provenance.observed_at} />
            </p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DecisionPage() {
  const { id = "" } = useParams();
  const resource = useResource<DecisionDetail>(
    `/activity/decisions/${encode(id)}`,
  );
  const record = resource.data;
  const rule = record?.policy?.rules.find(
    (value) => value.id === record.evaluation?.rule_id,
  );
  const decisive = record?.evaluation?.trace.find(
    (trace) => trace.rule_id === record.evaluation?.rule_id,
  );
  const ruleNumber =
    rule && record?.policy ? record.policy.rules.indexOf(rule) + 1 : null;
  return (
    <>
      <ResourceError resource={resource} />
      {record ? (
        <>
          <PageTitle
            title={`${record.check} → ${resultLabel(record)}`}
            eyebrow={<ActivityReturn />}
          >
            <Link to={`${checkUrl(record.check)}&view=draft`}>
              Edit current policy
            </Link>
          </PageTitle>
          <p className="lead">
            {reasonLabel(record.reason)}
            {ruleNumber !== null ? ` · Rule ${ruleNumber}` : ""}
          </p>
          <p className="help">
            <Time at={record.accepted_at} />
            {record.policy_version != null && (
              <>
                {" "}
                ·{" "}
                <Link
                  to={`${checkUrl(record.check)}&version=${record.policy_version}`}
                >
                  Policy v{record.policy_version}
                </Link>
              </>
            )}
          </p>
          {decisive && (
            <div
              className="decisive-evidence"
              aria-label="Decisive captured evidence"
            >
              <Trace trace={decisive.condition} />
            </div>
          )}
          {record.reason === "otherwise" &&
            record.policy &&
            record.evaluation && <OtherwiseEvidence record={record} />}
          {record.outcome === "CHALLENGE_REQUIRED" && (
            <p className="explanation">
              The action is awaiting verification. This is the last recorded
              state; it is not a final authorization.
            </p>
          )}
          {record.reason.startsWith("verification_") &&
          record.verification_transitions?.length &&
          record.outcome !== "CHALLENGE_REQUIRED" ? (
            <p className="explanation">
              {reasonLabel(record.verification_transitions.at(-1)!.detail)}. The
              policy denied this attempt.
            </p>
          ) : null}
          {rule && (
            <p className="explanation">
              When {conditionLabel(rule.condition)}.<br />
              Then {actionLabel(rule.then)}. If unknown:{" "}
              {actionLabel(rule.on_unknown)}.
            </p>
          )}
          <Identifiers record={record} />
          <VerificationHistory record={record} />
          {record.evaluation && record.policy && (
            <details id="policy-path">
              <summary>Policy path</summary>
              <ol className="rules">
                {record.policy.rules.map((policyRule, index) => {
                  const trace = record.evaluation!.trace.find(
                    (value) => value.rule_id === policyRule.id,
                  );
                  return (
                    <li key={policyRule.id}>
                      <p>
                        <strong>Rule {index + 1}</strong> ·{" "}
                        {trace ? reasonLabel(trace.route) : "Not reached"}
                      </p>
                      <p>{conditionLabel(policyRule.condition)}</p>
                      {trace && <Trace trace={trace.condition} />}
                    </li>
                  );
                })}
              </ol>
              {record.evaluation.reason === "otherwise" && (
                <p>Otherwise → {actionLabel(record.policy.otherwise)}</p>
              )}
            </details>
          )}
          {record.snapshot && (
            <details id="evidence">
              <summary>Evidence captured for this decision</summary>
              <p className="help">
                These are the values used at evaluation time. Current entity
                values do not replace this record.
              </p>
              <MetricValues metrics={record.snapshot.metrics} />
              <ProviderEvidence record={record} />
              {Object.keys(record.snapshot.inputs).length > 0 && (
                <JsonDetails
                  title="Trusted backend inputs"
                  value={record.snapshot.inputs}
                />
              )}
              <CapturedRelationships record={record} />
            </details>
          )}
          <details>
            <summary>Request details</summary>
            <dl className="facts">
              <div>
                <dt>Operation</dt>
                <dd className="identifier">{record.operation_id}</dd>
              </div>
              <div>
                <dt>Record</dt>
                <dd className="identifier">{record.decision_id}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>
                  {record.source === "evaluation"
                    ? "Krine evaluation"
                    : record.source === "fallback"
                      ? "Reported SDK fallback"
                      : "Request rejected before evaluation"}
                </dd>
              </div>
            </dl>
            {record.requests && (
              <ul>
                {record.requests.map((request, index) => (
                  <li key={index}>
                    <Time at={request.at} /> · {request.kind} ·{" "}
                    {reasonLabel(request.result)}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}

export function EventPage() {
  const id = useAddressedParam("id");
  const resource = useResource<Event>(id ? eventPath(id) : null);
  const record = resource.data;
  return (
    <>
      {!id && <Notice>Provide one event ID in the address.</Notice>}
      <ResourceError resource={resource} />
      {record ? (
        <>
          <PageTitle title={record.name} eyebrow={<ActivityReturn events />} />
          <p className="lead">
            {record.provenance === "backend"
              ? "Backend assertion"
              : "Client evidence"}
          </p>
          <dl className="facts">
            <div>
              <dt>Accepted</dt>
              <dd>
                <Time at={record.accepted_at} />
              </dd>
            </div>
            <div>
              <dt>Occurred</dt>
              <dd>
                <Time at={record.occurred_at} />
              </dd>
            </div>
            <div>
              <dt>Event ID</dt>
              <dd className="identifier">{record.event_id}</dd>
            </div>
          </dl>
          <Identifiers record={record} />
          <JsonDetails value={record.properties ?? {}} />
        </>
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
const recordedTime = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const recordedIdentifier = (value: unknown) =>
  typeof value === "string" && value.length > 0;
const nullableIdentifier = (value: unknown) =>
  value === null || recordedIdentifier(value);

function validEntityMetric(value: unknown): boolean {
  if (
    !recordObject(value) ||
    !recordObject(value.state) ||
    !recordObject(value.provenance)
  )
    return false;
  const state = value.state;
  return (
    Number.isSafeInteger(value.version) &&
    Number(value.version) > 0 &&
    (state.status === "known"
      ? typeof state.value === "string" ||
        typeof state.value === "boolean" ||
        (typeof state.value === "number" &&
          Number.isFinite(state.value) &&
          Math.abs(state.value) <= Number.MAX_SAFE_INTEGER)
      : state.status === "unknown" && typeof state.reason === "string") &&
    typeof value.provenance.source === "string" &&
    recordedTime(value.provenance.observed_at)
  );
}
function validEntityDecision(value: unknown): boolean {
  if (!recordObject(value)) return false;
  return (
    recordedIdentifier(value.decision_id) &&
    recordedIdentifier(value.operation_id) &&
    recordedIdentifier(value.check) &&
    typeof value.reason === "string" &&
    (value.outcome === null || typeof value.outcome === "string") &&
    typeof value.source === "string" &&
    ["evaluation", "request_error", "fallback"].includes(value.source) &&
    recordedTime(value.accepted_at) &&
    (value.completed_at === null || recordedTime(value.completed_at)) &&
    (value.policy_version === null ||
      (Number.isSafeInteger(value.policy_version) &&
        Number(value.policy_version) > 0)) &&
    [value.client_id, value.session_id, value.user_id, value.ip].every(
      nullableIdentifier,
    )
  );
}
function validEntityEvent(value: unknown): boolean {
  if (!recordObject(value)) return false;
  return (
    recordedIdentifier(value.event_id) &&
    recordedIdentifier(value.name) &&
    recordedTime(value.accepted_at) &&
    typeof value.provenance === "string" &&
    ["backend", "browser"].includes(value.provenance) &&
    [value.client_id, value.session_id, value.user_id, value.ip].every(
      (id) => id === undefined || nullableIdentifier(id),
    )
  );
}
function validEntity(
  value: unknown,
  kind: string,
  id: string,
): value is Entity {
  if (!recordObject(value)) return false;
  return (
    value.id === id &&
    value.kind === kind &&
    ["client", "session", "user", "ip"].includes(kind) &&
    recordedTime(value.first_seen) &&
    recordObject(value.metadata) &&
    recordObject(value.metrics) &&
    Object.values(value.metrics).every(validEntityMetric) &&
    Array.isArray(value.recent_decisions) &&
    value.recent_decisions.length <= 20 &&
    value.recent_decisions.every(validEntityDecision) &&
    Array.isArray(value.recent_events) &&
    value.recent_events.length <= 20 &&
    value.recent_events.every(validEntityEvent)
  );
}

export function EntityPage() {
  const kind = useAddressedParam("kind");
  const id = useAddressedParam("id");
  const validate = useCallback(
    (value: unknown): value is Entity => validEntity(value, kind, id),
    [kind, id],
  );
  const resource = useResource<Entity>(
    kind && id ? entityPath(kind, id) : null,
    validate,
  );
  const entity = resource.data;
  const metrics = entity
    ? Object.fromEntries(
        Object.entries(entity.metrics).filter(
          ([name]) =>
            name.startsWith(`${kind}.`) ||
            (kind === "session" && name.startsWith("browser.")),
        ),
      )
    : {};
  return (
    <>
      {(!id || !kind) && (
        <Notice>Provide one entity kind and ID in the address.</Notice>
      )}
      <ResourceError resource={resource} />
      {entity ? (
        <>
          <ActivityReturn />
          <PageTitle
            title={entity.id}
            eyebrow={
              <>
                {kind === "ip" ? "IP" : kind[0]?.toUpperCase() + kind.slice(1)}{" "}
                ·{" "}
                <Link
                  to={`/activity?entity=${encode(id)}&entity_kind=${encode(kind)}`}
                >
                  View activity
                </Link>
              </>
            }
          />
          <p className="help">
            First observed <Time at={entity.first_seen} />. A client or shared
            IP is evidence, never proof of a person’s identity.
          </p>
          <h2>Current metrics</h2>
          {Object.keys(metrics).length ? (
            <MetricValues metrics={metrics} />
          ) : (
            <p className="muted">
              No built-in metrics apply directly to this entity. Inspect its
              relationships for related context.
            </p>
          )}
        </>
      ) : resource.loading ? (
        <Loading />
      ) : null}
      {id && ["client", "session", "user", "ip"].includes(kind) && (
        <Relationships
          key={`${kind}:${id}`}
          kind={kind}
          id={id}
          refreshEntity={resource.refresh}
        />
      )}
      {entity && (
        <>
          <h2>Recent decisions</h2>
          {entity.recent_decisions.length ? (
            <DecisionRows items={entity.recent_decisions} />
          ) : (
            <p className="muted">No recent decisions.</p>
          )}
          <h2>Recent events</h2>
          {entity.recent_events.length ? (
            <EventRows items={entity.recent_events} />
          ) : (
            <p className="muted">No recent events.</p>
          )}
          <JsonDetails title="Metadata" value={entity.metadata} />
        </>
      )}
    </>
  );
}
