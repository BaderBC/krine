import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useSearchParams,
} from "react-router-dom";
import { InvestigationLink as Link } from "./navigation";
import { encode } from "./api";
import { actionLabel, conditionLabel } from "./policy";
import { ProviderForm } from "./provider-form";
import { Loading, ResourceError, Time, useResource } from "./shared";
import type { Condition, Provider, Rule } from "./types";

function usesIntelligence(condition: Condition): boolean {
  if (condition.op === "all" || condition.op === "any")
    return condition.conditions.some(usesIntelligence);
  if (condition.op === "not") return usesIntelligence(condition.condition);
  const reference = condition.op === "known" ? condition.value : condition.left;
  return (
    reference.source === "metric" &&
    ["ip.risk", "ip.country", "ip.is_proxy", "ip.high_risk"].includes(
      reference.name,
    )
  );
}
function relevant(rule: Rule, capability: Provider["capability"]) {
  return capability === "verification"
    ? rule.then === "CHALLENGE" || rule.on_unknown === "CHALLENGE"
    : usesIntelligence(rule.condition);
}
const label = (capability: Provider["capability"]) =>
  capability === "verification" ? "Verification" : "IP intelligence";

function ProviderPanel({
  provider,
  selected,
  report,
}: {
  provider: Provider;
  selected: boolean;
  report: (
    capability: string,
    state: { dirty: boolean; pending: boolean },
  ) => void;
}) {
  const [model] = useState(() => new ProviderForm(provider));
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const [expanded, setExpanded] = useState(selected);
  const firstField = useRef<HTMLInputElement>(null);
  const secretField = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const previous = useRef({ phase: state.phase, review: state.review });
  useEffect(() => {
    model.observe(provider);
  }, [model, provider]);
  useEffect(() => {
    model.activate();
    return () => model.dispose();
  }, [model]);
  useEffect(() => {
    if (selected) setExpanded(true);
  }, [selected]);
  useEffect(() => {
    report(provider.capability, {
      dirty: model.dirty,
      pending: state.pending !== null,
    });
  }, [model, state, report, provider.capability]);
  useEffect(() => {
    if (previous.current.phase === "reviewing" && state.review)
      reviewHeading.current?.focus();
    else if (
      ["saving", "refreshing"].includes(previous.current.phase) &&
      state.phase === "idle"
    )
      feedback.current?.focus();
    else if (
      previous.current.review &&
      !state.review &&
      state.phase === "idle" &&
      !state.error &&
      !state.notice
    )
      (firstField.current ?? secretField.current)?.focus();
    previous.current = { phase: state.phase, review: state.review };
  }, [state]);
  const name = label(provider.capability);
  const verification = provider.capability === "verification";
  const server = state.server;
  const busy = ["saving", "refreshing", "reviewing"].includes(state.phase);
  return (
    <details
      className="provider"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span>{name}</span>{" "}
        <span className="provider-summary help">
          {verification ? "Turnstile" : "proxycheck"} ·{" "}
          {state.pending
            ? "Save unconfirmed"
            : state.needsRefresh
              ? "Refresh required"
              : server.enabled
                ? "Configured"
                : server.revision
                  ? "Disconnected"
                  : "Not configured"}
        </span>
      </summary>
      <p className="help">
        {server.message}
        {server.checked_at !== null && (
          <>
            {" "}
            Last configuration test <Time at={server.checked_at} />.
          </>
        )}
      </p>
      {server.enabled && (
        <p className="help">
          Connection tests do not guarantee later availability. Inspect the
          evidence in a real application attempt.
        </p>
      )}
      {state.notice && (
        <p ref={feedback} tabIndex={-1} className="confirmation" role="status">
          {state.notice}
        </p>
      )}
      {state.error && (
        <p ref={feedback} tabIndex={-1} className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.pending ? (
        <div className="provider-recovery">
          <p>
            The submitted change is preserved in this open form. Retrying uses
            the same configuration and request.
          </p>
          <button
            disabled={state.phase === "saving"}
            onClick={() => void model.save()}
          >
            {state.phase === "saving" ? "Saving…" : "Retry same save"}
          </button>
        </div>
      ) : state.needsRefresh ? (
        <button
          disabled={state.phase === "refreshing"}
          onClick={() => void model.refresh()}
        >
          {state.phase === "refreshing"
            ? "Refreshing…"
            : "Refresh current configuration"}
        </button>
      ) : state.conflict ? (
        <div className="provider-recovery">
          <p>
            Your entered values remain here. A new test is required after
            reconciling this change.
          </p>
          {state.conflictLoaded ? (
            <>
              <p className="help">
                Current configuration:{" "}
                {server.enabled ? "configured" : "disconnected"}
                {verification && typeof server.config.site_key === "string"
                  ? ` · Site key ${server.config.site_key}`
                  : ""}
                .{" "}
                {server.has_secret
                  ? "A secret key is stored."
                  : "No secret key is stored."}{" "}
                Keeping an empty secret field uses the current stored key.
              </p>
              <div className="actions">
                <button onClick={() => model.reconcile(true)}>
                  Keep entered values and test again
                </button>
                <button onClick={() => model.reconcile(false)}>
                  Use current configuration
                </button>
              </div>
            </>
          ) : (
            <button
              disabled={state.phase === "refreshing"}
              onClick={() => void model.refresh()}
            >
              Load latest configuration
            </button>
          )}
        </div>
      ) : state.review ? (
        <section
          className="provider-review"
          aria-label={`${name} change review`}
        >
          <h3 ref={reviewHeading} tabIndex={-1}>
            {state.review.enabled
              ? `Save ${name.toLowerCase()} configuration`
              : `Disconnect ${name.toLowerCase()}`}
          </h3>
          {state.review.enabled && (
            <>
              <dl className="facts">
                {verification && (
                  <div>
                    <dt>Site key</dt>
                    <dd className="identifier">{state.fields.siteKey}</dd>
                  </div>
                )}
                <div>
                  <dt>{verification ? "Secret key" : "API key"}</dt>
                  <dd>
                    {state.fields.clearSecret
                      ? "Remove stored key"
                      : state.fields.secret
                        ? "Use the newly entered key"
                        : server.has_secret
                          ? "Keep the stored key"
                          : "No key"}
                  </dd>
                </div>
              </dl>
              <p className="help">Candidate test: {state.test?.message}</p>
            </>
          )}
          <p>
            Applies to new attempts. Existing attempts keep their original
            evidence and provider configuration.
          </p>
          {!state.review.enabled && (
            <p>
              {verification
                ? "New attempts that require verification will be denied when this capability is unavailable."
                : "IP intelligence becomes unknown for new attempts. Each policy follows its explicit unknown path."}
            </p>
          )}
          {!state.review.enabled && model.dirty && (
            <p className="help">
              Disconnecting uses the active configuration and discards any
              entered replacement values.
            </p>
          )}
          {state.review.checks.length ? (
            <>
              <h4>Affected published checks</h4>
              <ul className="provider-dependents">
                {state.review.checks.map(({ name, version }) => (
                  <li key={name}>
                    <Link
                      to={`/checks/${encode(name)}?version=${version.version}`}
                    >
                      {name} · v{version.version}
                    </Link>
                    <ul>
                      {version.policy.rules.map(
                        (rule, index) =>
                          relevant(rule, provider.capability) && (
                            <li key={rule.id}>
                              Rule {index + 1}: {conditionLabel(rule.condition)}
                              . Then {actionLabel(rule.then)}. If the condition
                              is unknown: {actionLabel(rule.on_unknown)}.
                              {(rule.then === "CHALLENGE" ||
                                rule.on_unknown === "CHALLENGE") &&
                                " Verified continues below; failed, expired or unavailable verification denies."}
                            </li>
                          ),
                      )}
                    </ul>
                    <p className="help">
                      Otherwise {actionLabel(version.policy.otherwise)}.
                    </p>
                  </li>
                ))}
              </ul>
              <p className="help">
                Saving confirms these published versions and their failure
                paths. A concurrent publication requires a fresh review.
              </p>
            </>
          ) : (
            <p>No published checks currently depend on this capability.</p>
          )}
          <div className="actions">
            <button className="primary" onClick={() => void model.save()}>
              {state.review.enabled
                ? "Save configuration"
                : "Confirm disconnect"}
            </button>
            <button onClick={() => model.cancelReview()}>
              Back to configuration
            </button>
          </div>
        </section>
      ) : (
        <form
          className="provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            const error = model.validation();
            void model.test();
            if (error)
              (verification &&
              !/^[a-zA-Z0-9_-]{1,256}$/.test(state.fields.siteKey)
                ? firstField
                : secretField
              ).current?.focus();
          }}
        >
          {verification && (
            <label>
              Site key
              <input
                ref={firstField}
                name="site_key"
                autoComplete="off"
                spellCheck={false}
                maxLength={256}
                value={state.fields.siteKey}
                disabled={busy}
                onChange={(event) =>
                  model.edit({ siteKey: event.target.value })
                }
              />
            </label>
          )}
          <label>
            {verification ? "Secret key" : "API key (optional)"}
            <input
              ref={secretField}
              name="provider_secret"
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              value={state.fields.secret}
              disabled={busy || state.fields.clearSecret}
              onChange={(event) => model.edit({ secret: event.target.value })}
              aria-describedby={`secret-help-${provider.capability}`}
            />
          </label>
          <p id={`secret-help-${provider.capability}`} className="help">
            {server.has_secret
              ? "A key is stored. Leave this field empty to keep it, or enter a replacement."
              : verification
                ? "Use the secret paired with this site key."
                : "An API key is optional; provider limits still apply."}{" "}
            Entered secrets stay only in this open form and are never shown
            after saving.
          </p>
          {!verification && server.has_secret && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="clear_secret"
                checked={state.fields.clearSecret}
                disabled={busy}
                onChange={(event) =>
                  model.edit({ clearSecret: event.target.checked, secret: "" })
                }
              />
              Remove the stored API key from the new configuration
            </label>
          )}
          <p className="help">
            {verification
              ? "This checks the configuration format only. Live site-key and secret pairing must be verified through your application."
              : "Test a lookup for one public IP. Evidence for other IPs may differ, and missing fields remain unknown."}
          </p>
          <div className="actions">
            <button type="submit" disabled={busy || state.phase === "testing"}>
              {state.phase === "testing" ? "Testing…" : "Test configuration"}
            </button>
            {state.test?.test_token && (
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void model.review(true)}
              >
                {state.phase === "reviewing"
                  ? "Loading review…"
                  : "Review and save"}
              </button>
            )}
            {model.dirty && (
              <button
                type="button"
                disabled={busy}
                onClick={() => model.discard()}
              >
                Discard entered changes
              </button>
            )}
          </div>
          {state.test && (
            <div role="status" className="provider-test-result">
              <p>
                <strong>
                  {state.test.test_token
                    ? state.test.status === "ready"
                      ? "Test lookup succeeded."
                      : "Configuration checked."
                    : "Configuration test did not pass."}
                </strong>{" "}
                {state.test.message}
              </p>
              <p className="help">
                Tested <Time at={state.test.checked_at} />.{" "}
                {state.test.test_token
                  ? "Review and save within 10 minutes. Editing a field requires another test."
                  : "The active configuration is unchanged. Check the values or retry the test."}
              </p>
            </div>
          )}
          {server.enabled && (
            <div className="provider-disconnect">
              <button
                type="button"
                disabled={busy}
                onClick={() => void model.review(false)}
              >
                Review disconnect
              </button>
            </div>
          )}
        </form>
      )}
    </details>
  );
}

