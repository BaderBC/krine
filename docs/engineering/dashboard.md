# Dashboard

The React dashboard in `apps/dashboard` follows the check-centered [information architecture](../product/information-architecture.md). It talks only to the same-origin `/v1/admin` API. Admin cookies stay HttpOnly; the session-bound CSRF token stays in memory and accompanies mutations. Credentials are never passed in URLs.

## Development

Run `pnpm --filter @krine/dashboard dev`. Vite listens on `127.0.0.1:5174` and proxies `/v1` to `127.0.0.1:8080`, preserving the browser Origin. Configure `KRINE_ADMIN_ORIGIN=http://127.0.0.1:5174` on the development backend. The explicit port fails if occupied. Production hosting must serve the built application and API under the configured admin origin, with a history fallback for dashboard routes.

`pnpm --filter @krine/dashboard build` typechecks and builds static assets; `pnpm --filter @krine/dashboard test` runs the editor, transport and persistence tests. The app uses system fonts and no remote assets.

## Draft and publication safety

A check has one shared revisioned draft. Autosave serializes mutations and preserves the exact body and idempotency key after an ambiguous transport/server failure. Edits made during a save remain local until the earlier result is recovered, then use its acknowledged revision. A definitive conflict requires a comparison with the latest shared draft and an explicit choice of which complete definition to keep. The backend performs the final atomic revision check.

Unsaved policy and description state, including unresolved save, publish and restore intent, have a recovery copy in this tab’s session storage. Recovery validates each check-specific intent and replays its original body and key. A reopened editor owns the recovery record; responses to detached editors cannot erase it. Publication preserves newer local work, and restoration replaces only fields unchanged since its confirmation. Storage failure is visible; navigation warns while work remains unsaved, and page unload also warns about unresolved mutation intent. Expired admin sessions open a sign-in dialog without unmounting the editor. A failed save disables publication.

Publication reviews rule order, conditions, metric versions, unknown routes, trusted input declarations and the final outcome. Its mutation includes both the reviewed draft revision and active version. Lost responses retry the same mutation. Restoration explicitly replaces a draft; it never activates a historical definition directly. Historical policy and metric links fetch the exact version.

Activity filters and pagination live in the URL. Investigation links carry that scope through related records, checks, entities and metrics; returning restores the list position. Refresh is explicit so investigation rows stay still. Failed refreshes mark retained rows as stale and show their last successful refresh time. Decision explanations lead with decisive captured values or unknown causes, with the full policy path in a disclosure. Entity pages show current observations separately. Exact UTC timestamps with milliseconds appear on keyboard focus or hover. Entity relationship lists are paginated and do not imply identity merges.

## Remaining MVP integration

This first dashboard unit covers authoring, publication, read-only investigation and SDK connection reference. Before MVP acceptance, follow-up units must complete provider candidate testing and configuration, credential creation/revocation, reversible relationship correction, observed connection evidence, and production static hosting. These are required product flows, not deferred scope. Provider settings currently report backend state without presenting nonfunctional edit controls.
