# TypeScript SDKs

`@krine/browser` obtains browser context, fresh proofs and verification evidence. `@krine/server` submits authoritative facts and evaluates protected actions. Both use `@krine/protocol` for wire types, validation and bounded transport. None of these packages has a third-party runtime dependency. Keep the server package and its secret key out of browser bundles.

The workspace uses pnpm 11.28.2, pinned in `packageManager`, and TypeScript 5.9.3. Workspace development uses Node.js 24.21 LTS, pinned in `.node-version`; Node.js 26 is also supported. The server SDK requires Node.js 22 or later with built-in `fetch`. The browser SDK targets modern browsers with Fetch, Web Crypto and ES2022; blocked storage and unavailable optional evidence are supported. Packages export ESM and TypeScript declarations.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

The test suite includes a real loopback HTTP test; its environment must allow binding a local port. To consume release packages in an application, use `pnpm add @krine/browser` in the browser workspace and `pnpm add @krine/server` in the backend workspace. Until releases are published, pnpm workspace dependencies or `pnpm pack` provide the same build outputs.

## Browser participation

```ts
import { KrineBrowser } from '@krine/browser';

const krine = new KrineBrowser({
  url: 'https://trust.example.com',
  publicKey: 'your-project-public-key',
});

await krine.initialize();
// Immediately before sending an action to your application backend:
const { proof } = await krine.prepare('can_register');
// Submit proof with the application's stable business-operation identifier.
```

The configured Krine URL may include a deployment path prefix. HTTPS is required unless `allowInsecureHttp: true` explicitly enables local development. Krine must permit the application's exact browser origin.

Client credentials use local storage, and session credentials use session storage. Storage keys identify the installation by its normalized Krine URL, including any deployment path prefix. Changing the public key at that URL preserves valid client and session context. Different URLs have separate context. A stored session is reused only with its matching client credential. Context IDs always come from Krine. If storage access fails, the current SDK instance keeps its credentials in memory; a new page may receive a new context. Set either storage option to `null` to disable it. During proof preparation, `invalid_context` or `context_expired` triggers one context repair and one new proof request. Other validation, project authentication and origin failures are surfaced without repair.

Earlier SDK builds included the public key in storage keys. This SDK reads those entries for the currently configured public key when URL-based entries are absent, then writes URL-based entries after successful initialization. It does not search storage for other public keys. Deploy the updated SDK with the existing key before rotating to its replacement. Browsers must initialize the updated SDK at least once with the existing key to migrate; visitors who return only after both SDK and key have changed receive new context.

The default collector records bounded language, timezone, platform, screen size, hardware concurrency and `navigator.webdriver` evidence when available. A SHA-256 hash of these normalized signals supplies a basic fingerprint. These values are spoofable evidence, never identity or proof of humanity. A `signals` callback can replace collection for application consent handling; `signals: () => ({})` sends no optional browser evidence. Missing or invalid values stay absent.

## Authoritative application integration

```ts
import { KrineServer } from '@krine/server';

const krine = new KrineServer({
  url: 'https://trust.example.com',
  secretKey: process.env.KRINE_SERVER_KEY!,
  fallback: 'ALLOW',
  checkFallbacks: { can_withdraw: 'DENY' },
  timeoutMs: 3000,
  retries: 1,
});

const result = await krine.check({
  operation_id: savedAttempt.operationId,
  check: 'can_register',
  proof: savedAttempt.originalProof,
  ip: savedAttempt.originalIp,
  user_id: authenticatedUser.id,
  inputs: { amount: authoritativeAmount },
});
```

Before calling Krine, persist one immutable request per business intent. Generate the operation ID once; reuse it across transport retries, local fallback, process restarts and verification. Derive IP using the application's trusted proxy configuration. Select the check, authenticated user and sensitive inputs on the backend. Store the original proof and IP; do not replace them during recovery. Reject browser requests that try to change the saved action's immutable content.

Before submitting pre-check associations or events, bind their context to that saved action:

