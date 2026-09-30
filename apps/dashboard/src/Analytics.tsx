import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import {
  activityLink,
  analyticsPath,
  countLabel,
  dimensions,
  exactUtc,
  reasonName,
  series,
  validAnalytics,
} from "./activity-analytics";
import type { ActivityAnalytics, ActivityKind } from "./activity-analytics";
import { Notice, ResourceError, Time, useResource } from "./shared";

export function useAnalytics(params: URLSearchParams, kind: ActivityKind) {
  const path = analyticsPath(params, kind);
  const validate = useCallback(
    (value: unknown): value is ActivityAnalytics => {
      if (!validAnalytics(value) || !path) return false;
      const requested = new URLSearchParams(path.split("?")[1]);
      return (
        value.scope.kind === kind &&
        value.range.from === Number(requested.get("from")) &&
        value.range.to === Number(requested.get("to")) &&
        dimensions.every((key) => value.scope[key] === requested.get(key))
      );
    },
    [path, kind],
  );
  return useResource<ActivityAnalytics>(path, validate);
}

function seriesTarget(
  value: ActivityAnalytics,
  scope: URLSearchParams,
  filter: string | null,
  changes: Record<string, number> = {},
) {
  const key = value.scope.kind === "decision" ? "outcome" : "provenance";
  if (
    filter === null ||
    (value.scope[key] !== null && value.scope[key] !== filter)
  )
    return null;
  return activityLink(scope, value.scope.kind, { ...changes, [key]: filter });
}

function observedScope(value: ActivityAnalytics) {
  const query = new URLSearchParams();
  for (const key of dimensions)
    if (value.scope[key] !== null) query.set(key, value.scope[key]!);
  query.set("from", String(value.range.effective_from ?? value.range.from));
  query.set("to", String(value.range.effective_to ?? value.range.to));
  return query;
}

const utc = (time: number) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(time);
const hour = (time: number) =>
  new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(time);

export function AnalyticsSummary({ value }: { value: ActivityAnalytics }) {
  if (!value.totals) return null;
  const scope = observedScope(value);
  const kind = value.scope.kind;
  const totals = value.totals;
  return (
    <dl className="analytics-summary">
      <div>
        <dt>{kind === "decision" ? "Check attempts" : "Accepted events"}</dt>
        <dd>
          <Link to={activityLink(scope, kind)}>{countLabel(totals.total)}</Link>
        </dd>
        <span className="help">
          {kind === "decision"
            ? "Each recorded check, counted once"
            : "Backend and client context"}
        </span>
      </div>
      {series(kind)
        .filter((item) => item.key !== "unknown" || totals.unknown! > 0)
        .map((item) => (
          <div key={item.key} className={`summary-${item.key}`}>
            <dt>
              <span className={`series-dot series-${item.key}`} />
              {item.label}
            </dt>
            <dd>
              {seriesTarget(value, scope, item.filter) ? (
                <Link to={seriesTarget(value, scope, item.filter)!}>
                  {countLabel(totals[item.key]!)}
                </Link>
              ) : (
                countLabel(totals[item.key]!)
              )}
            </dd>
            <span className="help">
              {item.key === "awaiting_verification"
                ? "Still awaiting a recorded result"
                : totals.total
                ? `${new Intl.NumberFormat(undefined, {
                    maximumFractionDigits: 1,
                  }).format(
                    (totals[item.key]! / totals.total) * 100,
                  )}% of this selection`
                : "No records in this selection"}
            </span>
          </div>
        ))}
    </dl>
  );
}

