# HTTP protocol v1

This is the shared contract for the backend, SDKs and dashboard. [ADR 0009](../decisions/0009-protocol-and-reliability-boundaries.md) explains its trust and transaction boundaries. JSON fields use `snake_case`; timestamps are Unix milliseconds. All endpoints use JSON over HTTPS in production. Unknown request fields are rejected except inside customer event `properties` and user `metadata`.

## Access and errors

One self-hosted installation serves one project in MVP. Browser endpoints require `X-Krine-Public-Key`, an exact configured `Origin`, and an allowed source IP; the public key identifies the project and grants no backend authority. Server endpoints require `Authorization: Bearer <server_secret>`. Admin endpoints require a separate admin session cookie. Secrets are never accepted in URLs. Admin login uses an operator-provisioned password, rate limits failures, and sets an HttpOnly, Secure, SameSite=Strict cookie. State-changing admin requests require an exact same-origin `Origin` and a session-bound `X-CSRF-Token` returned by login/session. Local HTTP is an explicit development setting.

Krine uses its TCP peer IP unless that peer belongs to an operator-configured trusted-proxy CIDR. It then processes the configured forwarding header from the trusted end of the chain. Never trust arbitrary client forwarding headers. Browser proof IP is compared with the authoritative application's submitted `ip`; application integration must likewise derive that IP from its trusted proxy configuration. Normalize IPv4-mapped IPv6 before comparison.

Errors have `{ "error": { "code": "invalid_proof", "message": "...", "request_id": "...", "details": [] } }`; optional details are `{ "path": "...", "message": "..." }`. Statuses: 400 malformed JSON, 401 unauthenticated, 403 forbidden/origin/CSRF, 404 absent resource, 409 `input_conflict`/`operation_in_progress`/`revision_conflict`/`proof_used`, 413 oversized body, 422 invalid input/proof/expired proof, 429 rate limited, 503 dependency unavailable. `operation_in_progress` and 429 include `Retry-After`. Bodies never expose secrets or dependency responses. For an initial check with no known outcome, transport failures, request timeout, 429 and 5xx permit configured SDK availability fallback. A parsed authentication, proof, validation or conflict error never permits fallback regardless of HTTP status. Malformed successful responses are protocol errors, never evaluated allows. Continuation has stricter semantics below.

Limits: request body 64 KiB, event properties/metadata 16 KiB each with JSON nesting ≤16, 32 input properties, 1 KiB strings, identifiers 1–128 ASCII letters/digits/`_-.:` (user identifiers may use Unicode and are ≤256 bytes), 32 rules, 256 total condition nodes, depth 8, membership lists 1–32. Numbers are finite and within ±(2^53−1). Duplicate JSON object keys are rejected before canonicalization, including nested customer properties. Numeric values use their parsed IEEE-754 finite value: `1`, `1.0` and `1e0` are equivalent, as are positive and negative zero. The HTTP decoder limits nesting before policy validation. Rates and exact infrastructure timeouts are installation settings; 429 never reports an evaluated denial.

## Browser context and proof

`POST /v1/browser/context` accepts `{ client_token?: string, session_token?: string, signals?: Signals }` and returns `{ client_id, session_id, client_token, session_token, expires_at }`. Krine generates cryptographically random IDs and opaque credentials independent of inspectable entity IDs; browser-selected IDs never create authoritative relationships. `Signals` contains optional `language`, `timezone`, `platform`, `fingerprint` strings, positive integer `screen_width`, `screen_height` (max 32768), `hardware_concurrency` (max 1024), and `webdriver` boolean. Strings are ≤1 KiB. `webdriver` feeds `browser.automation_observed@1`; absent or invalid evidence remains unknown. Signals remain untrusted evidence. Client credentials persist in browser storage; session credentials use session storage. A session belongs to exactly one client. Invalid/expired context credentials create fresh context without transferring identity. Client credentials last 30 days; sessions expire after 24 hours. Browser observation does not count as an authoritative application event.

