# Protected trial application

Draftroom demonstrates a real, durable seven-day trial entitlement protected by Krine. The browser supplies a fresh proof. The application authenticates the account, resolves the proof's context, records trusted evidence, evaluates `can_claim_trial`, and grants the benefit once. Authorization details distinguish evaluated decisions from application fallback.

This is a small integration example with three generated accounts. It is not an account-management product. The production SDKs and Krine API perform every trust interaction; there is no outcome selector or verification bypass.

## Run with Docker

From the repository root, with Docker Compose 2.24.4 or newer:

```sh
./scripts/up.sh --local --example
```

Open **http://127.0.0.1:8080** and sign in with `deploy/secrets/admin_password`. Review and publish `can_claim_trial` using the policy below. Open **http://localhost:3000** for Draftroom. Read the generated account passwords locally:

```sh
docker compose --env-file deploy/example/local.env.example -f compose.yaml -f compose.app.yaml -f compose.example.yaml exec --user 10001:10001 example cat /var/lib/draftroom/accounts.json
```

Account passwords and SQLite data live in the private `example_data` named volume, outside the image and checkout. Subsequent runs preserve accounts, grants, attempts and event delivery. To stop the stack while retaining data, use the same Compose arguments with `down`; do not add `--volumes`. Keep using `--example` when upgrading this installation. The helper closes ingress and drains the example before stopping the old Krine writer.

Set `KRINE_HTTP_PORT` and `KRINE_EXAMPLE_PORT` to free loopback ports before running the command. If `10.203.80.0/24` overlaps a host route or Docker network, set `KRINE_EXAMPLE_NETWORK_PREFIX` to the first three octets of an unused private /24 (for example `10.203.81`). The ingress uses `.2`; Docker allocates other addresses from `.128/25`, outside the trusted address. Keep these overrides consistent across commands; changing a used network requires stopping this stack with `down` first, preserving volumes.

The local Nginx ingress publishes both ports. It replaces incoming forwarding headers with its actual socket peer, and both services trust only its exact address. Docker Desktop/VM routing may present a gateway address instead of a unique host visitor address; that is the real address visible at this boundary, shared by both requests. The example does not invent a loopback IP. Only Krine joins the storage network; the example and ingress use a separate network. Direct application ports are not published.

For credential rotation, issue a new browser key and server secret in Krine Settings. Save them in separate owner-only files, set `KRINE_EXAMPLE_PUBLIC_KEY_FILE` and `KRINE_EXAMPLE_SERVER_SECRET_FILE` to their absolute paths, then rerun the command. Verify the example before revoking its previous keys. Keep these overrides for future restarts. The default paths use the original bootstrap keys; changing Krine's bootstrap files cannot rotate or restore managed credentials. The SQLite volume and original business-operation records remain unchanged across this restart.

