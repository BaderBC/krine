# Protected trial application

Draftroom demonstrates a real, durable seven-day trial entitlement protected by Krine. The browser supplies a fresh proof. The application authenticates the account, resolves the proof's context, records trusted evidence, evaluates `can_claim_trial`, and grants the benefit once. Authorization details distinguish evaluated decisions from application fallback.

This is a small integration example with three generated accounts. It is not an account-management product. The production SDKs and Krine API perform every trust interaction; there is no outcome selector or verification bypass.

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

**Do not substitute the containerized `./scripts/up.sh --local` listener into this native path.** A browser entering Docker and a browser entering the native application may have different observed IPs. Proof binding must reject that mismatch. Container ingress integration requires a shared, explicitly trusted proxy boundary; never hard-code an IP or trust arbitrary forwarding headers to make a proof pass.

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