`POST /v1/browser/proofs` accepts `{ client_token, session_token, check }` and returns `{ proof, expires_at, client_id, session_id }`. The opaque proof has ≥256 bits of entropy and a 60-second initial acceptance lifetime, bound to project, client, session, check and observed source IP. Issuance establishes browser participation, never humanity. Store token digests rather than bearer tokens in durable records/logs. Invalid, expired, or mismatched context credentials return 422 `invalid_context` (or `context_expired` when expiry is distinguishable); this is separate from project authentication failures. `check` must name a published check. Browser SDK preparation returns the proof to the application's request handler; the backend must supply the matching action name itself.

## Backend events and identity

`POST /v1/contexts/resolve` requires the server credential and accepts exactly `{ client_token, session_token }`. It validates that both opaque Krine credentials are current and belong together, then returns `{ client_id, session_id, expires_at }`. It never creates context, issues a proof, or consumes participation evidence. Invalid or expired credentials return 422 `invalid_context` (or `context_expired` when distinguishable). Applications resolve browser credentials before attaching their IDs to authoritative login events or associations; browser-selected IDs are not trusted context.

`POST /v1/events` accepts `{ event_id, name, occurred_at?, user_id?, client_id?, session_id?, ip?, properties?: object }`. At least one entity identifier is required. Session requires its matching client; supplied Krine IDs must exist. `occurred_at` is descriptive; windowed MVP metrics use first server acceptance time, so late submissions do not rewrite prior decisions. Future occurrence timestamps more than five minutes ahead are rejected. Response: `{ event_id, accepted_at, duplicate: boolean }`. The event ID uniquely identifies immutable content for 24 hours; exact retries have one effect, changed content returns 409. Retry after 24 hours is unsupported; integrations must not redeliver older operations. A success means supported metrics for checks started afterward include the event. Failure can have an unknown outcome: retry the same ID and body.

`POST /v1/associations` accepts `{ association_id, client_id, user_id, metadata?: object }`; returns `{ association_id, client_id, user_id, created_at, revoked_at: null, provenance: "backend", metadata }`. Its key/content and retry semantics match events. This records a reversible edge and never merges entities. Association timestamps and provenance are durable. Server IDs and metadata are authoritative customer facts; browser fingerprints are not. A check's optional `user_id` asserts its current subject but does not silently create a persistent relationship.

## Authoritative checks

`POST /v1/checks/evaluate` accepts:

```json
{
  "operation_id": "checkout_attempt_123",
  "check": "can_register",
  "proof": "opaque-token",
  "ip": "203.0.113.10",
  "user_id": "user_123",
  "inputs": { "amount": 42 },
  "verification": { "challenge_id": "ch_123", "token": "provider-response" }
}
```

`user_id`, `inputs` (default `{}`) and `verification` are optional. The application generates an operation ID once per protected business intent and stores it across transport retries, local fallback and challenge completion. Canonical immutable content comprises `check`, the original proof digest, normalized `ip`, `user_id` and recursively key-sorted typed `inputs`. Absent and empty inputs are equivalent; absent `user_id` differs from any string. JSON object order is immaterial. All other value differences conflict, even after finalization. `verification` is the only permitted continuation field. Reusing a proof under another operation conflicts. Recovery validates the entire immutable content before returning a recorded result, even after proof expiry.

All evaluated responses are HTTP 200:

```json
{
  "operation_id": "checkout_attempt_123",
  "decision_id": "dec_123",
  "source": "evaluation",
  "outcome": "CHALLENGE_REQUIRED",
  "check": "can_register",
  "policy_version": 3,
  "accepted_at": 1800000000000,
  "retry_until": 1800086400000,
  "reason": "verification_required",
  "challenge": {
    "challenge_id": "ch_123",
    "provider": "turnstile",
    "site_key": "public-provider-key",
    "action": "krine_verify",
    "binding": "opaque-attempt-binding",
    "expires_at": 1800000300000
  }
}
```

