import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  checkUrl,
  entityPath,
  entityUrl,
  eventUrl,
  useAddressedParam,
} from "./addresses";
import { encode } from "./api";
import { ActivityChart, AnalyticsCoverage, useAnalytics } from "./Analytics";
import { countLabel, refreshedWindow, exactUtc } from "./activity-analytics";
import { ActivityRange, formWindow } from "./ActivityRange";
import { CapturedReason, resultLabel } from "./CapturedReason";
import { MetricValues } from "./MetricValues";
import {
  ActivityReturn,
  InvestigationLink,
  investigationInterval,
  useActivityOrigin,
} from "./navigation";
import { Relationships } from "./Relationships";
import {
  EntityLink,
  JsonDetails,
  Loading,
  Notice,
  ResourceError,
  Time,
  useResource,
} from "./shared";
import {
  maximumInterval,
  pageSize,
  profileScopeError,
  provenanceLabel,
  subjectLabel,
  validContext,
  validTimeline,
  visibleGroups,
  type SubjectContext,
  type SubjectTimeline,
  type TimelineEntry,
} from "./subject-profile";

function useSubjectWindow(kind: string, id: string) {
  const [params, setParams] = useSearchParams();
  const origin = useActivityOrigin();
  const error = profileScopeError(params, kind, id);
  const ready = !error && params.has("from") && params.has("to");
  useEffect(() => {
    if (error || ready) return;
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        // Preserve old copied links too. An overly broad interval gets an explicit
        // range error, rather than silently investigating a different period.
        const inherited = investigationInterval(origin);
        if (inherited) {
          next.set("from", inherited.from);
          next.set("to", inherited.to);
          next.delete("range");
        } else {
          const now = Date.now();
          const range = next.get("range") ?? "168";
          next.set("range", range);
          next.set(
            "from",
            String(Math.max(0, now - Number(range) * 3_600_000)),
          );
          next.set("to", String(now));
        }
        return next;
      },
      { replace: true },
    );
  }, [error, ready, origin, kind, id, setParams]);
  return { params, setParams, error, ready };
}

