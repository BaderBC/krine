import { Time } from "./shared";
import type { HistoryRetention } from "./types";

export function validRetention(value: unknown): value is HistoryRetention {
  if (!value || typeof value !== "object") return false;
  const item = value as HistoryRetention;
  return (
    [item.days, item.requested_days].every(
      (days) => Number.isSafeInteger(days) && days >= 2 && days <= 3650,
    ) &&
    typeof item.applying === "boolean" &&
    (item.applying
      ? item.requested_days > item.days
      : item.requested_days === item.days) &&
    Number.isSafeInteger(item.available_since) &&
    item.available_since >= 0 &&
    item.available_since <= 8.64e15
  );
}
export function Retention({
  value,
  compact = false,
}: {
  value: unknown;
  compact?: boolean;
}) {
  if (!validRetention(value))
    return (
      <p className="help">History retention information could not be read.</p>
    );
  return compact ? (
    <p className="help">
      The effective history window is {value.days} days. Records before{" "}
      <Time at={value.available_since} /> have expired; gaps may remain within
      this window.
      {value.applying &&
        ` An extension to ${value.requested_days} days is still applying.`}
    </p>
  ) : (
    <>
      <dl className="facts">
        <div>
          <dt>Effective window</dt>
          <dd>{value.days} days</dd>
        </div>
        <div>
          <dt>Requested window</dt>
          <dd>
            {value.requested_days} days
            {value.applying ? " · Applying" : " · Effective"}
          </dd>
        </div>
        <div>
          <dt>Expiry boundary</dt>
          <dd>
            <Time at={value.available_since} />
          </dd>
        </div>
      </dl>
      <p className="help">
        Records before this boundary have expired. This window does not promise
        uninterrupted coverage. Increasing retention cannot restore expired
        records. Activity visibility follows asynchronous export.
      </p>
      <p className="help">
        Retention is configured in the deployment. Metric windows, retry
        protection and relationship audit have their own retention rules.
      </p>
    </>
  );
}
