import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import {
  useBeforeUnload,
  useBlocker,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ApiError, api, encode, errorMessage, mutation } from "./api";
import type { Mutation } from "./api";
import { DraftController } from "./draft";
import {
  InvestigationLink as Link,
  ActivityReturn,
  useActivityOrigin,
} from "./navigation";
import { PolicyEditor, PolicyRead } from "./PolicyEditor";
import { policyChanges, policyError } from "./policy";
import {
  Loading,
  Notice,
  ResourceError,
  PageTitle,
  Pagination,
  Time,
  useResource,
} from "./shared";
import type { Check, CheckSummary, Metric, Page, Version } from "./types";

export function Checks() {
  const [params, setParams] = useSearchParams();
  const resource = useResource<Page<CheckSummary>>(`/checks?${params}`);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Mutation | null>(null);
  const navigate = useNavigate();
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name)) {
      setError(
        "Use 1–128 letters, numbers, underscores, dots, colons or hyphens.",
      );
      form.querySelector("input")?.focus();
      return;
    }
    if (
      pending.current &&
      (pending.current.body as { name: string }).name !== name
    ) {
      setError(
        "Retry the original name first; its creation may already have succeeded.",
      );
      return;
    }
    pending.current ??= mutation("/checks", { name });
    setBusy(true);
    setError(null);
    try {
      const check = await api.run<Check>(pending.current);
      pending.current = null;
      navigate(`/checks/${encode(check.name)}?view=draft`);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status >= 400 &&
        cause.status < 500
      )
        pending.current = null;
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle title="Checks">
        <button className="primary" onClick={() => setCreating(true)}>
          Create check
        </button>
      </PageTitle>
      {creating && (
        <form className="create-check" onSubmit={(event) => void create(event)}>
          <label>
            Check name
            <input
              name="name"
              autoComplete="off"
              spellCheck={false}
              maxLength={128}
              placeholder="can_claim_trial…"
              required
              aria-describedby="check-name-help"
            />
          </label>
          <p id="check-name-help" className="help">
            Your application uses this stable name to request a decision.
          </p>
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Creating…" : "Create check"}
            </button>
            <button
              type="button"
              disabled={busy || pending.current !== null}
              onClick={() => {
                setCreating(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      <ResourceError resource={resource} />
      {resource.data ? (
        resource.data.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Policy</th>
                    <th>Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.items.map((check) => (
                    <tr key={check.name}>
                      <td>
                        <Link
                          className="record-name"
                          translate="no"
                          to={`/checks/${encode(check.name)}`}
                        >
                          {check.name}
                        </Link>
                        {check.description && (
                          <p className="help">{check.description}</p>
                        )}
                      </td>
                      <td>
                        {check.active_version === null
                          ? "Unpublished"
                          : `v${check.active_version}`}
                        {check.active_version !== null &&
                          check.has_draft_changes && (
                            <span className="draft-indicator"> · Draft</span>
                          )}
                      </td>
                      <td>
                        <Time at={check.updated_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={resource.data}
              onNext={(cursor) => setParams({ cursor })}
            />
          </>
        ) : (
          <div className="empty">
            <h2>Protect an action.</h2>
            <p>Create a check for an action your application protects.</p>
            <Link to="/settings#connection">Connect application →</Link>
          </div>
        )
      ) : resource.loading ? (
        <Loading />
      ) : null}
    </>
  );
}

export function CheckPage() {
  const { name = "" } = useParams();
  const resource = useResource<Check>(`/checks/${encode(name)}`);
  const catalog = useResource<Page<Metric>>("/metrics?limit=100");
  return (
    <>
      <ResourceError resource={resource} />
      <ResourceError resource={catalog} />
      {resource.data && catalog.data ? (
        <CheckWorkspace
          key={name}
          initial={resource.data}
          metrics={catalog.data.items}
        />
      ) : resource.loading || catalog.loading ? (
        <Loading />
      ) : null}
    </>
  );
}

function CheckWorkspace({
  initial,
  metrics,
}: {
  initial: Check;
  metrics: Metric[];
}) {
  const [params, setParams] = useSearchParams();
  const origin = useActivityOrigin();
  const [model] = useState(() => {
    let storage: Storage | undefined;
    try {
      storage = window.sessionStorage;
    } catch {
      /* Leave warning visible in restricted contexts. */
    }
    return new DraftController(api, initial, storage);
  });
  const draft = useSyncExternalStore(model.subscribe, model.snapshot);
  const versions = useResource<Page<Version>>(
    `/checks/${encode(initial.name)}/versions?limit=100${params.has("versions_cursor") ? `&cursor=${encode(params.get("versions_cursor")!)}` : ""}`,
  );
  const active = useResource<Version>(
    draft.server.active_version === null
      ? null
      : `/checks/${encode(initial.name)}/versions/${draft.server.active_version}`,
  );
  const activePolicy = active.data;
  const [review, setReview] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy =
    fetching ||
    draft.action?.status === "running" ||
    draft.action?.status === "recovering";
  const location = useLocation();
  const currentLocation = useRef(location.key);
  currentLocation.current = location.key;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
      model.dispose();
    },
    [model],
  );
  const [latest, setLatest] = useState<Check | null>(null);
  const [restore, setRestore] = useState<Version | null>(null);
  const editing =
    params.get("view") === "draft" ||
    (draft.server.active_version === null && !params.has("version"));
  const historical = params.has("version");
  const selectedVersion = historical
    ? Number(params.get("version"))
    : draft.server.active_version;
  const selectedResource = useResource<Version>(
    historical && selectedVersion !== null
      ? `/checks/${encode(initial.name)}/versions/${selectedVersion}`
      : null,
  );
  const selected = historical ? selectedResource.data : activePolicy;
  const invalid = policyError(draft.policy);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      model.dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search),
  );
  useBeforeUnload((event) => {
    if (model.dirty || model.pending) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  useEffect(() => {
    if (draft.action?.status === "recovering") {
      void model.retryAction();
      return;
    }
    if (draft.status !== "changed" || invalid || model.pendingAction) return;
    const timer = setTimeout(() => void model.save(), 700);
    return () => clearTimeout(timer);
  }, [
    draft.policy,
    draft.description,
    draft.status,
    draft.action,
    invalid,
    model,
  ]);
  useEffect(() => {
    if (historical || !editing) {
      setReview(false);
      setRestore(null);
    }
  }, [historical, editing]);
  const canReview =
    !model.dirty &&
    !model.pendingAction &&
    draft.status === "saved" &&
    !invalid &&
    (draft.server.active_version === null ||
      activePolicy?.version === draft.server.active_version);

  async function publish() {
    const originKey = location.key;
    const result = model.pendingAction
      ? await model.retryAction()
      : await model.publish();
    if (!result || !mounted.current || currentLocation.current !== originKey)
      return;
    setReview(false);
    setParams(origin ? { return_to: origin } : {});
    void versions.refresh();
  }
  async function fetchLatest() {
    const origin = location.key;
    setFetching(true);
    setError(null);
    try {
      const latest = await api.get<Check>(`/checks/${encode(initial.name)}`);
      if (mounted.current && currentLocation.current === origin)
        setLatest(latest);
    } catch (cause) {
      if (mounted.current && currentLocation.current === origin)
        setError(errorMessage(cause));
    } finally {
      if (mounted.current) setFetching(false);
    }
  }
  async function restorePolicy(version: Version) {
    const originKey = location.key;
    const result = model.pendingAction
      ? await model.retryAction()
      : await model.restore(version.version);
    if (!result || !mounted.current || currentLocation.current !== originKey)
      return;
    setRestore(null);
    setParams(
      origin ? { view: "draft", return_to: origin } : { view: "draft" },
    );
  }

  return (
    <>
      <PageTitle
        title={initial.name}
        eyebrow={
          <>
            <Link to="/checks">Checks</Link>
            {origin && (
              <>
                {" "}
                · <ActivityReturn />
              </>
            )}
          </>
        }
      >
        {editing ? (
          <button
            className="primary"
            disabled={!canReview || busy || review}
            onClick={() => {
              setReview(true);
              setError(null);
            }}
          >
            Review and publish
          </button>
        ) : (
          <Link className="button primary" to={`?view=draft`}>
            Edit {historical ? "current " : ""}policy
          </Link>
        )}
      </PageTitle>
      <div className="check-context">
        <p>
          {!editing &&
            draft.server.active_version !== null &&
            draft.server.has_draft_changes && (
              <span className="draft-indicator">
                Unpublished draft changes ·{" "}
              </span>
            )}
          {editing
            ? `Editing draft · ${draft.server.active_version === null ? "Unpublished" : `Active v${draft.server.active_version}`}`
            : `Policy v${selectedVersion}${historical ? " · Read-only version" : " · Active"}`}
        </p>
        <div className="actions">
          <Link to={`/activity?check=${encode(initial.name)}`}>
            View activity
          </Link>
          <Link to={`/settings?check=${encode(initial.name)}#connection`}>
            Integration
          </Link>
          <a href="#versions">Versions</a>
        </div>
      </div>
      {draft.notice && (
        <p className="confirmation" role="status">
          {draft.notice}
        </p>
      )}
      {draft.action && (
        <Notice>
          {draft.action.error ??
            `${draft.action.status === "recovering" ? "Recovering" : "Completing"} the earlier ${draft.action.kind === "publish" ? "publication" : "restoration"} of draft revision ${draft.action.revision}. Newer local edits are preserved and are not included in that request.`}
          {draft.action.status === "failed" && model.pendingAction && (
            <button onClick={() => void model.retryAction()}>
              Retry{" "}
              {draft.action.kind === "publish" ? "publication" : "restoration"}
            </button>
          )}
          {draft.status === "conflict" && (
            <button disabled={busy} onClick={() => void fetchLatest()}>
              Compare current draft
            </button>
          )}
        </Notice>
      )}
      <ResourceError resource={active} />
      {error && <Notice>{error}</Notice>}
      {blocker.state === "blocked" && (
        <section className="notice" role="alert">
          <div>
            <h2>Leave with unsaved changes?</h2>
            <p>
              Your edits have not reached Krine.
              {draft.recoveryAvailable
                ? " A recovery copy remains in this browser tab."
                : " Browser recovery storage is unavailable; stay here to save your work."}
            </p>
            <div className="actions">
              <button className="primary" onClick={() => blocker.reset()}>
                Stay and save
              </button>
              <button onClick={() => blocker.proceed()}>Leave page</button>
            </div>
          </div>
        </section>
      )}
      {latest && (
        <section className="review">
          <h2>Reconcile the shared draft</h2>
          <p>
            Your local work is preserved. Review the latest saved draft before
            choosing which complete definition to keep. Publication is a
            separate action.
          </p>
          <h3>Latest shared draft · revision {latest.draft_revision}</h3>
          <PolicyRead policy={latest.draft} />
          <h3>Your local draft</h3>
          <PolicyRead policy={draft.policy} />
          <div className="actions">
            <button
              onClick={() => {
                model.reconcile(latest, true);
                setLatest(null);
                setReview(false);
                setError(null);
              }}
            >
              Replace shared draft with my work
            </button>
            <button
              onClick={() => {
                model.reconcile(latest, false);
                setLatest(null);
                setReview(false);
                setError(null);
              }}
            >
              Discard my edits and use shared draft
            </button>
            <button onClick={() => setLatest(null)}>Cancel</button>
          </div>
        </section>
      )}
      {editing ? (
        <>
          {review ? (
            <section className="review">
              <h2>Review publication</h2>
              <p>
                Applies to new attempts immediately. Existing attempts retain
                their original policy.
              </p>
              {draft.server.restored_from_version != null && (
                <p>
                  Restores the definition of version{" "}
                  {draft.server.restored_from_version} as a new version.
                </p>
              )}
              <ul className="change-list">
                {policyChanges(activePolicy?.policy, draft.policy).map(
                  (change, index) => (
                    <li key={index}>{change}</li>
                  ),
                )}
              </ul>
              <h3>
                Policy to publish · draft revision {draft.server.draft_revision}
              </h3>
              <PolicyRead policy={draft.policy} />
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void publish()}
                >
                  {busy ? "Publishing…" : "Publish version"}
                </button>
                <button
                  disabled={busy || model.pendingAction}
                  onClick={() => setReview(false)}
                >
                  Back to editing
                </button>
              </div>
            </section>
          ) : (
            <>
              <div className="draft-status" aria-live="polite">
                {draft.status === "saved"
                  ? `Draft saved. ${draft.server.active_version === null ? "No policy is active." : `Requests continue to use v${draft.server.active_version}.`}`
                  : draft.status === "saving"
                    ? "Saving…"
                    : draft.status === "changed"
                      ? "Unsaved changes…"
                      : draft.status === "conflict"
                        ? "Draft conflict. Local work preserved."
                        : "Save failed. Local work preserved."}
              </div>
              {draft.error && (
                <Notice>
                  {draft.error}
                  <div className="actions">
                    {draft.status === "conflict" ? (
                      <button
                        disabled={busy}
                        onClick={() => void fetchLatest()}
                      >
                        Compare shared draft
                      </button>
                    ) : (
                      <button onClick={() => void model.save()}>
                        Retry save
                      </button>
                    )}
                  </div>
                </Notice>
              )}
              {invalid && (
                <p className="error" role="alert">
                  {invalid}
                </p>
              )}
              {!draft.recoveryAvailable && model.dirty && (
                <p className="help">
                  Browser recovery storage is unavailable. Keep this page open
                  until the draft saves.
                </p>
              )}
              <label className="description-field">
                Description <span className="muted">(optional)</span>
                <input
                  autoComplete="off"
                  name="description"
                  value={draft.description}
                  maxLength={1024}
                  onChange={(event) =>
                    model.edit(draft.policy, event.target.value)
                  }
                />
              </label>
              <PolicyEditor
                policy={draft.policy}
                metrics={metrics}
                onChange={(policy) => {
                  model.edit(policy);
                }}
              />
            </>
          )}
        </>
      ) : selected ? (
        <>
          <PolicyRead policy={selected.policy} />
          {historical && (
            <button
              disabled={
                draft.status === "saving" || busy || model.pendingAction
              }
              onClick={() => {
                setRestore(selected);
              }}
            >
              Restore this policy
            </button>
          )}
        </>
      ) : selectedResource.error ? (
        <ResourceError resource={selectedResource} />
      ) : (historical ? selectedResource.loading : active.loading) ? (
        <Loading />
      ) : null}
      {restore && (
        <section className="review">
          <h2>Replace the current draft?</h2>
          <p>
            This replaces draft revision {draft.server.draft_revision}
            {model.dirty ? " and your unsaved local edits" : ""} with version{" "}
            {restore.version}. The active policy remains v
            {draft.server.active_version} until you review and publish.
          </p>
          <PolicyRead policy={restore.policy} />
          <div className="actions">
            <button disabled={busy} onClick={() => void restorePolicy(restore)}>
              {busy ? "Restoring…" : "Replace draft with this version"}
            </button>
            <button
              disabled={busy || model.pendingAction}
              onClick={() => setRestore(null)}
            >
              Cancel
            </button>
          </div>
        </section>
      )}
      <details id="versions" open={historical || params.has("versions_cursor")}>
        <summary>Versions</summary>
        <ResourceError resource={versions} />
        {versions.data ? (
          <>
            <ul className="version-list">
              {versions.data.items.map((version) => (
                <li key={version.version}>
                  <Link
                    to={`?version=${version.version}${params.has("versions_cursor") ? `&versions_cursor=${encode(params.get("versions_cursor")!)}` : ""}`}
                  >
                    Version {version.version}
                    {version.version === draft.server.active_version
                      ? " · Active"
                      : ""}
                  </Link>
                  <Time at={version.published_at} />
                </li>
              ))}
            </ul>
            {versions.data.items.length === 0 && (
              <p className="muted">No published versions.</p>
            )}
            <Pagination
              page={versions.data}
              onNext={(cursor) =>
                setParams((previous) => {
                  const next = new URLSearchParams(previous);
                  next.set("versions_cursor", cursor);
                  return next;
                })
              }
            />
          </>
        ) : versions.loading ? (
          <Loading />
        ) : null}
      </details>
    </>
  );
}