```ts
const context = await krine.resolveContext({
  interaction: {
    proof: savedAttempt.originalProof,
    check: 'can_register',
    ip: savedAttempt.originalIp,
  },
});
// Persist the resolution and authoritative event/association inputs before sending them.
// Use context.client_id and context.session_id, never browser-asserted IDs.
```

This read-only mode derives context directly from the issued proof; it rejects mixed credential/interaction envelopes and browser-selected IDs. No separate credential pair is needed, so context renewal cannot accidentally mix two sessions. A still-valid proof remains resolvable after its participation credentials expire. It does not consume the proof or authorize the action. Resolution errors never apply availability fallback. An interrupted application resumes its saved resolution/event progress; it does not resolve an already accepted attempt again after the proof's initial acceptance window.

A result has `source: 'evaluation'` or `source: 'fallback'`. Evaluated outcomes are `ALLOW`, `DENY` or `CHALLENGE_REQUIRED`. Only final Allow permits the protected action. A fallback result has no decision ID or policy version; it identifies the configured Allow/Deny and its availability reason. Record fallback separately from an evaluated decision.

Krine recovery does not deduplicate the application's protected action. Use a durable application record and a transaction or equivalent operation-specific guard to ensure one business effect, including after fallback Allow. Atomically associate the business result with the operation ID where possible. Subsequent retries return that stored business result. Stop recovery at the evaluated `retry_until`; if the first result is unknown, limit recovery to 24 hours after the first attempt.

## Pending verification must survive processes

A challenge result includes `challenge` for the browser and `pending` for trusted application storage. Persist `pending` before returning the challenge. It contains the original request, proof and accepted operation identity. Never send it to the browser, log it, or reconstruct it from browser input. Authenticate and authorize access to the application attempt before loading it.

Every retry after a known challenge must use `continueCheck(savedPending, verification?)`, even if no token is available yet. This method never applies fallback. A timeout or unavailable service throws `AvailabilityError`; keep the action pending and retry the same saved context. Do not catch that error and call `check` again. Calling the initial API loses knowledge of the challenge and re-enables initial availability fallback.

The essential application flow is:

```ts
// savedAttempt is loaded under the application's concurrency control.
// verification is only the browser's { challenge_id, token } evidence.
const result = savedAttempt.pending
  ? await krine.continueCheck(savedAttempt.pending, verification)
  : await krine.check(savedAttempt.request);

if (result.outcome === 'CHALLENGE_REQUIRED') {
  await savePendingAtomically(savedAttempt.id, result.pending);
  return { outcome: result.outcome, challenge: result.challenge };
}
if (result.outcome === 'DENY') return denyAction();
return executeBusinessActionOnce(savedAttempt.id);
```

These application persistence functions are illustrative: use your application's durable store and concurrency semantics. Keep an existing pending context until the final decision is durably recorded. Serialize concurrent handlers for one attempt, or use a database compare-and-swap that prevents stale initial results from overwriting pending state. A separate application process loads the same persisted context and uses the same continuation API. Failed widget completion never clears the pending requirement.

The browser can render the public challenge with the supplied helper:

```ts
import { solveChallenge } from '@krine/browser';

const verification = await solveChallenge(challenge, widgetContainer, {
  signal: abortController.signal,
  // nonce: 'your-CSP-nonce',
});
// Send verification with the existing application attempt ID.
// The backend loads its saved pending context and calls continueCheck.
```