Outcomes are `ALLOW`, `DENY`, `CHALLENGE_REQUIRED`. `challenge` appears only on the intermediate outcome. Pending challenges expire five minutes after initial attempt acceptance; expiration returns a stable evaluated DENY. Ordinary retries return the current recorded state without consuming another proof or invoking a provider. Every challenge ID binds project, operation, rule, provider configuration revision and expiry; provider evidence must verify expected site, hostname, fixed action `krine_verify` and unpredictable per-step binding (`cdata`). Provider secrets/configuration are pinned for the attempt. Before verification persist the token digest and provider idempotency UUID; commit the verified result and rule advancement in one durable transition. Successful verification advances to the following rule, which may require a distinct challenge. Failed, expired or unavailable verification gives a stable DENY with the cause recorded. Unexpected challenge IDs and oversized/malformed tokens are request errors that do not finalize the operation. Turnstile tokens are ≤2048 characters; binding uses ≤255 letters, digits, underscores or hyphens. Final responses remain identical for 24 hours after acceptance; later recovery returns 422 `operation_expired` while its tombstone is retained. Applications must not retry beyond `retry_until` and must independently prevent repeated execution of the protected action.

The server SDK returns a separate local union `{ source: "fallback", outcome: "ALLOW"|"DENY", reason: "timeout"|"unavailable"|"rate_limited", operation_id, check }`. Default is ALLOW with global/per-check overrides. It never invents a policy version or decision ID. An attempt whose outcome is unknown retains its operation ID for recovery. A challenge response includes serializable trusted `PendingCheck` state for the application's durable operation record. `continueCheck(pending, verification?)` performs recovery or verification and returns an evaluated response or throws a typed error; it never uses availability fallback. Thus a known challenge cannot become an allow through a continuation timeout. The application retains known final/pending results across requests and processes, returns known finals from its operation state, and uses continuation for known pending attempts. Browser-supplied pending/final state is never trusted. Successful widget completion retries the same application request and original proof with `verification`.

## Policy and metric schema

`Policy` is `{ schema_version: 1, inputs: { [name]: "number"|"boolean"|"string" }, rules: Rule[], otherwise: "ALLOW"|"DENY" }`. Defaults: empty inputs/rules, otherwise DENY. A rule is `{ id, condition, then: "ALLOW"|"DENY"|"CHALLENGE", on_unknown: "DENY"|"NEXT"|"CHALLENGE" }`; `on_unknown` defaults DENY. Rule IDs are unique and stable while editing.

References are `{ source: "metric", name, version: 1 }` or `{ source: "input", name }`. Conditions are discriminated by `op`:

| `op` | Fields | Meaning |
| --- | --- | --- |
| `compare` | `left`, `comparison: eq|ne|gt|gte|lt|lte`, `value` | Same-type scalar comparison; ordering requires numbers |
| `in` | `left`, `values: Scalar[]` | Same-type membership |
| `between` | `left`, `min`, `max` | Inclusive numeric range |
| `known` | `value: Reference` | True iff data is known |
| `all` / `any` | `conditions: Condition[]` | Nonempty AND / OR |
| `not` | `condition: Condition` | Boolean negation |

`Scalar` is a bounded JSON string, finite number or boolean, never null. Referenced metrics must exist at the exact pinned version; referenced inputs must be declared. Missing inputs are unknown; supplied undeclared or wrong-type inputs are rejected. Conditions evaluate true/false/unknown. AND is false if any child is false, otherwise unknown if any is unknown. OR is true if any child is true, otherwise unknown if any is unknown. NOT preserves unknown. Known checks explicitly turn missing data into false. An unresolved rule follows its `on_unknown` route. Rules run in order; final rules stop evaluation. Otherwise applies only after every rule continues.

