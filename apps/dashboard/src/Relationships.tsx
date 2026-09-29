import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useBeforeUnload, useBlocker, useSearchParams } from "react-router-dom";
import { entityPath, entityUrl, eventUrl, uniqueSelector } from "./addresses";
import { encode } from "./api";
import { InvestigationLink as Link } from "./navigation";
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
  RelationshipForm,
  relationshipPath,
  validReason,
  validRelationshipDetail,
  validRelationships,
  validRelationshipSummary,
} from "./relationship-form";
import type { RelationshipAction } from "./relationship-form";
import type {
  DecisionDetail,
  Page,
  Relationship,
  RelationshipDetail,
  RelationshipSummary,
} from "./types";

const sourceLabel = (source: string) =>
  ({
    backend: "Backend assertion",
    browser_observation: "Browser observation",
    "browser.context": "Browser context",
    "browser.proof": "Action proof",
    legacy: "Legacy observation",
  })[source] ?? source;
export function relationshipUrl(
  item: Pick<RelationshipSummary, "client_id" | "kind" | "id">,
) {
  return `${entityUrl("client", item.client_id)}&relationship_kind=${item.kind}&relationship_id=${encode(item.id)}#relationships`;
}
function Endpoints({ item }: { item: RelationshipSummary }) {
  return (
    <dl className="facts relationship-endpoints">
      <div>
        <dt>Client</dt>
        <dd>
          <EntityLink kind="client" id={item.client_id} />
        </dd>
      </div>
      <div>
        <dt>{item.kind === "backend" ? "User" : "Observed IP"}</dt>
        <dd>
          <EntityLink
            kind={item.kind === "backend" ? "user" : "ip"}
            id={item.user_id ?? item.ip}
          />
        </dd>
      </div>
      <div>
        <dt>Session</dt>
        <dd>
          {item.session_id ? (
            <EntityLink kind="session" id={item.session_id} />
          ) : (
            "Not recorded"
          )}
        </dd>
      </div>
    </dl>
  );
}
function Provenance({ item }: { item: RelationshipSummary }) {
  return (
    <dl className="facts relationship-provenance">
      <div>
        <dt>Evidence</dt>
        <dd>
          {sourceLabel(item.source)} ·{" "}
          {item.revoked_at === null ? "Active" : "Corrected"} · Revision{" "}
          {item.revision}
        </dd>
      </div>
      <div>
        <dt>First seen</dt>
        <dd>
          <Time at={item.first_seen} /> · {sourceLabel(item.first_source)}
        </dd>
      </div>
      <div>
        <dt>Last seen</dt>
        <dd>
          <Time at={item.last_seen} /> · {sourceLabel(item.last_source)}
        </dd>
      </div>
      <div>
        <dt>First credential</dt>
        <dd className="identifier">{item.credential_id ?? "Not recorded"}</dd>
      </div>
      {item.last_credential_id !== item.credential_id && (
        <div>
          <dt>Last credential</dt>
          <dd className="identifier">
            {item.last_credential_id ?? "Not recorded"}
          </dd>
        </div>
      )}
      {item.kind === "observed_ip" && (
        <>
          <div>
            <dt>First context event</dt>
            <dd>
              {item.first_event_id ? (
                <Link to={eventUrl(item.first_event_id)}>
                  {item.first_event_id}
                </Link>
              ) : (
                "Not recorded"
              )}
            </dd>
          </div>
          {item.last_event_id !== item.first_event_id && (
            <div>
              <dt>Last context event</dt>
              <dd>
                {item.last_event_id ? (
                  <Link to={eventUrl(item.last_event_id)}>
                    {item.last_event_id}
                  </Link>
                ) : (
                  "Not recorded"
                )}
              </dd>
            </div>
          )}
        </>
      )}
      <div>
        <dt>Relationship ID</dt>
        <dd className="identifier">{item.id}</dd>
      </div>
      {item.revoked_at !== null && (
        <>
          <div>
            <dt>Corrected</dt>
            <dd>
              <Time at={item.revoked_at} /> ·{" "}
              {item.revoked_by ?? "Actor not recorded"}
            </dd>
          </div>
          <div>
            <dt>Reason</dt>
            <dd>{item.revocation_reason ?? "Not recorded"}</dd>
          </div>
        </>
      )}
    </dl>
  );
}
function Scope({
  item,
  action,
}: {
  item: RelationshipSummary;
  action: RelationshipAction;
}) {
  return (
    <p className="help">
      {item.kind === "backend"
        ? action === "correct"
          ? "Invalidate only this backend assertion. Other active assertions can still connect this client and user. Current relationship metrics will use the remaining evidence."
          : "Restore this original backend assertion and its original timestamp. It affects the 30-day metrics only while that timestamp remains in the window."
        : action === "correct"
          ? "Invalidate only this observed segment through the reviewed last-seen time. New browser observations can create a new active segment. Backend event counts and proof bindings do not change."
          : "Restore this original observed segment. Restoration will be rejected if a newer active segment connects the same client, session and IP."}{" "}
      Past decisions and their captured evidence remain unchanged.
    </p>
  );
}

