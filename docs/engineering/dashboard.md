# Dashboard

The React dashboard in `apps/dashboard` follows the check-centered [information architecture](../product/information-architecture.md). It talks only to the same-origin `/v1/admin` API. Admin cookies stay HttpOnly; the session-bound CSRF token stays in memory and accompanies mutations. Credentials are never passed in URLs.

## Development

Run `pnpm --filter @krine/dashboard dev`. Vite listens on `127.0.0.1:5174` and proxies `/v1` to `127.0.0.1:8080`, preserving the browser Origin. Configure `KRINE_ADMIN_ORIGIN=http://127.0.0.1:5174` on the development backend. The explicit port fails if occupied. Production hosting must serve the built application and API under the configured admin origin, with a history fallback for dashboard routes.

`pnpm --filter @krine/dashboard build` typechecks and builds static assets; `pnpm --filter @krine/dashboard test` runs the editor, transport and persistence tests. The app uses system fonts and no remote assets.

## Draft and publication safety

A check has one shared revisioned draft. Autosave serializes mutations and preserves the exact body and idempotency key after an ambiguous transport/server failure. Edits made during a save remain local until the earlier result is recovered, then use its acknowledged revision. A definitive conflict requires a comparison with the latest shared draft and an explicit choice of which complete definition to keep. The backend performs the final atomic revision check.

Unsaved policy and description state, including unresolved save, publish and restore intent, have a recovery copy in this tab’s session storage. Recovery validates each check-specific intent and replays its original body and key. Authentication failures, throttling, timeouts and malformed acknowledgements retain that intent: they cannot establish whether an earlier submission committed. Successful check/version responses are validated before recovery is cleared. A reopened editor owns the recovery record; responses to detached editors cannot erase it. Publication preserves newer local work, and restoration replaces only fields unchanged since its confirmation. Storage failure is visible; navigation warns while work remains unsaved, and page unload also warns about unresolved mutation intent. Session or CSRF rejection opens a sign-in dialog without unmounting the editor; the original mutation can then be retried with the renewed session. A failed save disables publication.

Publication reviews rule order, conditions, metric versions, unknown routes, trusted input declarations and the final outcome. Its mutation includes both the reviewed draft revision and active version. Lost responses retry the same mutation. Restoration explicitly replaces a draft; it never activates a historical definition directly. Historical policy and metric links fetch the exact version.

Activity filters and pagination live in the URL. Investigation links carry that scope through related records, checks, entities and metrics; returning restores the list position. Refresh is explicit so investigation rows stay still. Failed refreshes mark retained rows as stale and show their last successful refresh time. Decision explanations lead with decisive captured values or unknown causes. Otherwise outcomes explain why rules continued, with a bounded leading summary and the complete policy path in a disclosure. Provider contribution and ordered verification steps use the attempt's captured evidence; a passed verification step never implies final authorization. Entity pages show applicable current observations separately. Exact UTC timestamps with milliseconds appear on keyboard focus or hover. Entity relationship lists are paginated and do not imply identity merges.

## Provider configuration

Settings keeps one expandable row per capability, with SDK reference material collapsed. A candidate must pass its supported test before explicit review and save. Both a usable partial IP lookup and Turnstile's limited format check can return `configuration_checked`; the interface preserves the explanation and does not claim live key pairing. Editing a candidate invalidates its test. Configuration changes show the exact affected published policy versions and their unknown/verification paths. Save carries the backend's dependency token, so a concurrent publication requires another review.

Candidate secrets, activation tokens and an unresolved save's exact request live only in the mounted form's memory, never in browser storage or URLs. An empty secret field retains the stored key; explicit removal is available for proxycheck's optional key. Ambiguous saves freeze the candidate and retry the original body and idempotency key, including across reauthentication and malformed responses. Only a validated acknowledgement clears this intent. A successful replay is followed by a current-state read before the interface calls the configuration current. Stale revisions require explicit reconciliation and a new test. A failed current-state read blocks further edits until refreshed.

Navigation warns before discarding entered values and stays on an unconfirmed save until its result is recovered. Reloading or closing the tab warns but cannot preserve secret-bearing retries: reopen Settings to inspect the current masked configuration before making another change. Verification settings links carry the originating check and return to its draft; the existing policy recovery mechanism remains independent.

## Remaining MVP integration

Before MVP acceptance, follow-up units must complete credential creation/revocation, reversible relationship correction, observed connection evidence, and useful bounded Activity summaries. Provider configuration also requires the coordinated real-backend walkthrough after the matching backend unit is accepted. These remain required product gates.