export function Providers() {
  const resource = useResource<{ items: Provider[] }>("/providers");
  const [params] = useSearchParams();
  const location = useLocation();
  const section = useRef<HTMLElement>(null);
  const loaded = Boolean(resource.data);
  useEffect(() => {
    if (loaded && location.hash === "#providers")
      section.current?.scrollIntoView({ block: "start" });
  }, [loaded, location.hash]);
  const [forms, setForms] = useState<
    Record<string, { dirty: boolean; pending: boolean }>
  >({});
  const [report] = useState(
    () => (capability: string, state: { dirty: boolean; pending: boolean }) =>
      setForms((previous) =>
        previous[capability]?.dirty === state.dirty &&
        previous[capability]?.pending === state.pending
          ? previous
          : { ...previous, [capability]: state },
      ),
  );
  const dirty = Object.values(forms).some((form) => form.dirty);
  const pending = Object.values(forms).some((form) => form.pending);
  const blocker = useBlocker(
    ({ nextLocation }) => dirty && nextLocation.pathname !== "/settings",
  );
  const dialog = useRef<HTMLDialogElement>(null);
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
  return (
    <section ref={section} id="providers">
      <h2>Providers</h2>
      <ResourceError resource={resource} />
      {resource.data ? (
        resource.data.items.map((provider) => (
          <ProviderPanel
            key={provider.capability}
            provider={provider}
            selected={params.get("provider") === provider.capability}
            report={report}
          />
        ))
      ) : resource.loading ? (
        <Loading />
      ) : null}
      <dialog
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          blocker.reset?.();
        }}
      >
        <h2>
          {pending
            ? "A provider save is unconfirmed."
            : "Leave with unsaved provider changes?"}
        </h2>
        <p>
          {pending
            ? "Stay here and retry the same save to recover its result. The change may already have been applied."
            : "Entered values and test results are kept only in this open form. Leaving discards them."}
        </p>
        <div className="actions">
          <button onClick={() => blocker.reset?.()}>
            Stay with configuration
          </button>
          {!pending && (
            <button onClick={() => blocker.proceed?.()}>
              Discard and leave
            </button>
          )}
        </div>
      </dialog>
    </section>
  );
}