The Rust `krine-core` serde types are the canonical policy/catalog/trace schema. `MetricDefinition` exposes name, version, kind, value_type, range, description, dependencies, source, missing and examples. Metric snapshots map stable metric names to `{ version, state: { status: "known", value }|{ status: "unknown", reason }, provenance: { source, observed_at } }`. Unknown reasons include missing, unavailable, timeout, stale, invalid and type_mismatch. Explanations persist the actual snapshot, typed trusted inputs, policy, provider revisions and relevant relationship IDs; current entity state never substitutes for past evidence.

## Dashboard API

Admin prefix is `/v1/admin`. Login `POST /session { password }` and current `GET /session` return `{ csrf_token, expires_at }`; `DELETE /session` logs out. Other endpoints require the session and mutation CSRF protections above. The deployment provisions the admin password; Settings manages browser and server credentials with create/revoke controls. Server credentials never authorize admin operations.

Lists return `{ items: T[], next_cursor: string|null }`; `limit` defaults 50, max 100. Opaque cursors use stable descending `(created_at,id)` order. Search filters are bounded ≤128 bytes. Every mutation except login requires `Idempotency-Key`, immutable payload validation and 24-hour replay; versioned edits additionally compare `revision` atomically. Sensitive provider writes replay only the redacted response.

| Method and path | Input / response |
| --- | --- |
| `GET /checks` | Optional `q`; items `{ name, description, active_version: number|null, draft_revision, has_draft_changes: boolean, updated_at, recent: { allow, deny, challenge, errors, p95_ms: number|null } }`; recent is last 24h and may be unavailable as `null` |
| `POST /checks` | `{ name, description? }` → check detail; empty deny draft |
| `GET /checks/{name}` | `{ name, description, active_version, draft_revision, has_draft_changes: boolean, draft: Policy, updated_at }` |
| `PUT /checks/{name}/draft` | `{ revision, description, policy: Policy }` → check detail; accepts valid draft only |
| `POST /checks/{name}/publications` | `{ revision, expected_active_version: number|null }` → `{ version, published_at, policy: Policy, restored_from_version: number|null }`; compare both reviewed draft revision and active version atomically; validate required capability configuration and metric versions; current provider outage does not block publication when explicit unknown/failure routes exist |
| `GET /checks/{name}/versions` | Items `{ version, published_at, policy: Policy }` |
| `GET /checks/{name}/versions/{version}` | Immutable `{ version, published_at, policy: Policy, restored_from_version: number|null }` |
| `POST /checks/{name}/restorations` | `{ version, revision, replace_draft: true }` → check detail with incremented draft revision and `restored_from_version`; explicitly replaces draft with a previous definition for review, never publishes; ordinary publication creates a new immutable version retaining this provenance |
| `GET /metrics` | Optional `q`; items `MetricDefinition` |
| `GET /metrics/{name}/versions/{version}` | `MetricDefinition` |
| `GET /providers` | `{ items: ProviderSummary[] }` |
| `PUT /providers/{capability}` | `{ revision, provider, enabled, config, test_token?, acknowledge_dependents?: boolean }` → `ProviderSummary`; enabled candidate requires a matching fresh successful test token; replacement/disconnection requires explicit dependent-check acknowledgement |
| `POST /providers/{capability}/tests` | `{ revision, provider, enabled, config }` → `{ status: "ready"|"unavailable"|"invalid", checked_at, message, test_token: string|null, dependent_checks: string[] }`; tests candidate without saving it; server binds token to exact candidate digest, current revision and ten-minute expiry |
| `GET /activity/decisions` | Filters `check`, `operation_id` (exact), `outcome`, `entity`, `from`, `to`; items `DecisionSummary` |
| `GET /activity/decisions/{id}` | `DecisionDetail` |
| `GET /activity/events` | Filters `name`, `entity`, `from`, `to`; items accepted event envelope + `accepted_at`, `provenance: "backend"|"browser"` |
| `GET /activity/events/{id}` | Accepted event envelope + `accepted_at`, `provenance`, linked entity identifiers and available metric effects |
| `GET /entities/{kind}/{id}` | `{ kind, id, first_seen, metadata, metrics: Snapshot.metrics, associations: Association[], recent_decisions: DecisionSummary[], recent_events: Event[] }`; kinds client/session/user/ip; recent lists capped at 20; associations capped at 100 with `associations_next_cursor`, accepted as `associations_cursor` on this endpoint |
| `POST /associations/{id}/revocations` | `{ reason }` → association with `revoked_at`, `revocation_reason`, `revoked_by`; repeat safe |
| `POST /associations/{id}/restorations` | `{ reason }` → association with restored active state and audit entry; never erases revocation history |
| `GET /setup` | `{ public_key, browser_url, server_url, allowed_origins, sdk: { browser_package, server_package } }`; secrets omitted |
| `GET /credentials` | `{ items: CredentialSummary[] }` |
| `POST /credentials` | `{ kind: "browser"|"server", name, allowed_origins?: string[] }` → `{ credential: CredentialSummary, secret }`; reveal secret once; subsequent retries return metadata with `secret: null` and `secret_unavailable: true` |
| `POST /credentials/{id}/revocations` | `{}` → revoked `CredentialSummary`; stop accepting revoked credential immediately |

