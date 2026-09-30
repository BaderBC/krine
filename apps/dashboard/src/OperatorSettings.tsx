import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useBeforeUnload, useBlocker, useSearchParams } from "react-router-dom";
import { api, encode, mutation } from "./api";
import { useAccess } from "./access";
import { CredentialReveal } from "./OperatorAuth";
import {
  Loading,
  Notice,
  Pagination,
  ResourceError,
  Time,
  useResource,
} from "./shared";
import {
  textValue,
  validOperator,
  validPage,
  validReveal,
  validSessionRecord,
} from "./operator";
import type {
  Operator,
  OperatorReveal,
  OperatorSessionRecord,
} from "./operator";
import type { Page } from "./types";
import { useOperatorChange, validOperatorChange } from "./operator-form";
import type { OperatorChange } from "./operator-form";
const operatorPage = (v: unknown): v is Page<Operator> =>
  validPage(v, validOperator);
const sessionPage = (v: unknown): v is Page<OperatorSessionRecord> =>
  validPage(v, validSessionRecord);
export function OperatorAccess({ ownOnly = false }: { ownOnly?: boolean }) {
  const { session, can, suspended, revealedCredential: reveal } = useAccess();
  const [params, setParams] = useSearchParams();
  const manage = can("manage_operators") && !ownOnly;
  const chosen = manage ? params.get("operator") : session?.operator?.id;
  const selectedId =
    chosen && /^op_[A-Za-z0-9_-]+$/.test(chosen) ? chosen : null;
  const operators = useResource<Page<Operator>>(
    manage
      ? `/operators?limit=50${params.get("operators_cursor") ? `&cursor=${encode(params.get("operators_cursor")!)}` : ""}`
      : null,
    operatorPage,
  );
  const detail = useResource<Operator>(
    manage && selectedId ? `/operators/${encode(selectedId)}` : null,
    validOperator,
  );
  const [latest, setLatest] = useState<Operator | null>(null);
  const incoming = manage ? detail.data : session?.operator;
  const selected =
    latest?.id === selectedId &&
    (!incoming || latest.revision >= incoming.revision)
      ? latest
      : incoming?.id === selectedId
        ? incoming
        : null;
  const accessForm = useRef<HTMLFormElement>(null);
  const selectedHeading = useRef<HTMLHeadingElement>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [revocationError, setRevocationError] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "update" | "rotate" | null>(null);
  useEffect(() => {
    if (mode)
      accessForm.current
        ?.querySelector<
          HTMLInputElement | HTMLTextAreaElement
        >("input,textarea")
        ?.focus();
    setValidation(null);
  }, [mode]);
  useEffect(() => {
    if (selected) selectedHeading.current?.focus();
  }, [selected?.id]);
  const setReveal = (value: OperatorReveal | null) =>
    api.revealCredential(value);
  const [notice, setNotice] = useState<string | null>(null);
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  const sessions = useResource<Page<OperatorSessionRecord>>(
    selectedId
      ? `/operators/${encode(selectedId)}/sessions?limit=50${params.get("sessions_cursor") ? `&cursor=${encode(params.get("sessions_cursor")!)}` : ""}`
      : null,
    sessionPage,
  );
  const action = useOperatorChange((change, result) => {
    setMode(null);
    if (validReveal(result)) {
      setReveal(result);
      setLatest(result.operator);
    } else if (validOperator(result)) {
      setLatest((previous) =>
        previous?.id === result.id && previous.revision > result.revision
          ? previous
          : result,
      );
      setNotice("Operator access updated.");
    } else if (change.kind === "revoke") {
      setRevoked(
        (previous) =>
          new Set([
            ...previous,
            ...(change.session_id
              ? [change.session_id]
              : (sessions.data?.items.map((s) => s.id) ?? [])),
          ]),
      );
      setNotice("Session access revoked.");
    }
    if (
      change.target === session?.operator?.id &&
      ((change.kind === "update" &&
        validOperator(result) &&
        (result.role !== session.operator.role || result.state !== "active")) ||
        (change.kind === "revoke" &&
          (!change.session_id || change.session_id === session.session_id)))
    )
      api.suspend();
    // Keep a successful reveal independent of a later failed or stale refresh.
    if (manage) void operators.refresh();
    if (selectedId) void sessions.refresh();
  });
  const protectedWork = Boolean(
    reveal || mode || action.busy || action.pending,
  );
  const stayHere = useRef<HTMLButtonElement>(null);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      protectedWork &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (!protectedWork) {
      blocker.reset();
      return;
    }
    const trigger = document.activeElement;
    stayHere.current?.focus();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, [blocker.state, protectedWork]);
  useBeforeUnload((e) => {
    if (reveal || mode) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  const canRetry =
    action.pending?.kind === "revoke" &&
    action.pending.target === session?.operator?.id
      ? can("session")
      : can("manage_operators");
  const locked =
    action.busy ||
    action.pending !== null ||
    reveal !== null ||
    action.invalidRecovery;
  function select(id: string) {
    if (locked || mode) return;
    setLatest(null);
    setMode(null);
    setNotice(null);
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set("operator", id);
      n.delete("sessions_cursor");
      return n;
    });
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || !mode) return;
    const data = new FormData(e.currentTarget);
    const reason = String(data.get("reason"));
    if (!textValue(reason, 512)) {
      setValidation(
        "Use a reason of 1–512 UTF-8 bytes without surrounding whitespace or control characters.",
      );
      e.currentTarget
        .querySelector<HTMLTextAreaElement>("[name=reason]")
        ?.focus();
      return;
    }
    const body =
      mode === "create"
        ? {
            name: String(data.get("name")),
            sign_in_name: String(data.get("sign_in_name")),
            role: String(data.get("role")),
            reason,
          }
        : mode === "update"
          ? {
              revision: selected!.revision,
              name: String(data.get("name")),
              role: String(data.get("role")),
              state: String(data.get("state")),
              reason,
            }
          : { revision: selected!.revision, reason };
    const path =
      mode === "create"
        ? "/operators"
        : `/operators/${encode(selected!.id)}${mode === "rotate" ? "/credential-rotations" : ""}`;
    const change: OperatorChange = {
      operation: mutation(path, body, mode === "update" ? "PUT" : "POST"),
      kind: mode,
      target: mode === "create" ? null : selected!.id,
      revision: mode === "create" ? null : selected!.revision,
      session_id: null,
      started_at: Date.now(),
    };
    if (!validOperatorChange(change)) {
      setValidation(
        "Check the name and reason. Names allow 1–128 UTF-8 bytes; sign-in names allow ASCII letters, numbers, underscores, dots and hyphens.",
      );
      return;
    }
    setValidation(null);
    if (
      mode !== "create" &&
      !window.confirm(
        mode === "rotate"
          ? "Rotate this credential? The previous credential stops working and all of this operator’s sessions end. Save the new credential once it appears."
          : "Apply this reviewed access change? Changing role or state ends all of this operator’s sessions.",
      )
    )
      return;
    await action.send(change);
  }
  async function revoke(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected || locked || mode) return;
    const data = new FormData(e.currentTarget);
    const reason = String(data.get("reason"));
    const id = String(data.get("session_id"));
    if (!textValue(reason, 512)) {
      setRevocationError(
        "Use a reason of 1–512 UTF-8 bytes without surrounding whitespace or control characters.",
      );
      e.currentTarget.querySelector<HTMLInputElement>("[name=reason]")?.focus();
      return;
    }
    setRevocationError(null);
    if (
      !window.confirm(
        id
          ? "Revoke this session? The operator must sign in again."
          : "Revoke all current sessions for this operator?",
      )
    )
      return;
    const sessionId = id || null;
    await action.send({
      operation: mutation(
        `/operators/${encode(selected.id)}${sessionId ? `/sessions/${encode(sessionId)}/revocations` : "/session-revocations"}`,
        { revision: selected.revision, reason },
      ),
      started_at: Date.now(),
      kind: "revoke",
      target: selected.id,
      revision: selected.revision,
      session_id: sessionId,
    });
  }
  return (
    <section
      className="operator-access"
      aria-labelledby="operator-access-heading"
    >
      <div className="relationship-heading">
        <h2 id="operator-access-heading">
          {manage ? "Operators" : "Your sessions"}
        </h2>
        {manage && (
          <button
            disabled={locked || mode !== null}
            onClick={() => {
              setMode("create");
              setNotice(null);
            }}
          >
            Add operator
          </button>
        )}
      </div>
      <p className="help">
        {manage
          ? "Viewer investigates. Editor also changes checks and relationships. Admin manages configuration and access."
          : "Only your own sessions are shown. Revocation does not rotate your credential."}
      </p>
      {blocker.state === "blocked" && (
        <Notice>
          {action.busy
            ? "This operator request is still in progress. Stay here until its result is confirmed."
            : action.pending
              ? action.expired
                ? "This operator request is unconfirmed and its retry window has ended. Stay here, inspect its outcome, and acknowledge it before leaving."
                : "This operator request is unconfirmed. Stay here and retry the same request to recover its result. The change may already have been applied."
              : reveal
                ? "Save the sign-in credential before leaving. It cannot be revealed again."
                : "Leave this unfinished access change?"}
          <div className="actions">
            <button ref={stayHere} onClick={() => blocker.reset()}>
              Stay here
            </button>
            {!action.busy && !action.pending && (
              <button
                onClick={() => {
                  setReveal(null);
                  blocker.proceed();
                }}
              >
                Discard and leave
              </button>
            )}
          </div>
        </Notice>
      )}
      {action.invalidRecovery && (
        <Notice>
          A stored operator request could not be read. It remains untouched.
          Inspect access and audit before clearing that browser record.
        </Notice>
      )}
      {action.error && <Notice>{action.error}</Notice>}
      {action.pending && (
        <Notice>
          An earlier{" "}
          {action.pending.kind === "revoke"
            ? "session revocation"
            : `operator ${action.pending.kind}`}{" "}
          is unconfirmed. Inspect its effect before making another change.
          {action.expired ? (
            <>
              <p>
                The supported retry window has ended. Do not replay this
                request.
              </p>
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      "Have you inspected the operator and audit for this request’s effect?",
                    )
                  )
                    action.acknowledgeExpired();
                }}
              >
                I inspected its outcome
              </button>
            </>
          ) : (
            <button
              disabled={action.busy || !canRetry}
              onClick={() => void action.send(action.pending!)}
            >
              {action.busy ? "Confirming…" : "Retry same operator request"}
            </button>
          )}
        </Notice>
      )}
      {action.pending && !canRetry && (
        <p className="help">
          Your current role cannot retry this request. Inspect its resource and
          ask an Admin to review the audit.
        </p>
      )}
      {validation && <Notice>{validation}</Notice>}
      {notice && (
        <p role="status" className="confirmation">
          {notice}
        </p>
      )}
      {reveal && !suspended && (
        <CredentialReveal
          value={reveal}
          onSaved={() => {
            const self = reveal.operator.id === session?.operator?.id;
            setReveal(null);
            if (self) api.suspend();
          }}
        />
      )}
      {manage && (
        <>
          <ResourceError resource={operators} />
          {operators.data ? (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Operator</th>
                      <th>Role</th>
                      <th>Access</th>
                      <th>Last sign-in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {operators.data.items.map((raw) => {
                      const op =
                        latest?.id === raw.id && latest.revision > raw.revision
                          ? latest
                          : raw;
                      return (
                        <tr key={op.id}>
                          <td>
                            <button
                              className="text-button"
                              disabled={locked || mode !== null}
                              onClick={() => select(op.id)}
                            >
                              {op.name}
                            </button>
                            <div className="help" translate="no">
                              {op.sign_in_name}
                            </div>
                          </td>
                          <td>{op.role}</td>
                          <td>{op.state}</td>
                          <td>
                            <Time at={op.last_sign_in_at} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                page={operators.data}
                onNext={(cursor) => {
                  if (!locked)
                    setParams((p) => {
                      const n = new URLSearchParams(p);
                      n.set("operators_cursor", cursor);
                      return n;
                    });
                }}
              />
            </>
          ) : operators.loading ? (
            <Loading />
          ) : null}
        </>
      )}
      {manage && selectedId && <ResourceError resource={detail} />}
      {selected && (
        <div className="operator-detail">
          <h3 ref={selectedHeading} tabIndex={-1}>
            {selected.name}
          </h3>
          <p className="help">
            <span translate="no">{selected.sign_in_name}</span> ·{" "}
            {selected.role} · {selected.state} · Revision {selected.revision}
          </p>
          {manage && (
            <div className="actions">
              <button
                disabled={locked || mode !== null}
                onClick={() => setMode("update")}
              >
                Edit access
              </button>
              <button
                disabled={
                  locked || mode !== null || selected.state !== "active"
                }
                onClick={() => setMode("rotate")}
              >
                Rotate sign-in credential
              </button>
              <button
                disabled={locked || mode !== null}
                onClick={() => void detail.refresh()}
              >
                Refresh operator
              </button>
            </div>
          )}
        </div>
      )}
      {mode && !reveal && (
        <form
          ref={accessForm}
          className="operator-form"
          key={`${mode}:${selected?.id}:${selected?.revision}`}
          onSubmit={(e) => void submit(e)}
        >
          <h3>
            {mode === "create"
              ? "Add an operator"
              : mode === "update"
                ? "Review access"
                : "Rotate sign-in credential"}
          </h3>
          {mode !== "rotate" && (
            <>
              <label>
                Name
                <input
                  name="name"
                  autoComplete="off"
                  defaultValue={mode === "update" ? selected?.name : ""}
                  required
                  maxLength={128}
                />
              </label>
              {mode === "create" && (
                <label>
                  Sign-in name
                  <input
                    name="sign_in_name"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    pattern="[A-Za-z0-9_.-]+"
                    maxLength={64}
                    required
                  />
                </label>
              )}
              <label>
                Role
                <select
                  name="role"
                  defaultValue={mode === "update" ? selected?.role : "viewer"}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
              {mode === "update" && (
                <label>
                  Access
                  <select name="state" defaultValue={selected?.state}>
                    <option value="active">Active</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
              )}
            </>
          )}
          <label>
            Reason
            <textarea
              name="reason"
              autoComplete="off"
              required
              maxLength={512}
            />
          </label>
          <p className="help">
            {mode === "create"
              ? "The generated credential is shown once. Share it through your approved secure channel."
              : mode === "rotate"
                ? "Rotation ends all sessions and replaces the existing credential. A lost reveal requires another Admin or host recovery if you rotate your own credential."
                : "Role and access changes end all sessions. A name change keeps sessions active. Reactivation does not restore old sessions."}
          </p>
          <div className="actions">
            <button className="primary" disabled={locked} type="submit">
              {action.busy
                ? "Applying…"
                : mode === "create"
                  ? "Create operator"
                  : mode === "update"
                    ? "Apply access change"
                    : "Rotate credential"}
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => setMode(null)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {selected && (
        <section className="operator-sessions">
          <h3>{ownOnly ? "Active and recent sessions" : "Sessions"}</h3>
          <ResourceError resource={sessions} />
          {sessions.data ? (
            <>
              {sessions.data.items.length ? (
                <ul className="session-list">
                  {sessions.data.items.map((item) => (
                    <li key={item.id}>
                      <span>
                        {item.current ? "This session" : "Operator session"} ·
                        Created <Time at={item.created_at} /> ·{" "}
                        {item.revoked_at !== null || revoked.has(item.id) ? (
                          "Revoked"
                        ) : (
                          <>
                            Expires <Time at={item.expires_at} />
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No sessions in this page.</p>
              )}
              <Pagination
                page={sessions.data}
                onNext={(cursor) =>
                  setParams((p) => {
                    const n = new URLSearchParams(p);
                    n.set("sessions_cursor", cursor);
                    return n;
                  })
                }
              />
              <form className="session-revoke" onSubmit={(e) => void revoke(e)}>
                <label>
                  Session
                  <select name="session_id">
                    <option value="">All current sessions</option>
                    {sessions.data.items
                      .filter(
                        (s) =>
                          s.revoked_at === null &&
                          !revoked.has(s.id) &&
                          s.expires_at > Date.now(),
                      )
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.current ? "This session" : s.id}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Revocation reason
                  <input
                    name="reason"
                    autoComplete="off"
                    required
                    maxLength={512}
                    aria-invalid={revocationError ? true : undefined}
                    aria-describedby={
                      revocationError ? "revocation-error" : undefined
                    }
                    onChange={() => setRevocationError(null)}
                  />
                </label>
                {revocationError && (
                  <div id="revocation-error">
                    <Notice>{revocationError}</Notice>
                  </div>
                )}
                <button type="submit" disabled={locked || mode !== null}>
                  Revoke sessions
                </button>
              </form>
            </>
          ) : sessions.loading ? (
            <Loading />
          ) : null}
        </section>
      )}
    </section>
  );
}