The helper loads Cloudflare's explicit Turnstile script, supplies each challenge's site key, action and binding, and removes its widget on success, failure, cancellation or timeout. Provider errors reject with a typed `KrineError` code. Script loading is shared per document and times out after ten seconds; failed loads can be retried. A caller may provide an already loaded `adapter` if the application owns script loading. Set the application's CSP to permit the provider script and frame as described in [Cloudflare's CSP documentation](https://developers.cloudflare.com/turnstile/reference/content-security-policy/).

Verification may return another challenge with a different ID and binding. Save its new pending context and render a fresh widget. Widget completion supplies evidence only; wait for the backend's final evaluated Allow before performing the action. Provider availability during verification is handled by Krine's evaluated denial semantics, never converted to local fallback Allow.

## Events and identity

The browser sends its opaque participation credentials to the application's trusted backend. Use the authenticated application's own CSRF protection and send credentials only in an HTTPS request body:

```ts
// Browser, after the application's login succeeds:
const credentials = await krine.getContextCredentials();
await fetch('/api/session/krine-context', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': applicationCsrfToken },
  body: JSON.stringify(credentials),
});
```

In that continuous-session handler, authenticate the user and validate CSRF before resolving the supplied credentials with the server SDK. This credential-only mode does not bind a separately supplied action proof; use the interaction mode above for pre-check evidence:

```ts
// Backend: requestBody comes from the bounded, decoded request body.
// authenticatedUser comes from the application's verified session, never requestBody.
const context = await krine.resolveContext({
  client_token: requestBody.client_token,
  session_token: requestBody.session_token,
});

// Persist these immutable event/association requests with stable IDs before submission.
await krine.event({
  event_id: savedEvent.id,
  name: 'authenticated_login',
  user_id: authenticatedUser.id,
  client_id: context.client_id,
  session_id: context.session_id,
});

await krine.associate({
  association_id: savedAssociation.id,
  client_id: context.client_id,
  session_id: context.session_id,
  user_id: authenticatedUser.id,
  metadata: { source: 'authenticated_login' },
});
```

Persist the chosen association request before its first send. Include the resolved session for new assertions; recovery must reuse an older assertion’s exact original envelope, including an omitted session. Adding a session during recovery changes its immutable content.

`resolveContext` calls the server-authenticated `/v1/contexts/resolve` endpoint. Krine validates the existing client/session credential pair and returns its IDs and expiry. It rejects missing, mismatched or expired context instead of creating a replacement. Resolve before persisting the event/association requests; on retry, submit those saved requests without replacing their original IDs or context. Do not accept `client_id`, `session_id` or `user_id` from the browser as authoritative relationship inputs.

Resolution establishes possession of Krine participation credentials. It does not prove humanity or identify an application user. Only the application's authenticated session supplies that identity. Never put participation credentials in URLs, logs or third-party requests. Resolution errors prevent attaching context; the server SDK does not manufacture an identity or apply availability fallback.

Events and associations require stable IDs and immutable bodies just like checks. A successful event acknowledgement means its supported metric effects are visible. A failed request has an unknown outcome: retry the original ID and exact body within 24 hours. These methods throw on availability failures; they never invent acknowledgements or apply check fallback.

## Error and retry contract

`timeoutMs` is one total request deadline, including all retries and body reading; it defaults to 3000 and is bounded to 1–60000 ms. `retries` defaults to one additional attempt and is bounded to 0–3. Availability retries reuse the serialized body byte for byte. Retry-After delays are respected when they fit the deadline; otherwise the availability failure is returned immediately. The transport never follows redirects, releases unfinished responses on terminal completion, and bounds request and response bodies to 64 KiB.

Only transport failure, timeout, 429 and generic 5xx availability errors qualify for initial check fallback. Explicit proof, authentication, validation, configuration, conflict and provider errors do not, even if mislabeled with a 5xx status. Malformed or mismatched successful responses raise `KrineError` with `code: 'invalid_response'`. Fallback settings cannot weaken continuation behavior.

`HttpError` carries status and a bounded machine-readable code. `AvailabilityError` carries `reason: 'timeout' | 'unavailable' | 'rate_limited'`. Errors omit upstream bodies, request content, credentials and raw network errors. Application logs must also avoid proof tokens, browser credentials, pending contexts and provider tokens.

Associations can include `session_id` from `resolveContext` when the backend
knows the session that supplied the assertion. It must belong to `client_id`.
Keep `association_id` stable across delivery retries. A later retry can return a
non-null `revoked_at` after administrative correction; this is a successful
receipt of the original assertion, not a request to reinstate it. A new genuine
backend assertion uses a new association ID. Omitted or null session preserves
legacy association request identity.