`has_draft_changes` compares the saved draft policy with the active immutable policy by JSON value, independently of draft revision numbers or description edits. It is `true` while unpublished; `active_version: null` identifies that state. Saving the active policy again or undoing an edit returns it to `false`; publication also makes it `false`.

`ProviderSummary` is `{ capability, provider, enabled, revision, config, has_secret, status, checked_at, dependent_checks: string[] }`; capabilities are `ip_intelligence` and `verification`. `config` contains public configuration only; secret writes use explicit `secret` within write config, omission retains the previous secret and `null` clears it. Old revisions needed by pending attempts are retained. Candidate tests never change active configuration, and failed tests cannot be saved as enabled. Initial providers: `proxycheck` for IP intelligence and `turnstile` for verification; their adapters normalize evidence. Policies never mention either name. `CredentialSummary` is `{ id, kind, name, prefix, allowed_origins, created_at, revoked_at: number|null }`. Secret-once creation is an intentional exception to response replay; on a lost first response create a replacement and revoke the inaccessible credential.

Activity `entity` search matches the identifier across client, session, user and IP fields. Entity-detail recent history matches only the requested entity kind; equal identifier strings never merge those histories. Decision lists select summary fields from analytical storage; policy definitions, metric snapshots and evaluation traces are retrieved only for an individual decision.

`DecisionSummary` is `{ decision_id, operation_id, check, policy_version, outcome, reason, accepted_at, completed_at: number|null, client_id, session_id, user_id: string|null, ip, source: "evaluation" }`. Request errors and optional reported SDK fallback use separate `source: "request_error"|"fallback"` activity entries with a reason and no fabricated policy result. `DecisionDetail` adds `{ policy, snapshot, evaluation, relationship_ids, provider_revisions, requests }`. `evaluation` is the core trace including every evaluated condition, explicit unknown cause and verification result. `requests` is bounded attempt metadata `{ at, kind: "initial"|"retry"|"verification", result }`, never proof/challenge bearer tokens. Browser credentials, proof tokens, provider secrets and verification tokens never appear in dashboard history.

## Retention and recovery

Defaults: 30 days analytical events/decisions; 30 days observed IP edges; active backend user relationships persist until corrected. Reliability envelopes and final responses survive at least the 24-hour supported retry window. Proof/challenge tombstones last at least 24 hours beyond last valid use. Unexported outbox records are never age-deleted; capacity exhaustion rejects new writes before acknowledging them. Operator retention changes cannot erase active retry or challenge state. See ADR 0009 for event projection and restart behavior.
