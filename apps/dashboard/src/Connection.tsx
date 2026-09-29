import { useCallback } from "react";
import { eventUrl } from "./addresses";
import { encode } from "./api";
import { InvestigationLink as Link } from "./navigation";
import { Loading, Notice, Time, useResource } from "./shared";
import { Retention } from "./Retention";
import type { ConnectionObservations, Receipt } from "./types";

type Response = {
  observations: ConnectionObservations;
  history_retention?: unknown;
};
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  (value as number) <= 8.64e15;
function receipt(
  value: unknown,
  kind: "event" | "decision",
): value is Receipt | null {
  if (value === null) return true;
  return (
    object(value) &&
    timestamp(value.received_at) &&
    typeof value.basis === "string" &&
    ["tracked", "retained_history"].includes(value.basis) &&
    object(value.record) &&
    value.record.kind === kind &&
    typeof value.record.id === "string" &&
    /^[a-zA-Z0-9_.:-]{1,128}$/.test(value.record.id) &&
    typeof value.record.availability === "string" &&
    ["available", "pending", "not_retained", "unavailable"].includes(
      value.record.availability,
    ) &&
    (kind === "decision" || value.record.availability !== "pending")
  );
}
export function validConnection(
  value: unknown,
  check: string | null,
): value is Response {
  if (!object(value) || !object(value.observations)) return false;
  const observed = value.observations;
  return (
    observed.check === check &&
    timestamp(observed.tracked_since) &&
    receipt(observed.client_evidence, "event") &&
    receipt(observed.backend_event, "event") &&
    receipt(observed.check_attempt, "decision") &&
    (check !== null || observed.check_attempt === null)
  );
}
function ReceiptValue({ value }: { value: Receipt | null }) {
  if (value === null) return <>No receipt recorded in this coverage.</>;
  const href =
    value.record.kind === "event"
      ? eventUrl(value.record.id)
      : `/activity/decisions/${encode(value.record.id)}`;
  return (
    <>
      <Time at={value.received_at} />
      {value.record.availability === "available" ? (
        <>
          {" "}
          · <Link to={href}>View received {value.record.kind}</Link>
        </>
      ) : (
        <span className="muted">
          {" "}
          ·{" "}
          {
            {
              pending: "Evaluation pending",
              not_retained: "Record no longer retained",
              unavailable: "Record availability could not be confirmed",
            }[value.record.availability]
          }
        </span>
      )}
      <span className="receipt-basis">
        {value.basis === "retained_history"
          ? "Earliest surviving receipt at upgrade; earlier history may be missing."
          : "First receipt since tracking began."}
      </span>
    </>
  );
}
function ReadFailure({
  resource,
  label,
}: {
  resource: ReturnType<typeof useResource<Response>>;
  label: string;
}) {
  return resource.error ? (
    <Notice>
      {label}: {resource.error}
      {resource.data && (
        <p className="help">
          Showing the last successful receipt read from{" "}
          <Time at={resource.refreshed} />.
        </p>
      )}
    </Notice>
  ) : null;
}
const validGlobal = (value: unknown): value is Response =>
  validConnection(value, null);
export function Connection({
  check,
  invalidSelection,
}: {
  check: string | null;
  invalidSelection: boolean;
}) {
  // Receipt reads never replace credential setup or own a revealed secret.
  const global = useResource<Response>("/setup", validGlobal);
  const validateSelected = useCallback(
    (value: unknown): value is Response => validConnection(value, check),
    [check],
  );
  const selected = useResource<Response>(
    check ? `/setup?${new URLSearchParams({ check })}` : null,
    validateSelected,
  );
  const observations = global.data?.observations;
  const busy = global.loading || selected.loading;
  return (
    <section
      className="connection-observations"
      aria-labelledby="received-evidence-heading"
    >
      <div className="relationship-heading">
        <h3 id="received-evidence-heading">Received by Krine</h3>
        <button
          disabled={busy}
          onClick={() => {
            void global.refresh();
            if (check) void selected.refresh();
          }}
        >
          {busy ? "Refreshing receipts…" : "Refresh receipts"}
        </button>
      </div>
      <p className="help">
        Client evidence and backend events are installation-wide. Receipts
        confirm acceptance by Krine, not enforcement by your application.
        Activity lists may appear later.
      </p>
      <ReadFailure
        resource={global}
        label="Installation receipts could not be read"
      />
      <dl className="receipt-list">
        {observations && (
          <>
            <div>
              <dt>Client evidence</dt>
              <dd>
                <ReceiptValue value={observations.client_evidence} />
              </dd>
            </div>
            <div>
              <dt>Backend event</dt>
              <dd>
                <ReceiptValue value={observations.backend_event} />
              </dd>
            </div>
          </>
        )}
        {check && (
          <div className="check-receipt">
            <dt>
              Check attempt
              <span className="receipt-basis">
                Only <span translate="no">{check}</span>
              </span>
            </dt>
            <dd>
              <ReadFailure
                resource={selected}
                label={`Attempt receipt for ${check} could not be read`}
              />
              {selected.data ? (
                <>
                  <ReceiptValue
                    value={selected.data.observations.check_attempt}
                  />
                  {selected.data.observations.tracked_since !==
                    observations?.tracked_since && (
                    <p className="help">
                      Tracking began{" "}
                      <Time at={selected.data.observations.tracked_since} />.
                    </p>
                  )}
                </>
              ) : selected.loading ? (
                <Loading />
              ) : null}
            </dd>
          </div>
        )}
      </dl>
      {observations ? (
        <p className="help">
          Receipt tracking began <Time at={observations.tracked_since} />. No
          receipt means none is known within this coverage.
        </p>
      ) : global.loading ? (
        <Loading />
      ) : null}
      {invalidSelection ? (
        <Notice>
          Choose one valid check from its Integration link to inspect its
          attempt receipt.
        </Notice>
      ) : (
        !check && (
          <p className="help">
            Open a check’s Integration link to inspect its attempt receipt. The
            snippet’s example name does not select a check.
          </p>
        )
      )}
      <details className="retention-details">
        <summary>History retention</summary>
        {global.data ? (
          <Retention value={global.data.history_retention} />
        ) : (
          <p className="help">
            Refresh receipts to read this deployment’s history retention.
          </p>
        )}
      </details>
    </section>
  );
}
