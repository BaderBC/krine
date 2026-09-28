import { useEffect, useMemo } from "react";
import type { FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { encode } from "./api";
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
                <Link
                  className="identifier"
                  to={`/checks/${encode(decision.check)}`}
                >
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
                <Link
                  className="identifier"
                  to={`/activity/events/${encode(event.event_id)}`}
                >
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
  if (!query.has("from") && params.get("range") !== "all")
    query.set("from", String(defaultFrom));
  const resource = useResource<Page<Decision | Event>>(
    `/activity/${events ? "events" : "decisions"}?${query}`,
  );
  useActivityScroll(Boolean(resource.data));
  const searchKey =
    ["check", "operation_id", "entity", "name"].find((key) =>
      params.has(key),
    ) ?? (events ? "name" : "check");
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    if (events) next.set("view", "events");
    const key = String(form.get("search_kind"));
    const value = String(form.get("search") ?? "").trim();
    if (key === "record" && value) {
      rememberActivityPosition(origin);
      navigate(
        `/activity/${events ? "events" : "decisions"}/${encode(value)}${origin ? `?return_to=${encode(origin)}` : ""}`,
      );
      return;
    }
    if (value) next.set(key, value);
    const range = String(form.get("range"));
    next.set("range", range);
    if (range !== "all")
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
          to="/activity?view=decisions"
        >
          Decisions
        </Link>
        <Link
          aria-current={events ? "page" : undefined}
          to="/activity?view=events"
        >
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
      {params.has("entity") && (
        <p className="help">
          Open entity:{" "}
          <Link to={`/entities/client/${encode(params.get("entity")!)}`}>
            Client
          </Link>{" "}
          ·{" "}
          <Link to={`/entities/user/${encode(params.get("entity")!)}`}>
            User
          </Link>{" "}
          · <Link to={`/entities/ip/${encode(params.get("entity")!)}`}>IP</Link>{" "}
          ·{" "}
          <Link to={`/entities/session/${encode(params.get("entity")!)}`}>
            Session
          </Link>
        </p>
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
        Activity shows records Krine received and retained. An unreachable SDK
        may be unable to report a local fallback; an absent record does not
        prove no action occurred.
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
            <strong>{refLabel(trace.reference)}</strong> ·{" "}
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
            <Link to={`/checks/${encode(record.check)}?view=draft`}>
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
                  to={`/checks/${encode(record.check)}?version=${record.policy_version}`}
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
          {rule && (
            <p className="explanation">
              When {conditionLabel(rule.condition)}.<br />
              Then {actionLabel(rule.then)}. If unknown:{" "}
              {actionLabel(rule.on_unknown)}.
            </p>
          )}
          <Identifiers record={record} />
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
              {Object.keys(record.snapshot.inputs).length > 0 && (
                <JsonDetails
                  title="Trusted backend inputs"
                  value={record.snapshot.inputs}
                />
              )}
              {record.relationship_ids &&
                record.relationship_ids.length > 0 && (
                  <p className="help">
                    Relationship references:{" "}
                    {record.relationship_ids.join(", ")}
                  </p>
                )}
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
  const { id = "" } = useParams();
  const resource = useResource<Event>(`/activity/events/${encode(id)}`);
  const record = resource.data;
  return (
    <>
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

export function EntityPage() {
  const { kind = "", id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const resource = useResource<Entity>(
    `/entities/${encode(kind)}/${encode(id)}${params.has("associations_cursor") ? `?associations_cursor=${encode(params.get("associations_cursor")!)}` : ""}`,
  );
  const entity = resource.data;
  return (
    <>
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
                <Link to={`/activity?entity=${encode(id)}`}>View activity</Link>
              </>
            }
          />
          <p className="help">
            First observed <Time at={entity.first_seen} />. A client or shared
            IP is evidence, never proof of a person’s identity.
          </p>
          <h2>Current metrics</h2>
          <MetricValues metrics={entity.metrics} />
          <h2>Relationships</h2>
          {entity.associations.length ? (
            <ul className="relationship-list">
              {entity.associations.map((association) => (
                <li key={association.association_id}>
                  <p>
                    <EntityLink kind="client" id={association.client_id} /> →{" "}
                    <EntityLink kind="user" id={association.user_id} />
                  </p>
                  <p className="help">
                    {association.provenance === "backend"
                      ? "Backend assertion"
                      : association.provenance}{" "}
                    · {association.revoked_at === null ? "Active" : "Corrected"}{" "}
                    · Created <Time at={association.created_at} />
                  </p>
                  {association.revocation_reason && (
                    <p>{association.revocation_reason}</p>
                  )}
                  <JsonDetails
                    title="Relationship record"
                    value={association}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No retained relationships.</p>
          )}
          {entity.associations_next_cursor && (
            <button
              onClick={() =>
                setParams({
                  associations_cursor: entity.associations_next_cursor!,
                })
              }
            >
              Next relationships →
            </button>
          )}
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
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}