This preset deliberately enables local HTTP and development cookies. For public deployment, configure a sanitizing HTTPS ingress and secure origins as described under [Deployment boundary](#deployment-boundary); do not expose these local ports publicly or place another proxy in front without redesigning and testing the trusted hop boundary.

## Run against native Krine

Use Node.js 24.21 LTS and pnpm 11.28.2. From the repository root, build the workspace packages:

```sh
pnpm install --frozen-lockfile
pnpm --filter @krine/protected-app... build
```

SDK packages are workspace dependencies; registry publication is not required or assumed.

Start the stores with `./scripts/dev-up.sh`, then run the native Axum service in a separate terminal:

```sh
./scripts/with-dev-env.py cargo run -p krine-server
```

The development helper supplies the generated keys and permits `http://localhost:3000`. Open Krine's dashboard using the [dashboard development instructions](../../docs/engineering/dashboard.md), then create and explicitly review/publish the policy below. The application does not create or publish policies.

Start Draftroom:

```sh
cp examples/protected-app/.env.example examples/protected-app/.env
pnpm --filter @krine/protected-app start
```

Open **http://localhost:3000**. On first start, `.data/accounts.json` contains independently generated passwords for `ada`, `ben`, and `cora`. Read that private local file to sign in. The database owns each account's UUID; a browser cannot choose the authoritative user ID. Password changes in `accounts.json` after provisioning do not change database credentials.

These commands assume a native Krine listener at `127.0.0.1:8080` and the generated keys in `deploy/secrets`. If you already use other credentials or a separate development fixture, set `KRINE_PUBLIC_KEY_FILE` and `KRINE_SECRET_KEY_FILE` to those exact keys instead. Set each credential through either its environment variable or its `_FILE` path, never both.

Use the complete Docker path above when Krine runs in Docker. A browser entering Docker and a browser entering this native application may have different observed IPs; proof binding must reject that mismatch. Never hard-code an IP or trust arbitrary forwarding headers to make a proof pass.

## Review the trial policy

In **Checks**, create `can_claim_trial`. Use no current-action inputs and add one rule:

| Rule | Condition | Match | Unknown |
| --- | --- | --- | --- |
| `shared_client` | `client.user_count_30d`, version 1, greater than or equal to 2 | Deny | Deny |

Set **Otherwise → Allow**, review, and publish. A new draft alone does not activate a policy.

1. Sign in as Ada and start a trial. The backend associates Ada with the proof's context and records `trial_requested` before the check. With a fresh context, its user count is one and Krine allows the trial.
2. Reload or restart the application. The same entitlement and authorization result remain; its expiration does not move forward.
3. Sign out and sign in as Ben in the same browser. The shared context now has two authenticated accounts, so the new request is denied. Open **Authorization details**, then locate the decision in Krine's **Activity** to inspect the rule, metric value, and policy version. Events include `trial_requested` and, for an awarded trial, `trial_started`.

The shared context is evidence about browser participation. It is not a guaranteed physical device or person. Cleared/blocked browser storage can produce a new context. Fingerprints never become account identity.

### Missing provider evidence

To observe explicit Unknown handling, edit the draft and prepend a rule: `ip.is_proxy`, version 1, equals `true` → Deny, **Unknown → Deny**. Leave IP intelligence unconfigured. Review and publish this new version, then use Ben's **Start a new request**. Krine returns an evaluated Deny through the Unknown path, with missing-provider evidence visible in Activity. This is not application availability fallback. Restore the earlier policy through the normal review/publication flow when finished.

### Verification

Configure an actual Turnstile site and secret pair in Krine **Settings → Providers**, with the browser application's hostname allowed by that site. Run the provider configuration test, enable it, and review any policies affected by the change. A successful configuration test does not prove site-key/secret pairing; test the real widget too. Krine checks the issued proof’s hostname, fixed action and random per-step binding. [Cloudflare’s dummy keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) provide synthetic testing responses; they do not establish that production binding. A dummy response without the matching hostname, action and `cdata` must be denied. Live widget-to-grant verification requires a real hostname/site/secret pairing and is not established by the automated fixtures below.

Change the `shared_client` rule's match outcome to **Require verification**, keep Unknown → Deny, review, and publish. Ben can start a new request and complete the real widget. The application sends only the verification evidence to its backend; Krine's final Allow grants the trial. A later matching verification rule produces another separately bound step, which the browser renders in sequence. **Finish later**, reloads, provider failures and timeouts preserve the pending attempt. **Resume verification** continues it; no trial is granted merely because a widget completes.

Do not replace provider verification with a client boolean, fabricate a token, or call the initial check API after a known challenge. The automated suite uses test-only HTTP fixtures to exercise failures and sequential steps; production code always uses the real SDK/provider flow.

## Recovery and business guarantees

The backend persists the original intent, operation ID, proof, observed IP, authenticated user and check before contacting Krine. Context resolution uses `resolveContext({ interaction: { proof, check, ip } })`, so pre-check assertions refer to that exact proof. Association and event IDs are stable; acknowledged progress survives retries. Browser input cannot supply identities, policy inputs, a `PendingCheck`, or the business result.

SQLite holds an OS-backed exclusive lock for the process lifetime. One process owns one private data directory on a local filesystem; a second process fails startup. Per-attempt serialization prevents concurrent HTTP handlers from overwriting a newer pending/final state. A transaction commits the unique account entitlement, final result and outgoing `trial_started` event together. Exact retries return the stored result, including after process death.

`KRINE_FALLBACK=ALLOW` is the SDK default for an initial availability failure. `DENY` is supported as an explicit application choice. Fallback is visibly labeled and has no evaluated decision ID. Proof resolution and trusted evidence delivery must succeed before checking; their failures pause the request without fabricating evidence or granting fallback.

If the process died during an initial evaluation, it cannot know whether a challenge response was lost. Recovery retries the immutable operation with **Deny** availability fallback, even when the configured initial default is Allow. After any stored challenge, recovery uses only `continueCheck`; unavailable continuations remain pending. It never remints a proof or replaces the accepted IP. Recovery stops within the original 24-hour retry window, allowing a small deadline margin; a known expired challenge is finalized by Krine as Deny.

Awarded-trial events use a durable outbox with bounded backoff. Retries stop before Krine's 24-hour event deduplication window. An expired delivery remains in the SQLite outbox with `expired=1` for operator reconciliation and emits a generic warning. Do not replay it automatically beyond that window. The durable entitlement remains authoritative even while event export is delayed.

This example retains its three accounts and at most 1,000 attempts per account; it does not silently delete old business deduplication records. To back up, stop the process gracefully and copy the entire private data directory. Retain the database and any WAL files together. Restoring an old backup loses newer grants and deduplication state; reconcile external business effects before accepting requests. Do not share this SQLite database across replicas or use it on a network filesystem.

## Deployment boundary

`DEMO_ORIGIN` is the exact browser origin; the server checks Host, Origin and an authenticated session's CSRF token. Cookies are HttpOnly/SameSite Strict, and Secure unless explicit `DEMO_DEVELOPMENT=true` permits local HTTP. Keep that flag off for deployment. Place a sanitizing HTTPS reverse proxy in front of both the application and Krine; restrict direct listener access. `DEMO_HOST` selects the listen address and defaults to loopback.

`KRINE_URL` is the server's Krine origin. Optional `KRINE_BROWSER_URL` is the browser-visible origin and defaults to the same value. Both require HTTPS outside development. Krine must allow exactly `DEMO_ORIGIN` for browser participation. Only the browser public key is exposed to the page; the server credential stays on the backend.

Forwarding headers are ignored by default. If a real ingress proxy is used, set `DEMO_TRUSTED_PROXIES` to only its actual address/CIDR, and configure Krine's own trusted-proxy list for its ingress path. The proxy must discard client-supplied forwarding headers and supply the real client address. The application validates the chain from the TCP peer toward the first untrusted hop. Both services must derive the same normalized browser source IP; verify that topology from the outside.

## Verify

From the repository root:

```sh
pnpm --filter @krine/protected-app... build
pnpm --filter @krine/protected-app typecheck
pnpm --filter @krine/protected-app test
```

Tests bind disposable loopback ports and use private temporary SQLite files. They cover real HTTP authentication, CSRF/Host checks, trusted IP handling, immutable inputs, concurrent retries, stored pending verification, timeouts, malformed responses, fallback distinctions, durable event delivery, expired retry windows, and actual process crash/restart/exclusive ownership. No running Krine stores are used by this suite.

The ignored Rust suite also runs the built application and both SDKs against actual
Axum, PostgreSQL, Valkey and ClickHouse. With the dedicated test stores configured
as described in the [backend guide](../../docs/engineering/backend.md), run:

```sh
pnpm --filter @krine/protected-app... build
./scripts/with-dev-env.py --isolated-stores cargo test -p krine-server --locked \
  protected_application_verifies_and_recovers_with_real_sdks_and_stores -- --ignored
```

CI includes this test in its full ignored suite after building the workspace. The
test fails if built application artifacts are absent. Only the external widget
and provider response are controlled: the browser SDK's documented adapter checks
the exact site/action/binding, and the real Rust provider adapter validates the
HTTP response. Two sequential steps, rejected bindings, token reuse, provider
failure/timeout, concurrent retries, three process crashes with lost acknowledgements,
durable event delivery and one business grant are checked together. This proves
the local integration contract; it does not establish a live Turnstile pairing.

The image/ingress regression is `python3 scripts/smoke-example.py --provision-test-policy`, run by CI after starting the opt-in stack in a fresh `krine-ci` project. It also accepts a fresh `krine-test-*` project and refuses to replace an existing trial check. Unlike normal startup, this explicit test harness publishes a disposable fixture policy. It verifies forwarding-header spoofing, browser CORS, evaluated Allow/Deny, concurrent duplicates, container recreation, managed-key rotation, durable grant count, network isolation and the actual non-root process capabilities. It writes separate `smoke-example-browser-key` and `smoke-example-server-secret` files in the test secrets directory and revokes only that fixture’s bootstrap keys. To reopen that test fixture, select these files with the example credential overrides above. It leaves test data intact for inspection.