export function CapturedRelationships({ record }: { record: DecisionDetail }) {
  const context = record.relationship_context;
  if (!context)
    return record.relationship_ids?.length ? (
      <p className="help">
        Legacy relationship references: {record.relationship_ids.join(", ")}.
        Relationship summaries and the complete count were not captured for this
        decision.
      </p>
    ) : null;
  if (
    !Array.isArray(context.items) ||
    context.items.length > 100 ||
    !context.items.every(validRelationshipSummary) ||
    !Number.isSafeInteger(context.total) ||
    context.total < context.items.length ||
    typeof context.truncated !== "boolean" ||
    context.truncated !== context.total > context.items.length ||
    !Number.isSafeInteger(context.observed_at) ||
    (context.observed_ip !== null &&
      !validRelationshipSummary(context.observed_ip))
  )
    return (
      <Notice>
        Captured relationship evidence could not be read. Reload this decision
        record before using its relationship evidence.
      </Notice>
    );
  return (
    <section aria-label="Captured relationships">
      <h3>Relationships at evaluation</h3>
      <p className="help">
        {context.total.toLocaleString()} active backend{" "}
        {context.total === 1 ? "assertion" : "assertions"} in the 30-day window.{" "}
        {context.truncated
          ? `Showing ${context.items.length.toLocaleString()} captured summaries; this sample is not the complete inventory.`
          : `All ${context.items.length.toLocaleString()} captured summaries are shown.`}{" "}
        Captured <Time at={context.observed_at} />. These facts do not change
        when a relationship is corrected. Source links inspect current evidence.
      </p>
      <ul className="captured-relationships">
        {[
          ...context.items,
          ...(context.observed_ip ? [context.observed_ip] : []),
        ].map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <details>
              <summary>
                {sourceLabel(item.source)} · {item.user_id ?? item.ip} ·
                Revision {item.revision}
              </summary>
              <Endpoints item={item} />
              <Provenance item={item} />
              <Link to={relationshipUrl(item)}>Inspect current source</Link>
            </details>
          </li>
        ))}
      </ul>
      {!context.observed_ip && (
        <p className="help">No matching IP segment was captured.</p>
      )}
    </section>
  );
}

