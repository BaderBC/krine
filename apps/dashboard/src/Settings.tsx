import { useSearchParams } from "react-router-dom";
import { Loading, ResourceError, PageTitle, useResource } from "./shared";
import { InvestigationLink as Link } from "./navigation";
import { encode } from "./api";
import { Providers } from "./Providers";
import type { Setup } from "./types";

function Code({ children }: { children: string }) {
  return (
    <pre>
      <code>{children}</code>
    </pre>
  );
}

export function Settings() {
  const setup = useResource<Setup>("/setup");
  const [params] = useSearchParams();
  const check = params.get("check") ?? "can_claim_trial";
  const config = setup.data;
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
                <dd className="identifier">{config.public_key}</dd>
              </div>
            </dl>
            <p className="help">
              The public key identifies this installation. Keep the server
              secret exclusively in your application backend.
            </p>
            <details id="integration-reference">
              <summary>SDK integration reference</summary>
              <h3>Browser · @krine/browser 0.1.0</h3>
              <Code>{`import { KrineBrowser } from '@krine/browser';

const browser = new KrineBrowser({
  url: ${JSON.stringify(config.browser_url)},
  publicKey: ${JSON.stringify(config.public_key)},
});
await browser.initialize();

// Immediately before the protected request:
const { proof } = await browser.prepare(${JSON.stringify(check)});
// Send proof with the request to your own backend.
// Retain it unchanged for retries of this action.`}</Code>
              <h3>Application backend · @krine/server 0.1.0</h3>
              <Code>{`import { KrineServer } from '@krine/server';

const krine = new KrineServer({
  url: ${JSON.stringify(config.server_url)},
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
      <Providers />
    </>
  );
}
