import { useEffect, useRef, useState } from "react";
import { useBeforeUnload, useBlocker, useSearchParams } from "react-router-dom";
import { Loading, ResourceError, PageTitle, useResource } from "./shared";
import { InvestigationLink as Link } from "./navigation";
import { encode } from "./api";
import { Providers } from "./Providers";
import { Credentials } from "./Credentials";
import type { SettingsWork } from "./Credentials";
import type { Setup } from "./types";

function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

function validSetup(value: unknown): value is Setup {
  if (!value || typeof value !== "object") return false;
  const setup = value as Setup;
  const counts = setup.active_credentials;
  return Boolean(
    validOrigin(setup.browser_url) &&
      validOrigin(setup.server_url) &&
      Array.isArray(setup.allowed_origins) &&
      setup.allowed_origins.every(validOrigin) &&
      counts &&
      Number.isSafeInteger(counts.browser) &&
      counts.browser >= 0 &&
      Number.isSafeInteger(counts.server) &&
      counts.server >= 0 &&
      (counts.browser === 0
        ? setup.public_key === null && setup.browser_credential_id === null
        : typeof setup.public_key === "string" &&
          Boolean(setup.public_key) &&
          typeof setup.browser_credential_id === "string" &&
          Boolean(setup.browser_credential_id)) &&
      typeof setup.sdk?.browser_package === "string" &&
      Boolean(setup.sdk.browser_package) &&
      typeof setup.sdk?.server_package === "string" &&
      Boolean(setup.sdk.server_package),
  );
}