function RecordTime({ at }: { at: number }) {
  return (
    <time
      dateTime={exactUtc(at)}
      title={exactUtc(at)}
      aria-label={`${exactUtc(at)} (UTC)`}
    >
      {new Intl.DateTimeFormat(undefined, {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(at)}
    </time>
  );
}
function TimelineRow({ entry, kind }: { entry: TimelineEntry; kind: string }) {
  const value = entry.summary;
  const marker = value.sample_data ? (
    <span
      className="sample-label"
      title={`Dataset ${value.sample_data.dataset_id} · generator ${value.sample_data.generator_version}`}
    >
      Sample record
    </span>
  ) : null;
  const href =
    entry.kind === "event"
      ? eventUrl(entry.id)
      : `/activity/decisions/${encode(entry.id)}`;
  return (
    <li className={`subject-record record-${entry.kind}`}>
      <InvestigationLink className="record-time" to={href}>
        <RecordTime at={entry.accepted_at} />
      </InvestigationLink>
      <div className="record-content">
        {entry.kind === "decision" ? (
          <>
            <div className="record-heading">
              <InvestigationLink className="identifier" to={href}>
                {entry.summary.check}
              </InvestigationLink>
              <span
                className={`record-outcome outcome-${entry.summary.outcome?.toLowerCase() ?? "unknown"}`}
              >
                {resultLabel(entry.summary)}
              </span>
            </div>
            <CapturedReason decision={entry.summary} compact />
            <div className="record-context">
              <span>Check</span>
              {marker}
              {entry.summary.policy_version !== null && (
                <InvestigationLink
                  to={`${checkUrl(entry.summary.check)}&version=${entry.summary.policy_version}`}
                >
                  Policy v{entry.summary.policy_version}
                </InvestigationLink>
              )}
              {entry.summary.outcome === "CHALLENGE_REQUIRED" && (
                <span>Awaiting a recorded result</span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="record-heading">
              <InvestigationLink className="identifier" to={href}>
                {entry.summary.name || "Unnamed event"}
              </InvestigationLink>
              <span className="record-kind">Event</span>
            </div>
            <div className="record-context">
              <span>{provenanceLabel(entry.summary.provenance)}</span>
              {marker}
              {entry.summary.occurred_at === null ? (
                <span>Occurrence not recorded</span>
              ) : (
                entry.summary.occurred_at !== entry.accepted_at && (
                  <span>
                    Occurred <Time at={entry.summary.occurred_at} compact />
                  </span>
                )
              )}
            </div>
          </>
        )}
        {kind !== "user" && value.user_id ? (
          <div className="record-context">
            {kind !== "user" && value.user_id && (
              <span>
                User <EntityLink kind="user" id={value.user_id} />
              </span>
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function Timeline({
  value,
  kind,
  currentPage,
}: {
  value: SubjectTimeline;
  kind: string;
  currentPage: boolean;
}) {
  const groups = visibleGroups(value.items);
  let previousDay: string | null = null;
  if (value.range.effective_from === null)
    return (
      <div className="empty-inline">
        <h3>No retained coverage for this interval.</h3>
        <p>
          This is not a zero-activity result. Choose a more recent interval.
        </p>
      </div>
    );
  if (!groups.length)
    return (
      <div className="empty-inline">
        <h3>
          {currentPage
            ? "No older records on this page."
            : "No directly attributed activity in this interval."}
        </h3>
        <p>
          {currentPage
            ? "History can change between reads. Return to the newest records or refresh this page."
            : "Try a wider interval, or follow a related client to inspect its own activity."}
        </p>
      </div>
    );
  return (
    <div className="subject-timeline">
      {groups.map((group) => {
        const showDay = previousDay !== group.day;
        previousDay = group.day;
        const clients = [
          ...new Set(group.entries.map((entry) => entry.summary.client_id)),
        ];
        return (
          <section
            className="timeline-group"
            key={`${group.entries[0]!.kind}:${group.entries[0]!.id}`}
          >
            {showDay && (
              <h3 className="timeline-day">
                <time dateTime={group.day}>
                  {new Intl.DateTimeFormat(undefined, {
                    timeZone: "UTC",
                    weekday: "short",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  }).format(group.entries[0]!.accepted_at)}
                </time>
              </h3>
            )}
            <div className="timeline-session">
              <span>
                {group.session ? (
                  <>
                    Session{" "}
                    {kind === "session" ? (
                      "context"
                    ) : (
                      <EntityLink kind="session" id={group.session} />
                    )}
                  </>
                ) : (
                  "No session recorded"
                )}
              </span>
              {kind !== "client" && clients.length === 1 && clients[0] && (
                <span>
                  Client <EntityLink kind="client" id={clients[0]} />
                </span>
              )}
            </div>
            <ol className="subject-records">
              {group.entries.map((entry) => (
                <TimelineRow
                  key={`${entry.kind}:${entry.id}`}
                  entry={entry}
                  kind={kind}
                />
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function TimelineCoverage({ value }: { value: SubjectTimeline }) {
  return (
    <details className="timeline-coverage">
      <summary>About this history</summary>
      <p>
        Activity recorded directly for this{" "}
        {value.scope.kind === "ip" ? "IP address" : value.scope.kind}. Related
        subjects have their own history. Session groups contain only the records
        on this page.
      </p>
      <p>
        Accepted time orders these records. An event’s occurrence time is
        supplied separately by its source.
      </p>
      <p>
        History observed <Time at={value.as_of} />. Each page reads the latest
        delivered state; later delivery, verification or retention can change
        subsequent pages.
      </p>
      <p>
        Requested <Time at={value.range.from} /> to <Time at={value.range.to} />
        .{" "}
        {value.range.effective_from === null ? (
          "This interval has no observable retained coverage."
        ) : (
          <>
            Available from <Time at={value.range.effective_from} /> to{" "}
            <Time at={value.range.effective_to} />.
          </>
        )}
      </p>
      <p>
        {countLabel(value.delivery.pending_records)} records await delivery
        across the installation, observed{" "}
        <Time at={value.delivery.observed_at} />.{" "}
        {value.delivery.oldest_record_accepted_at !== null && (
          <>
            The oldest queued record was originally accepted{" "}
            <Time at={value.delivery.oldest_record_accepted_at} />.{" "}
          </>
        )}
        This is not a completeness watermark or a measure of this subject’s
        queue.
      </p>
      {value.retention.applying && (
        <p>
          Retention is changing from {value.retention.days} to{" "}
          {value.retention.requested_days} days.
        </p>
      )}
    </details>
  );
}

function ContextFacts({
  value,
  kind,
}: {
  value: SubjectContext;
  kind: string;
}) {
  const metrics = Object.fromEntries(
    Object.entries(value.metrics).filter(
      ([name]) =>
        name.startsWith(`${kind}.`) ||
        (kind === "session" && name.startsWith("browser.")),
    ),
  );
  const facts = Object.entries(value.metadata)
    .filter(
      ([, value]) =>
        value === null ||
        ["string", "number", "boolean"].includes(typeof value),
    )
    .slice(0, 8);
  return (
    <>
      <p className="help">
        First observed <Time at={value.first_seen} compact />.
      </p>
      {facts.length > 0 && (
        <dl className="profile-facts">
          {facts.map(([key, item]) => (
            <div key={key}>
              <dt translate="no">{key}</dt>
              <dd>{item === null ? "Not provided" : String(item)}</dd>
            </div>
          ))}
        </dl>
      )}
      {Object.keys(metrics).length > 0 && (
        <section>
          <h3>Current metrics</h3>
          <MetricValues metrics={metrics} />
          <p className="help">
            Sampled <Time at={value.observed_at} compact />. Past decisions keep
            the values captured at evaluation.
          </p>
        </section>
      )}
      {Object.keys(value.metadata).length > facts.length && (
        <JsonDetails title="All current metadata" value={value.metadata} />
      )}
    </>
  );
}

export function EntityPage() {
  const kind = useAddressedParam("kind"),
    id = useAddressedParam("id");
  const { params, setParams, ready, error } = useSubjectWindow(kind, id);
  const origin = useActivityOrigin();
  const [formError, setFormError] = useState<string | null>(null);
  const timelineHeading = useRef<HTMLHeadingElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const previousCursor = useRef(params.get("cursor"));
  const validateContext = useCallback(
    (value: unknown): value is SubjectContext => validContext(value, kind, id),
    [kind, id],
  );
  const context = useResource<SubjectContext>(
    !error ? entityPath(kind, id, "/context") : null,
    validateContext,
  );
  const from = Number(params.get("from")),
    to = Number(params.get("to")),
    cursor = params.get("cursor");
  const validateHistory = useCallback(
    (value: unknown): value is SubjectTimeline =>
      validTimeline(value, kind, id, from, to, cursor),
    [kind, id, from, to, cursor],
  );
  const query = new URLSearchParams({
    from: String(from),
    to: String(to),
    limit: String(pageSize),
  });
  if (cursor) query.set("cursor", cursor);
  const history = useResource<SubjectTimeline>(
    ready ? `${entityPath(kind, id, "/timeline")}&${query}` : null,
    validateHistory,
  );
  const trendKind = params.get("trend") === "events" ? "event" : "decision";
  const analyticsScope = ready
    ? new URLSearchParams({
        entity: id,
        entity_kind: kind,
        from: String(from),
        to: String(to),
      })
    : new URLSearchParams();
  const analytics = useAnalytics(analyticsScope, trendKind);
  useEffect(() => {
    if (previousCursor.current !== cursor) timelineHeading.current?.focus();
    previousCursor.current = cursor;
  }, [cursor]);
  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);
  function applyInterval(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const interval = formWindow(
        new FormData(event.currentTarget),
        params,
        Date.now(),
      );
      if (
        Number(interval.get("to")) - Number(interval.get("from")) >=
        maximumInterval
      )
        throw new Error("Choose an interval of at most 31 days.");
      const next = new URLSearchParams(params);
      for (const key of ["from", "to", "range", "cursor"]) next.delete(key);
      for (const [key, value] of interval) next.set(key, value);
      setFormError(null);
      setParams(next);
    } catch (cause) {
      setFormError((cause as Error).message);
    }
  }
  const pageLink = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes))
      value === null ? next.delete(key) : next.set(key, value);
    // Canonical query addressing also keeps legacy path links usable after a pivot.
    next.set("kind", kind);
    next.set("id", id);
    return `/inspect/entity?${next}`;
  };
  if (error)
    return (
      <div className="subject-page">
        <div className="profile-return">
          <ActivityReturn />
        </div>
        <h1>Subject profile</h1>
        <Notice>
          <p>{error}</p>
          {!profileScopeError(new URLSearchParams({ kind, id }), kind, id) ? (
            <Link
              to={`${entityUrl(kind, id)}${origin ? `&return_to=${encode(origin)}&range=168&from=${Math.max(0, Date.now() - 7 * 86_400_000)}&to=${Date.now()}` : ""}`}
            >
              Reset profile
            </Link>
          ) : (
            <Link to="/">Find a subject from Overview</Link>
          )}
        </Notice>
      </div>
    );
  return (
    <div className="subject-page">
      <div className="profile-return">
        <ActivityReturn />
        <a className="mobile-context-link" href="#profile-current-context">
          Current context ↓
        </a>
      </div>
      <div className="profile-toolbar">
        <header className="profile-heading">
          <div>
            <p className="profile-kind">{subjectLabel(kind)}</p>
            <h1 translate="no" className="identifier">
              {id}
            </h1>
          </div>
          <button
            disabled={!ready || history.loading || analytics.loading}
            onClick={() => {
              const next = refreshedWindow(params, Date.now());
              if (next.toString() !== params.toString()) setParams(next);
              else {
                void history.refresh();
                void analytics.refresh();
              }
            }}
          >
            Refresh activity
          </button>
        </header>
        <form
          className="profile-range"
          key={`${params.get("from")}:${params.get("to")}:${params.get("range")}`}
          onSubmit={applyInterval}
        >
          <ActivityRange params={params} />
          <button type="submit">Apply interval</button>
          {ready && to - from < 30 * 86_400_000 && (
            <Link
              className="subtle-link"
              to={pageLink({
                from: String(Math.max(0, to - 30 * 86_400_000)),
                to: String(to),
                range: null,
                cursor: null,
              })}
            >
              Widen to 30 days
            </Link>
          )}
        </form>
      </div>
      {formError && (
        <p className="error" ref={formErrorRef} tabIndex={-1} role="alert">
          {formError}
        </p>
      )}
      <div className="profile-layout">
        <div className="profile-history">
          <section
            aria-label="Subject activity trend"
            className="profile-trend"
          >
            <nav className="profile-trend-switch" aria-label="Trend">
              <Link
                to={pageLink({ trend: "decisions" })}
                aria-current={trendKind === "decision" ? "page" : undefined}
              >
                Checks
              </Link>
              <Link
                to={pageLink({ trend: "events" })}
                aria-current={trendKind === "event" ? "page" : undefined}
              >
                Events
              </Link>
            </nav>
            <ResourceError resource={analytics} />
            {analytics.data ? (
              <>
                {analytics.data.totals ? (
                  <ActivityChart
                    value={analytics.data}
                    compact
                    intervalHref={(from, to) =>
                      pageLink({
                        from: String(from),
                        to: String(to),
                        range: null,
                        cursor: null,
                      })
                    }
                  />
                ) : (
                  <p className="empty-inline">
                    No retained trend coverage for this interval.
                  </p>
                )}
                <AnalyticsCoverage value={analytics.data} compact />
              </>
            ) : analytics.loading ? (
              <p role="status" className="muted">
                Loading subject trend…
              </p>
            ) : null}
          </section>
          <section aria-labelledby="subject-history-heading">
            <div className="section-heading">
              <h2
                id="subject-history-heading"
                ref={timelineHeading}
                tabIndex={-1}
              >
                Activity
              </h2>
              <span className="help">
                Direct history · Newest accepted first · UTC
              </span>
            </div>
            <ResourceError resource={history} />
            {history.data ? (
              <>
                {history.data.range.effective_from !== null &&
                  history.data.range.effective_from > from && (
                    <Notice>
                      Earlier history is outside retained coverage. Records
                      begin <Time at={history.data.range.effective_from} />.
                    </Notice>
                  )}
                <Timeline
                  value={history.data}
                  kind={kind}
                  currentPage={Boolean(cursor)}
                />
                <nav className="actions pagination" aria-label="Timeline pages">
                  {cursor && (
                    <Link to={pageLink({ cursor: null })}>Newest records</Link>
                  )}
                  {history.data.next_cursor && (
                    <Link
                      className="button"
                      to={pageLink({ cursor: history.data.next_cursor })}
                    >
                      Older records →
                    </Link>
                  )}
                </nav>
                <TimelineCoverage value={history.data} />
              </>
            ) : history.loading ? (
              <Loading />
            ) : (
              <p className="help">
                History could not be loaded. Current context and relationships
                remain available.
              </p>
            )}
          </section>
        </div>
        <aside
          id="profile-current-context"
          className="profile-context"
          aria-label="Current subject context"
        >
          <section aria-labelledby="profile-context-heading">
            <div className="section-heading">
              <h2 id="profile-context-heading">Current context</h2>
              <button
                disabled={context.loading}
                onClick={() => void context.refresh()}
              >
                Refresh context
              </button>
            </div>
            <ResourceError resource={context} />
            {context.data ? (
              <ContextFacts value={context.data} kind={kind} />
            ) : context.loading ? (
              <Loading />
            ) : (
              <p className="help">
                Current context is unavailable. Retained directly attributed
                history can still be inspected.
              </p>
            )}
          </section>
          <Relationships
            key={`${kind}:${id}`}
            kind={kind}
            id={id}
            refreshEntity={context.refresh}
          />
        </aside>
      </div>
    </div>
  );
}
