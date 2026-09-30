import { ActorAttribution } from "./ActorAttribution";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { CredentialForm, validCredential, validLabel } from "./credential-form";
import { Loading, Notice, ResourceError, Time, useResource } from "./shared";
import type { Credential, Page, Setup } from "./types";

export interface SettingsWork {
  dirty: boolean;
  pending: boolean;
  secret?: boolean;
}
const kindLabel = (kind: Credential["kind"]) =>
  kind === "browser" ? "Browser key" : "Server secret";
export function Credentials({
  setup,
  refreshSetup,
  report,
}: {
  setup: Setup | undefined;
  refreshSetup: () => Promise<void>;
  report: (state: SettingsWork) => void;
}) {
  const [params, setParams] = useSearchParams();
  const query = params.get("credential_q") ?? "";
  const cursor = params.get("credential_cursor");
  const [search, setSearch] = useState(query);
  useEffect(() => setSearch(query), [query]);
  const path = `/credentials?limit=20${query ? `&q=${encodeURIComponent(query)}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const list = useResource<Page<Credential>>(path);
  const [model] = useState(() => new CredentialForm());
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [open, setOpen] = useState(Boolean(state.pending));
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<Credential["kind"]>("browser");
  const [label, setLabel] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const [review, setReview] = useState<Credential | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const labelField = useRef<HTMLInputElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const hadPanel = useRef(false);
  const result = state.result;
  const data = list.data;
  const validList = Boolean(
    data &&
      Array.isArray(data.items) &&
      data.items.every(validCredential) &&
      (data.next_cursor === null || typeof data.next_cursor === "string"),
  );
  const items = validList
    ? data!.items.map((item) => model.currentCredential(item))
    : [];
  const latestReview = review
    ? model.currentCredential(
        items.find((item) => item.id === review.id) ?? review,
      )
    : null;
  const dirty = Boolean(label || state.pending || result?.secret);
  useEffect(() => {
    model.activate();
    return () => model.dispose();
  }, [model]);
  useEffect(() => {
    report({
      dirty,
      pending: Boolean(state.pending),
      secret: Boolean(result?.secret),
    });
  }, [dirty, state.pending, result?.secret, report]);
  useEffect(() => {
    if (result) {
      setCreating(false);
      setLabel("");
      setReview(null);
      setCopied(null);
      void list.refresh();
      void refreshSetup();
      resultHeading.current?.focus();
    }
    // A mutation acknowledgement starts one refresh; changing list filters does not replay it.
  }, [result]);
  useEffect(() => {
    if (validList) model.observe(data!.items);
  }, [model, data, validList]);
  useEffect(() => {
    if (creating) labelField.current?.focus();
  }, [creating]);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);
  useEffect(() => {
    if (setup?.public_key === null) setOpen(true);
  }, [setup?.public_key]);
  function filter(q: string, after?: string) {
    const next = new URLSearchParams(params);
    q ? next.set("credential_q", q) : next.delete("credential_q");
    after
      ? next.set("credential_cursor", after)
      : next.delete("credential_cursor");
    setParams(next, { preventScrollReset: true });
  }
  function begin(nextKind: Credential["kind"] = "browser") {
    model.dismiss();
    setKind(nextKind);
    setCreating(true);
    setReview(null);
    setValidation(null);
    setOpen(true);
  }
  function done() {
    model.dismiss();
    setCopied(null);
    createButton.current?.focus();
  }
  useEffect(() => {
    const panel = Boolean(creating || review || result || state.pending);
    if (hadPanel.current && !panel) createButton.current?.focus();
    hadPanel.current = panel;
  }, [creating, review, result, state.pending]);
  const blocked = state.busy || Boolean(state.pending || result);
  return (
    <details
      id="credentials"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Application credentials{" "}
        {setup?.active_credentials && (
          <span className="provider-summary help">
            {state.pending ? (
              "Request unconfirmed"
            ) : (
              <>
                {setup.active_credentials.browser} browser ·{" "}
                {setup.active_credentials.server} server active
              </>
            )}
          </span>
        )}
      </summary>
      <p className="help">
        Browser keys are public. Server secrets belong only in your application
        backend. Create a replacement, update your application, then revoke the
        old credential.
      </p>
      {!state.pending && setup?.public_key === null && (
        <p>No active browser key. Create one to connect the browser SDK.</p>
      )}
      {!state.pending && setup?.active_credentials?.server === 0 && (
        <p>
          No active server secret. Create one to connect your application
          backend.
        </p>
      )}
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      {state.storageUnavailable && (
        <p className="help">
          Browser recovery storage is unavailable. Keep this page open until the
          request is confirmed; returned server secrets are never stored here.
        </p>
      )}
      {state.pending ? (
        <section
          className="credential-result"
          aria-label="Unconfirmed credential request"
        >
          <h3 aria-live="polite">
            {state.pending.id ? "Revocation" : "Creation"}{" "}
            {state.expired ? "needs inspection" : "unconfirmed"}
          </h3>
          <p>
            {kindLabel(state.pending.kind)} · {state.pending.label}
          </p>
          {state.pending.id && (
            <p className="identifier" translate="no">
              {state.pending.id}
            </p>
          )}
          {state.expired ? (
            <>
              <p>
                This request is outside the supported retry window. Inspect the
                credential list and revoke any unused credential before creating
                a replacement. Retrying creation could create a duplicate.
              </p>
              <button
                onClick={() => {
                  model.acknowledgeExpired();
                  void list.refresh();
                  void refreshSetup();
                }}
              >
                Dismiss request and inspect credentials
              </button>
            </>
          ) : (
            <>
              <p className="help">
                Retrying keeps the original request. If the first server-secret
                response was lost, its value cannot be recovered.
              </p>
              <button disabled={state.busy} onClick={() => void model.retry()}>
                {state.busy ? "Submitting…" : "Retry same request"}
              </button>
            </>
          )}
        </section>
      ) : result ? (
        <section className="credential-result" aria-label="Credential result">
          <h3 tabIndex={-1} ref={resultHeading}>
            {result.credential.revoked_at !== null
              ? "Credential revoked"
              : "Credential created"}
          </h3>
          <p>
            {result.credential.label} · {kindLabel(result.credential.kind)}
          </p>
          <p className="identifier" translate="no">
            {result.credential.id}
          </p>
          {result.secret ? (
            <>
              <p>
                Copy this secret now and store it in your application’s secret
                configuration. Krine will not show it again.
              </p>
              <label>
                New server secret
                <input
                  ref={secretField}
                  name="new_server_secret"
                  autoComplete="off"
                  spellCheck={false}
                  readOnly
                  value={result.secret}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <div className="actions">
                <button
                  onClick={() => {
                    const value = result.secret!;
                    void navigator.clipboard?.writeText(value).then(
                      () => setCopied("Secret copied."),
                      () => {
                        setCopied(
                          "Copy was unavailable. Select and copy the secret field.",
                        );
                        secretField.current?.focus();
                      },
                    );
                    if (!navigator.clipboard) {
                      setCopied(
                        "Copy was unavailable. Select and copy the secret field.",
                      );
                      secretField.current?.focus();
                    }
                  }}
                >
                  Copy secret
                </button>
                <button onClick={done}>I have saved the secret</button>
              </div>
              {copied && (
                <p role="status" className="help">
                  {copied}
                </p>
              )}
            </>
          ) : result.secret_status === "unrecoverable" &&
            result.credential.revoked_at === null ? (
            <>
              <p>
                The credential was created, but its secret cannot be recovered.
                If you did not save it, revoke this credential and create a
                replacement.
              </p>
              <div className="actions">
                <button
                  onClick={() => {
                    setReview(result.credential);
                    model.dismiss();
                  }}
                >
                  Review revocation
                </button>
                <button onClick={done}>I already saved this secret</button>
              </div>
            </>
          ) : (
            <>
              {result.credential.public_key && (
                <p className="identifier" translate="no">
                  {result.credential.public_key}
                </p>
              )}
              {result.credential.revoked_at !== null && (
                <p className="help">
                  Revoked <Time at={result.credential.revoked_at} />. Future
                  requests using this credential are rejected.
                </p>
              )}
              <button onClick={done}>Done</button>
            </>
          )}
        </section>
      ) : creating ? (
        <form
          className="credential-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = label.trim();
            if (!validLabel(trimmed)) {
              setValidation(
                "Enter a label of 1–128 bytes without control characters.",
              );
              labelField.current?.focus();
              return;
            }
            setValidation(null);
            void model.create(kind, trimmed);
          }}
        >
          <div className="inline-fields">
            <label>
              Credential type
              <select
                name="credential_kind"
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as Credential["kind"])
                }
              >
                <option value="browser">Public browser key</option>
                <option value="server">Server secret</option>
              </select>
            </label>
            <label>
              Label
              <input
                ref={labelField}
                name="credential_label"
                autoComplete="off"
                maxLength={128}
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value);
                  setValidation(null);
                }}
                aria-invalid={Boolean(validation)}
                aria-describedby={
                  validation ? "credential-label-error" : undefined
                }
              />
            </label>
          </div>
          {validation && (
            <p id="credential-label-error" role="alert" className="error">
              {validation}
            </p>
          )}
          {kind === "server" && (
            <p className="help">
              The server secret will be shown once after creation.
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary">
              Create {kind === "browser" ? "browser key" : "server secret"}
            </button>
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setLabel("");
                setValidation(null);
                createButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : latestReview ? (
        <section
          className="credential-result"
          aria-label="Revoke credential review"
        >
          <h3 ref={reviewHeading} tabIndex={-1}>
            Revoke {latestReview.label}?
          </h3>
          <dl className="facts">
            <div>
              <dt>Type</dt>
              <dd>{kindLabel(latestReview.kind)}</dd>
            </div>
            <div>
              <dt>Credential</dt>
              <dd className="identifier" translate="no">
                {latestReview.id}
              </dd>
            </div>
            {latestReview.public_key && (
              <div>
                <dt>Public key</dt>
                <dd className="identifier" translate="no">
                  {latestReview.public_key}
                </dd>
              </div>
            )}
          </dl>
          {latestReview.revoked_at !== null ? (
            <p>This credential is already revoked.</p>
          ) : (
            <>
              <p>
                New requests using this credential will fail immediately. Update
                your application to a replacement first. Revocation cannot be
                undone.
              </p>
              {setup?.active_credentials?.[latestReview.kind] === 1 && (
                <p className="error">
                  This is the last active{" "}
                  {latestReview.kind === "browser"
                    ? "browser key"
                    : "server secret"}{" "}
                  in the latest connection status.
                </p>
              )}
              <p className="help">
                Requests already authenticated may finish. Existing client,
                session and proof material remain valid.
              </p>
            </>
          )}
          <div className="actions">
            {latestReview.revoked_at === null && (
              <button onClick={() => void model.revoke(latestReview)}>
                Revoke credential
              </button>
            )}
            <button
              onClick={() => {
                setReview(null);
                createButton.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <button ref={createButton} onClick={() => begin()}>
          {setup?.public_key === null
            ? "Create browser key"
            : "Create credential"}
        </button>
      )}
      <div className="credential-list-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            filter(
              String(
                new FormData(event.currentTarget).get("credential_search") ??
                  "",
              ),
            );
          }}
        >
          <label>
            Search labels
            <input
              name="credential_search"
              type="search"
              autoComplete="off"
              maxLength={128}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <button type="submit">Search</button>
        </form>
        <button
          disabled={list.loading}
          onClick={() => {
            void list.refresh();
            void refreshSetup();
          }}
        >
          {list.loading ? "Refreshing…" : "Refresh credentials"}
        </button>
      </div>
      <ResourceError resource={list} />
      {data !== undefined && !validList && (
        <Notice retry={() => void list.refresh()}>
          Krine returned an unreadable credential list. Retry to refresh it.
        </Notice>
      )}
      {list.loading && !data && <Loading />}
      {validList && (
        <>
          {items.length ? (
            <ul className="credential-list">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="credential-row">
                    <div>
                      <strong>{item.label}</strong>
                      <p className="help">
                        {kindLabel(item.kind)} ·{" "}
                        {state.pending?.id === item.id
                          ? "Revocation unconfirmed"
                          : item.revoked_at === null
                            ? "Active"
                            : "Revoked"}
                        {item.source === "bootstrap" && " · Initial credential"}
                      </p>
                    </div>
                    {item.revoked_at === null && (
                      <button
                        aria-label={`Review revocation for ${item.label}`}
                        disabled={blocked || creating || Boolean(review)}
                        onClick={() => {
                          setReview(item);
                          void list.refresh();
                          void refreshSetup();
                        }}
                      >
                        Review revocation
                      </button>
                    )}
                  </div>
                  {item.public_key && (
                    <p className="identifier" translate="no">
                      {item.public_key}
                    </p>
                  )}
                  <details className="credential-record">
                    <summary aria-label={`Record details for ${item.label}`}>
                      Record details
                    </summary>
                    <p className="identifier" translate="no">
                      {item.id}
                    </p>
                    <p className="help">
                      Created <Time at={item.created_at} /> · <ActorAttribution value={item.created_by} />
                    </p>
                    {item.revoked_at !== null && (
                      <p className="help">
                        Revoked <Time at={item.revoked_at} /> · <ActorAttribution value={item.revocation_actor} legacy={item.revoked_by} />
                      </p>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {query
                ? "No credentials match this label."
                : "No credentials on this page."}
            </p>
          )}
          {(cursor || data!.next_cursor) && (
            <div className="pagination actions">
              {cursor && (
                <button onClick={() => filter(query)}>First page</button>
              )}
              {data!.next_cursor && (
                <button onClick={() => filter(query, data!.next_cursor!)}>
                  Next page →
                </button>
              )}
            </div>
          )}
        </>
      )}
    </details>
  );
}