export function Settings() {
  const setup = useResource<Setup>("/setup", validSetup);
  const [params] = useSearchParams();
  const check = params.get("check") ?? "can_claim_trial";
  const config = setup.data;
  const [providerWork, setProviderWork] = useState<SettingsWork>({
    dirty: false,
    pending: false,
  });
  const [credentialWork, setCredentialWork] = useState<SettingsWork>({
    dirty: false,
    pending: false,
  });
  const dirty = providerWork.dirty || credentialWork.dirty;
  const pending = providerWork.pending || credentialWork.pending;
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
  const httpOption = (url: string) =>
    url.startsWith("http:")
      ? "\n  allowInsecureHttp: true, // Local development only."
      : "";
  return (
    <>
      <PageTitle title="Settings" />
      {params.has("check") && (
        <p className="help">
          <Link
            to={`/checks/${encode(check)}${params.has("provider") ? "?view=draft" : ""}`}
          >
            {params.has("provider")
              ? "Return to policy draft"
              : "Back to check"}{" "}
            · {check}
          </Link>
        </p>
      )}
      <section id="connection">
        <h2>Application connection</h2>
        {setup.error && <ResourceError resource={setup} />}
        {config ? (
          <>
            <dl className="facts">
              <div>
                <dt>Browser URL</dt>
                <dd className="identifier">{config.browser_url}</dd>
              </div>
              <div>
                <dt>Server URL</dt>
                <dd className="identifier">{config.server_url}</dd>
              </div>
              <div>
                <dt>Allowed browser origins</dt>
                <dd>
                  {config.allowed_origins.map((origin) => (
                    <div key={origin} className="identifier">
                      {origin}
                    </div>
                  ))}
                </dd>
              </div>
              <div>
                <dt>Public browser key</dt>
                <dd className="identifier">
                  {config.public_key ?? "No active browser key"}
                </dd>
              </div>
            </dl>
            <p className="help">
              The public key identifies this installation. Keep the server
              secret exclusively in your application backend.
            </p>
            <Credentials
              setup={config}
              refreshSetup={setup.refresh}
              report={setCredentialWork}
            />
            <details id="integration-reference">
              <summary>SDK integration reference</summary>
              <h3>Browser · @krine/browser 0.1.0</h3>
              {config.public_key === null ? (
                <p>
                  Create a browser key in Application credentials to get a
                  ready-to-use browser example.
                </p>
              ) : (
                <Code>{`import { KrineBrowser } from '@krine/browser';

const browser = new KrineBrowser({
  url: ${JSON.stringify(config.browser_url)},${httpOption(config.browser_url)}
  publicKey: ${JSON.stringify(config.public_key)},
});
await browser.initialize();

// Immediately before the protected request:
const { proof } = await browser.prepare(${JSON.stringify(check)});
// Send proof with the request to your own backend.
// Retain it unchanged for retries of this action.`}</Code>
              )}
              <h3>Application backend · @krine/server 0.1.0</h3>
              <Code>{`import { KrineServer } from '@krine/server';

const krine = new KrineServer({
  url: ${JSON.stringify(config.server_url)},${httpOption(config.server_url)}
  secretKey: process.env.KRINE_SECRET_KEY!,
  fallback: 'ALLOW', // Default; example configuration, not observed state.
  checkFallbacks: { ${JSON.stringify(check)}: 'DENY' },
});

// Store this immutable request in your application's operation record.
// Derive userId from authentication and ip from your trusted proxy setup.
const request = {
  operation_id: operation.id,
  check: ${JSON.stringify(check)},
  proof: operation.originalProof,
  ip: operation.ip,
  user_id: operation.userId,
};

// pending and result come from trusted, durable application storage.
const result = operation.pending
  ? await krine.continueCheck(operation.pending, verification)
  : await krine.check(request);

if (result.outcome === 'CHALLENGE_REQUIRED') {
  // Persist result.pending; return result.challenge to the browser.
  // Keep the action pending. Widget success is not authorization.
} else if (result.outcome === 'DENY') {
  // Persist the final result and reject the action.
} else {
  // Persist result, then execute your action exactly once.
  // result.source distinguishes evaluation from local fallback.
}`}</Code>
              {(config.browser_url.startsWith("http:") ||
                config.server_url.startsWith("http:")) && (
                <p className="help">
                  These HTTP URLs require the explicit local-development option
                  shown above. Use HTTPS and remove that option in production.
                </p>
              )}
              <p className="help">
                This integration sketch uses your application’s durable
                operation record. The application must persist pending/final
                results, validate verification input, and prevent duplicate
                action execution. Never trust a browser-supplied pending or
                final result.
              </p>
              <p>
                Initial proofs expire after 60 seconds and bind to the observed
                IP and check. Retry the same operation ID and immutable request;
                do not replace its proof. Stop retries at the returned{" "}
                <code>retry_until</code>. A known verification requirement never
                becomes Allow through a continuation timeout.
              </p>
              <details>
                <summary>Evidence before the protected check</summary>
                <Code>{`// Resolve the exact proof and backend-observed IP used by this attempt.
const context = await krine.resolveContext({
  interaction: { proof: request.proof, check: request.check, ip: request.ip },
});
await krine.associate({
  association_id: operation.associationId,
  client_id: context.client_id,
  user_id: authenticatedUser.id,
});
await krine.event({
  event_id: operation.eventId,
  name: 'trial_requested',
  client_id: context.client_id,
  session_id: context.session_id,
  user_id: authenticatedUser.id,
});
// Then call check(request); retry with the same durable IDs and content.`}</Code>
                <p className="help">
                  Use this form when the new evidence must affect the protected
                  check. Resolving a proof does not consume it or authorize the
                  action.
                </p>
              </details>
              <details>
                <summary>Backend events and user relationships</summary>
                <Code>{`// Browser: send opaque credentials to your authenticated application.
const credentials = await browser.getContextCredentials();

// Backend: resolve credentials before asserting an association.
const context = await krine.resolveContext(credentials);
await krine.event({
  event_id: loginEvent.id, // Persist once; reuse across retries.
  name: 'user_logged_in',
  client_id: context.client_id,
  session_id: context.session_id,
  user_id: authenticatedUser.id,
});
await krine.associate({
  association_id: association.id,
  client_id: context.client_id,
  user_id: authenticatedUser.id,
});`}</Code>
                <p className="help">
                  Event and association IDs identify immutable content for the
                  24-hour supported retry window. Browser-selected identifiers
                  never establish authoritative relationships.
                </p>
              </details>
            </details>
            <details>
              <summary>Availability behavior</summary>
              <p>
                The server SDK defaults to local Allow on eligible initial
                transport failures, timeouts, rate limits and service errors.
                Set a global or per-check override in your application. A
                dashboard policy cannot configure an unreachable SDK.
                Authentication, proof, validation and conflict errors do not use
                fallback.
              </p>
            </details>
          </>
        ) : setup.loading ? (
          <Loading />
        ) : null}
      </section>
      <Providers reportWork={setProviderWork} />
      <dialog
        ref={dialog}
        onCancel={(event) => {
          event.preventDefault();
          blocker.reset?.();
        }}
      >
        <h2>
          {credentialWork.pending
            ? "A credential request is unconfirmed."
            : providerWork.pending
              ? "A provider save is unconfirmed."
              : credentialWork.secret
                ? "Leave without this server secret?"
                : providerWork.dirty
                  ? "Leave with unsaved provider changes?"
                  : "Leave with an unfinished credential?"}
        </h2>
        <p>
          {pending
            ? "Stay here and retry the same request to recover its result. The change may already have been applied."
            : credentialWork.secret
              ? "Copy and save the secret before leaving. Krine cannot show it again; otherwise, revoke it and create a replacement."
              : "Entered values are kept only in this open form. Leaving discards them."}
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
    </>
  );
}