function useNarrowChart() {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 600px)").matches ?? false,
  );
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 600px)");
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function ActivityChart({
  value,
  compact = false,
}: {
  value: ActivityAnalytics;
  compact?: boolean;
}) {
  const id = useId();
  const narrow = useNarrowChart();
  if (!value.totals) return null;
  const keys = series(value.scope.kind);
  const scope = observedScope(value);
  const maximum =
    Math.ceil(
      Math.max(2, ...value.buckets.map((bucket) => bucket.counts.total)) / 2,
    ) * 2;
  const width = narrow ? 400 : 1000,
    height = compact ? (narrow ? 85 : 50) : 160,
    left = narrow ? 30 : 45,
    right = 14;
  const plotWidth = width - left - right;
  const step = plotWidth / value.buckets.length;
  const gap = Math.min(2, step * 0.18);
  const bucketLabel =
    value.range.bucket_ms < 3_600_000
      ? `${value.range.bucket_ms / 60_000} minutes`
      : value.range.bucket_ms < 86_400_000
      ? `${value.range.bucket_ms / 3_600_000} hour`
      : `${value.range.bucket_ms / 86_400_000} day`;
  const dayScale = value.range.bucket_ms >= 86_400_000;
  return (
    <section
      className={`activity-chart${compact ? " compact-chart" : ""}`}
      aria-labelledby={`${id}-heading`}
    >
      <div className="section-heading">
        <div>
          <h2 id={`${id}-heading`}>
            {value.scope.kind === "decision"
              ? "Decisions over time"
              : "Events over time"}
          </h2>
          <p className="help">Accepted time · UTC · {bucketLabel} intervals</p>
        </div>
        <Link
          className="subtle-link"
          to={activityLink(scope, value.scope.kind)}
        >
          View records →
        </Link>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height + 50}`}
        className="timeline-chart"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>
          {value.scope.kind === "decision" ? "Decisions" : "Events"} by accepted
          time
        </title>
        <desc id={`${id}-description`}>
          {countLabel(value.totals.total)} records in {value.buckets.length}{" "}
          intervals. Exact values and keyboard-accessible links are in the table
          below.
        </desc>
        {[0, 0.5, 1].map((fraction) => (
          <g key={fraction} className="chart-grid">
            <line
              x1={left}
              x2={width - right}
              y1={height + 10 - fraction * height}
              y2={height + 10 - fraction * height}
            />
            <text
              x={left - 10}
              y={height + 14 - fraction * height}
              textAnchor="end"
            >
              {countLabel(Math.round(maximum * fraction))}
            </text>
          </g>
        ))}
        {value.buckets.map((bucket, index) => {
          let used = 0;
          return (
            <g key={bucket.from}>
              {keys.map((item) => {
                const size = (bucket.counts[item.key]! / maximum) * height;
                used += size;
                return (
                  <rect
                    key={item.key}
                    className={`series-${item.key}`}
                    x={left + index * step + gap / 2}
                    y={height + 10 - used}
                    width={Math.max(0.5, step - gap)}
                    height={size}
                  />
                );
              })}
              <a
                href={activityLink(scope, value.scope.kind, {
                  from: bucket.from,
                  to: bucket.to,
                })}
                tabIndex={-1}
                aria-hidden="true"
              >
                <rect
                  className="bucket-hit"
                  x={left + index * step}
                  y={10}
                  width={step}
                  height={height}
                />
                <title>
                  {exactUtc(bucket.from)} – {exactUtc(bucket.to)}:{" "}
                  {countLabel(bucket.counts.total)} records
                </title>
              </a>
            </g>
          );
        })}
        {[
          0,
          Math.floor((value.buckets.length - 1) / 2),
          value.buckets.length - 1,
        ]
          .filter((item, i, all) => all.indexOf(item) === i)
          .map((index) => (
            <text
              className={`chart-axis${
                index > 0 && index < value.buckets.length - 1
                  ? " chart-axis-middle"
                  : ""
              }`}
              key={index}
              x={left + index * step + step / 2}
              y={height + 35}
              textAnchor={
                index === 0
                  ? "start"
                  : index === value.buckets.length - 1
                  ? "end"
                  : "middle"
              }
            >
              {dayScale
                ? utc(value.buckets[index]!.from)
                : `${utc(value.buckets[index]!.from)} · ${hour(
                    value.buckets[index]!.from,
                  )}`}
            </text>
          ))}
      </svg>
      <div className="chart-controls">
        <div className="chart-legend" aria-label="Filter by series">
          {keys
            .filter(
              (item) => item.key !== "unknown" || value.totals!.unknown! > 0,
            )
            .map((item) => (
              <span key={item.key}>
                <span className={`series-dot series-${item.key}`} />
                {seriesTarget(value, scope, item.filter) ? (
                  <Link to={seriesTarget(value, scope, item.filter)!}>
                    {item.label}
                  </Link>
                ) : (
                  item.label
                )}
                <span className="legend-count">
                  {countLabel(value.totals![item.key]!)}
                </span>
              </span>
            ))}
        </div>
        <details className="chart-data">
          <summary>View chart data and intervals</summary>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">
                Exact inclusive intervals in UTC. Each link opens that interval.
              </caption>
              <thead>
                <tr>
                  <th>Interval · UTC</th>
                  <th>Total</th>
                  {keys.map((item) => (
                    <th key={item.key}>{item.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.buckets.map((bucket) => (
                  <tr key={bucket.from}>
                    <td>
                      <Link
                        to={activityLink(scope, value.scope.kind, {
                          from: bucket.from,
                          to: bucket.to,
                        })}
                      >
                        {exactUtc(bucket.from)} – {exactUtc(bucket.to)}
                      </Link>
                    </td>
                    <td>{countLabel(bucket.counts.total)}</td>
                    {keys.map((item) => (
                      <td key={item.key}>
                        {seriesTarget(value, scope, item.filter) ? (
                          <Link
                            aria-label={`${item.label}: ${
                              bucket.counts[item.key]
                            } in interval ${exactUtc(
                              bucket.from,
                            )} through ${exactUtc(bucket.to)}`}
                            to={
                              seriesTarget(value, scope, item.filter, {
                                from: bucket.from,
                                to: bucket.to,
                              })!
                            }
                          >
                            {countLabel(bucket.counts[item.key]!)}
                          </Link>
                        ) : (
                          countLabel(bucket.counts[item.key]!)
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}

export function AnalyticsBreakdowns({ value }: { value: ActivityAnalytics }) {
  if (!value.totals || value.scope.kind !== "decision") return null;
  const scope = observedScope(value);
  return (
    <div className="analytics-breakdowns">
      {["checks", "reasons"].map((dimension) => {
        const breakdown = value.breakdowns[dimension]!;
        return (
          <section key={dimension}>
            <div className="section-heading">
              <h2>
                {dimension === "checks"
                  ? "Protected actions"
                  : "Recorded reasons"}
              </h2>
              <span className="help">Attempts</span>
            </div>
            {breakdown.items.length ? (
              <ol className="ranked-list">
                {breakdown.items.map((item) => (
                  <li key={item.value ?? "\u0000"}>
                    <div className="ranked-row">
                      {item.value === null ? (
                        <span className="muted">Not recorded</span>
                      ) : (
                        <Link
                          translate={dimension === "checks" ? "no" : undefined}
                          to={activityLink(scope, "decision", {
                            [dimension === "checks" ? "check" : "reason"]:
                              item.value,
                          })}
                        >
                          {dimension === "checks"
                            ? item.value
                            : reasonName(item.value)}
                        </Link>
                      )}
                      <strong>{countLabel(item.count)}</strong>
                    </div>
                    <div className="ranked-track" aria-hidden="true">
                      <span
                        style={{
                          width: `${
                            value.totals!.total
                              ? (item.count / value.totals!.total) * 100
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-inline">
                No recorded activity in this interval.
              </p>
            )}
            {breakdown.other_count > 0 && (
              <p className="help">
                Other {dimension}: {countLabel(breakdown.other_count)} attempts.
                Open Activity to refine the selection.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function AnalyticsCoverage({
  value,
  compact = false,
}: {
  value: ActivityAnalytics;
  compact?: boolean;
}) {
  const clipped =
    value.range.effective_from !== null &&
    value.range.effective_from > value.range.from;
  return (
    <div className={`analytics-coverage${compact ? " compact-coverage" : ""}`}>
      {clipped && (
        <Notice>
          Earlier records are outside retained coverage. Totals begin{" "}
          <Time at={value.range.effective_from} />.
        </Notice>
      )}
      {!compact && (
        <p className="help">
          History observed <Time at={value.as_of} />. Records arrive
          asynchronously.
        </p>
      )}
      <details>
        <summary>
          {compact
            ? "Data coverage · records arrive asynchronously"
            : "Data coverage and delivery"}
        </summary>
        {compact && (
          <p>
            History observed <Time at={value.as_of} />.
          </p>
        )}
        <p>
          Requested <Time at={value.range.from} /> to{" "}
          <Time at={value.range.to} />.
        </p>
        {value.totals ? (
          <p>
            Available interval: <Time at={value.range.effective_from} /> to{" "}
            <Time at={value.range.effective_to} />. Counts use each record’s
            latest state, grouped by its original accepted time. Later
            verification can change earlier intervals.
          </p>
        ) : (
          <p>
            This range does not intersect observable retained history. It is not
            a zero-traffic result.
          </p>
        )}
        <p>
          {countLabel(value.delivery.pending_records)} history records waiting
          across this installation, observed{" "}
          <Time at={value.delivery.observed_at} />.
          {value.delivery.oldest_record_accepted_at !== null && (
            <>
              {" "}
              The oldest queued record was originally accepted{" "}
              <Time at={value.delivery.oldest_record_accepted_at} />.
            </>
          )}
        </p>
        <p className="help">
          This queue is installation-wide, not specific to these filters.
          Acceptance time is not queue age. An empty queue does not prove
          complete history. Charts and record lists are separate queries, so
          recent delivery or verification can change their results.
        </p>
        {value.retention.applying && (
          <p className="help">
            Retention is being changed from {value.retention.days} to{" "}
            {value.retention.requested_days} days.
          </p>
        )}
      </details>
    </div>
  );
}

export function AnalyticsPanel({
  resource,
  summaries = false,
  breakdowns = false,
  compact = false,
}: {
  resource: ReturnType<typeof useAnalytics>;
  summaries?: boolean;
  breakdowns?: boolean;
  compact?: boolean;
}) {
  return (
    <>
      <ResourceError resource={resource} />
      {resource.data ? (
        <>
          {resource.data.totals ? (
            <>
              {summaries && <AnalyticsSummary value={resource.data} />}
              <ActivityChart value={resource.data} compact={compact} />
              {breakdowns && <AnalyticsBreakdowns value={resource.data} />}
            </>
          ) : (
            <div className="empty-inline">
              <h2>History isn’t available for this period.</h2>
              <p>Choose a more recent interval to see retained records.</p>
            </div>
          )}
          <AnalyticsCoverage value={resource.data} compact={compact} />
        </>
      ) : resource.loading ? (
        <div className="chart-loading" role="status">
          Loading activity trends…
        </div>
      ) : null}
    </>
  );
}