export function Relationships({
  kind,
  id,
  refreshEntity,
}: {
  kind: string;
  id: string;
  refreshEntity: () => Promise<void>;
}) {
  const [params, setParams] = useSearchParams();
  const [model] = useState(() => new RelationshipForm());
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [review, setReview] = useState<{
    relationship: Relationship;
    action: RelationshipAction;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [refreshingChange, setRefreshingChange] = useState(false);
  const resultNotice = useRef<HTMLParagraphElement>(null);
  const listPath = `${entityPath(kind, id, "/relationships")}&limit=20${params.has("relationships_cursor") ? `&cursor=${encode(params.get("relationships_cursor")!)}` : ""}`;
  const validateList = useCallback(
    (value: unknown): value is Page<Relationship> =>
      validRelationships(value) &&
      value.items.every(
        (item) =>
          ({
            client: item.client_id,
            session: item.session_id,
            user: item.user_id,
            ip: item.ip,
          })[kind] === id,
      ),
    [kind, id],
  );
  const list = useResource(listPath, validateList);
  const selectedKind =
    state.pending?.relationship.kind ??
    state.receipt?.relationship.kind ??
    uniqueSelector(params, "relationship_kind");
  const selectedId =
    state.pending?.relationship.id ??
    state.receipt?.relationship.id ??
    uniqueSelector(params, "relationship_id");
  const selected: Pick<Relationship, "kind" | "id"> | null =
    selectedId && (selectedKind === "backend" || selectedKind === "observed_ip")
      ? { kind: selectedKind, id: selectedId }
      : null;
  const detailPath = selected
    ? `${relationshipPath(selected)}&limit=20${params.has("relationship_audit_cursor") && selectedKind === params.get("relationship_kind") && selectedId === params.get("relationship_id") ? `&cursor=${encode(params.get("relationship_audit_cursor")!)}` : ""}`
    : null;
  const validateDetail = useCallback(
    (value: unknown): value is RelationshipDetail =>
      validRelationshipDetail(value) &&
      value.relationship.kind === selectedKind &&
      value.relationship.id === selectedId,
    [selectedKind, selectedId],
  );
  const detail = useResource(detailPath, validateDetail);
  // Revisions only advance, even when an older page or read arrives later.
  const known = useRef(new Map<string, Relationship>());
  const recordKey = (item: Pick<Relationship, "kind" | "id">) =>
    `${item.kind}:${item.id}`;
  const incoming = detail.data?.relationship;
  for (const item of [
    ...(list.data?.items ?? []),
    ...(incoming ? [incoming] : []),
  ]) {
    const previous = known.current.get(recordKey(item));
    if (!previous || item.revision > previous.revision)
      known.current.set(recordKey(item), item);
  }
  const current = selected
    ? (known.current.get(recordKey(selected)) ?? null)
    : null;
  const receiptMatches =
    state.receipt &&
    selected &&
    state.receipt.relationship.kind === selected.kind &&
    state.receipt.relationship.id === selected.id;
  const currentBehind =
    Boolean(incoming && current && incoming.revision < current.revision) ||
    Boolean(
      receiptMatches &&
        (!current || current.revision < state.receipt!.relationship.revision),
    );
  const readable = Boolean(
    current && !detail.error && !detail.loading && !currentBehind,
  );
  const pending = state.pending;
  const reviewed = pending?.relationship ?? review?.relationship;
  const action = pending?.action ?? review?.action;
  const dirty = Boolean(review || pending);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const auditHeading = useRef<HTMLElement>(null);
  const previousPage = useRef(listPath);
  const auditCursor = params.get("relationship_audit_cursor");
  const previousAudit = useRef(auditCursor);
  useEffect(() => {
    if (previousPage.current !== listPath) listHeading.current?.focus();
    previousPage.current = listPath;
  }, [listPath]);
  useEffect(() => {
    if (previousAudit.current !== auditCursor) auditHeading.current?.focus();
    previousAudit.current = auditCursor;
  }, [auditCursor]);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    model.activate();
    return () => model.dispose();
  }, [model]);
  useEffect(() => {
    if (blocker.state === "blocked" && !dialog.current?.open)
      dialog.current?.showModal();
    else if (blocker.state !== "blocked" && dialog.current?.open)
      dialog.current.close();
  }, [blocker.state]);
  useBeforeUnload((event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  useEffect(() => {
    if (selectedId && incoming) heading.current?.focus();
  }, [selectedKind, selectedId, Boolean(incoming)]);
  useEffect(() => {
    if (!state.receipt) return;
    let active = true;
    setReview(null);
    setReason("");
    setRejected(false);
    setRefreshingChange(true);
    resultNotice.current?.focus();
    void Promise.allSettled([
      list.refresh(),
      detail.refresh(),
      refreshEntity(),
    ]).then(() => {
      if (active) setRefreshingChange(false);
    });
    return () => {
      active = false;
    };
  }, [state.receipt]);
  useEffect(() => {
    if (state.error && !state.pending && review) {
      setRejected(true);
      void detail.refresh();
    }
  }, [state.error, state.pending]);
  function update(values: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values))
        value === null ? next.delete(key) : next.set(key, value);
      return next;
    });
  }
  function select(item: Relationship) {
    model.dismiss();
    const closing = selected?.kind === item.kind && selected.id === item.id;
    update({
      relationship_kind: closing ? null : item.kind,
      relationship_id: closing ? null : item.id,
      relationship_audit_cursor: null,
    });
  }
  function beginReview() {
    if (!current || !readable) return;
    model.dismiss();
    setReview({
      relationship: current,
      action: current.revoked_at === null ? "correct" : "restore",
    });
    setReason("");
    setValidation(null);
    setRejected(false);
  }
  function cancelReview() {
    if (pending) return;
    setReview(null);
    setReason("");
    setValidation(null);
    setRejected(false);
    model.dismiss();
    heading.current?.focus();
  }
  function submit() {
    if (!review || rejected) return;
    if (!validReason(reason)) {
      setValidation(
        "Enter a reason of 1–512 UTF-8 bytes, without control characters or surrounding spaces.",
      );
      reasonInput.current?.focus();
      return;
    }
    setValidation(null);
    void model.submit(review.relationship, review.action, reason);
  }
  return (
    <section id="relationships" aria-labelledby="relationships-heading">
      <div className="relationship-heading">
        <h2 id="relationships-heading" ref={listHeading} tabIndex={-1}>
          Relationships
        </h2>
        <button
          disabled={list.loading || Boolean(pending)}
          onClick={() => void list.refresh()}
        >
          Refresh relationships
        </button>
      </div>
      <p className="help">
        Direct evidence for this {kind === "ip" ? "IP" : kind}. A relationship
        is evidence, never proof of a person’s identity.
      </p>
      {(params.getAll("relationship_kind").length > 1 ||
        params.getAll("relationship_id").length > 1) && (
        <Notice>Provide one relationship kind and ID in the address.</Notice>
      )}
      {state.storageUnavailable && (
        <Notice>
          Browser recovery storage is unavailable. Keep this page open until the
          reviewed request is confirmed.
        </Notice>
      )}
      <ResourceError resource={list} />
      {list.data ? (
        <>
          {list.data.items.length ? (
            <ul className="relationship-list">
              {list.data.items.map((record) => {
                const item = known.current.get(recordKey(record)) ?? record;
                return (
                  <li key={`${item.kind}:${item.id}`}>
                    <div className="relationship-row">
                      <div>
                        <p>
                          {kind !== "client" && (
                            <>
                              <EntityLink kind="client" id={item.client_id} />{" "}
                              →{" "}
                            </>
                          )}
                          {kind === "user" ? (
                            "This user"
                          ) : kind === "ip" ? (
                            "This IP"
                          ) : (
                            <EntityLink
                              kind={item.kind === "backend" ? "user" : "ip"}
                              id={item.user_id ?? item.ip}
                            />
                          )}
                        </p>
                        <p className="help">
                          {sourceLabel(item.source)} ·{" "}
                          {item.revoked_at === null ? "Active" : "Corrected"} ·
                          Last seen <Time at={item.last_seen} />
                        </p>
                      </div>
                      <button
                        aria-controls="relationship-detail"
                        aria-expanded={
                          selected?.kind === item.kind &&
                          selected.id === item.id
                        }
                        aria-label={`Inspect ${item.kind === "backend" ? "assertion" : "IP segment"} ${item.id}`}
                        disabled={dirty || state.busy}
                        onClick={() => select(item)}
                      >
                        Inspect
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">No retained direct relationships.</p>
          )}
          <div className="actions pagination">
            {params.has("relationships_cursor") && (
              <button
                disabled={dirty || list.loading}
                onClick={() => update({ relationships_cursor: null })}
              >
                First relationships
              </button>
            )}
            {list.data.next_cursor && (
              <button
                disabled={dirty || list.loading}
                onClick={() =>
                  update({ relationships_cursor: list.data!.next_cursor })
                }
              >
                Next relationships →
              </button>
            )}
          </div>
        </>
      ) : list.loading ? (
        <Loading />
      ) : null}
      {selected && (
        <section
          id="relationship-detail"
          className="relationship-detail"
          aria-labelledby="relationship-detail-heading"
        >
          <div className="relationship-heading">
            <h3 ref={heading} tabIndex={-1} id="relationship-detail-heading">
              {selected.kind === "backend"
                ? "Backend assertion"
                : "Observed IP segment"}
            </h3>
            <button
              disabled={dirty || state.busy}
              onClick={() => {
                update({
                  relationship_kind: null,
                  relationship_id: null,
                  relationship_audit_cursor: null,
                });
                model.dismiss();
                listHeading.current?.focus();
              }}
            >
              Close inspection
            </button>
          </div>
          <p className="help">
            Current source evidence. Past decisions keep their original captured
            values.
          </p>
          <ResourceError resource={detail} />
          {currentBehind && (
            <Notice retry={() => void detail.refresh()}>
              The current source response is older than evidence already
              received. Refresh before reviewing another change.
            </Notice>
          )}
          {current && (
            <>
              <Endpoints item={current} />
              <Provenance item={current} />
              <JsonDetails title="Metadata" value={current.metadata} />
            </>
          )}
          {!current && detail.loading && <Loading />}
          {state.receipt && (
            <p
              ref={resultNotice}
              id="relationship-change-result"
              tabIndex={-1}
              className="confirmation"
              role="status"
            >
              Change accepted at revision {state.receipt.relationship.revision}.
              Current metric recalculation is complete.{" "}
              {refreshingChange
                ? "Refreshing source and current entity values…"
                : "Any source or entity refresh failure is shown separately."}
            </p>
          )}
          {state.error && <Notice>{state.error}</Notice>}
          {state.expired && (
            <Notice>
              <div>
                The safe retry window has ended. Inspect the current
                relationship and audit history to establish whether the original
                change applied. Do not infer failure from a missing
                acknowledgement.
                <div className="actions">
                  <button
                    onClick={() => {
                      model.acknowledgeExpired();
                      setReview(null);
                      setReason("");
                    }}
                  >
                    I will reconcile the audit history
                  </button>
                </div>
              </div>
            </Notice>
          )}
          {reviewed && action ? (
            <section
              className="review"
              aria-labelledby="relationship-review-heading"
            >
              <h3
                id="relationship-review-heading"
                ref={reviewHeading}
                tabIndex={-1}
              >
                {action === "correct"
                  ? "Review correction"
                  : "Review restoration"}
              </h3>
              <Endpoints item={reviewed} />
              <p className="help">
                Relationship <span className="identifier">{reviewed.id}</span> ·
                Revision {reviewed.revision} · Last seen{" "}
                <Time at={reviewed.last_seen} />.
              </p>
              <Scope item={reviewed} action={action} />
              {current &&
                current.revision !== reviewed.revision &&
                !pending && (
                  <Notice>
                    This relationship changed since this review. The reviewed
                    revision remains {reviewed.revision}; cancel and review the
                    current evidence.
                  </Notice>
                )}
              {pending ? (
                <>
                  <p>Reason: {pending.reason}</p>
                  <p className="help">
                    This exact revision and reason are retained across retries
                    and sign-in.
                  </p>
                  <button
                    disabled={state.busy || state.expired}
                    onClick={() => void model.retry()}
                  >
                    {state.busy
                      ? "Confirming change…"
                      : "Retry same reviewed request"}
                  </button>
                </>
              ) : rejected ? (
                <div className="actions">
                  <button disabled={!readable} onClick={beginReview}>
                    Review current relationship
                  </button>
                  <button onClick={cancelReview}>Cancel review</button>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    submit();
                  }}
                >
                  <label>
                    Reason
                    <textarea
                      ref={reasonInput}
                      name="reason"
                      autoComplete="off"
                      rows={3}
                      value={reason}
                      onChange={(event) => {
                        setReason(event.target.value);
                        setValidation(null);
                      }}
                      aria-invalid={Boolean(validation)}
                      aria-describedby={
                        validation
                          ? "relationship-reason-error"
                          : "relationship-reason-help"
                      }
                    />
                  </label>
                  <p className="help" id="relationship-reason-help">
                    Required · Up to 512 UTF-8 bytes. The reason is retained in
                    the audit history.
                  </p>
                  {validation && (
                    <p
                      role="alert"
                      className="error"
                      id="relationship-reason-error"
                    >
                      {validation}
                    </p>
                  )}
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={
                        state.busy ||
                        !readable ||
                        current?.revision !== reviewed.revision
                      }
                      type="submit"
                    >
                      {action === "correct"
                        ? "Confirm correction"
                        : "Confirm restoration"}
                    </button>
                    <button type="button" onClick={cancelReview}>
                      Cancel review
                    </button>
                  </div>
                </form>
              )}
            </section>
          ) : (
            current && (
              <button disabled={!readable || state.busy} onClick={beginReview}>
                {current.revoked_at === null
                  ? "Correct relationship"
                  : "Restore relationship"}
              </button>
            )
          )}
          {detail.data && (
            <details className="relationship-audit">
              <summary ref={auditHeading}>Audit history</summary>
              {detail.data.audit.items.length ? (
                <ol>
                  {detail.data.audit.items.map((audit) => (
                    <li key={audit.id}>
                      <p>
                        <Time at={audit.at} /> ·{" "}
                        {audit.action === "correct"
                          ? "Corrected"
                          : audit.action === "restore"
                            ? "Restored"
                            : audit.action}{" "}
                        · {audit.actor ?? "Actor not recorded"}
                        {audit.revision !== null
                          ? ` · Revision ${audit.revision}`
                          : " · Revision not recorded"}
                      </p>
                      <p>{audit.reason}</p>
                      {audit.relationship ? (
                        <details>
                          <summary>Evidence after this change</summary>
                          <Endpoints item={audit.relationship} />
                          <Provenance item={audit.relationship} />
                        </details>
                      ) : (
                        <p className="help">
                          The resulting evidence snapshot was not recorded for
                          this legacy change.
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">
                  No recorded corrections or restorations.
                </p>
              )}
              <div className="actions">
                <button
                  disabled={dirty || detail.loading}
                  onClick={() => void detail.refresh()}
                >
                  Refresh source and audit
                </button>
                {params.has("relationship_audit_cursor") && (
                  <button
                    disabled={dirty || detail.loading}
                    onClick={() => update({ relationship_audit_cursor: null })}
                  >
                    Latest audit records
                  </button>
                )}
                {detail.data.audit.next_cursor && (
                  <button
                    disabled={dirty || detail.loading}
                    onClick={() =>
                      update({
                        relationship_audit_cursor:
                          detail.data!.audit.next_cursor,
                      })
                    }
                  >
                    Older audit records →
                  </button>
                )}
              </div>
            </details>
          )}
        </section>
      )}
      <dialog
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          blocker.reset?.();
        }}
        aria-labelledby="relationship-leave-heading"
      >
        <h2 id="relationship-leave-heading">
          {pending
            ? "A relationship change is unconfirmed."
            : "Leave this unfinished review?"}
        </h2>
        <p>
          {pending
            ? "Stay here and retry the same reviewed request. The change may already have applied."
            : "Leaving discards the reason and this review."}
        </p>
        <div className="actions">
          <button onClick={() => blocker.reset?.()}>
            Stay with relationship
          </button>
          {!pending && (
            <button
              onClick={() => {
                setReview(null);
                setReason("");
                blocker.proceed?.();
              }}
            >
              Discard review and leave
            </button>
          )}
        </div>
      </dialog>
    </section>
  );
}
