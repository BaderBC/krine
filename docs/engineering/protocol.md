# HTTP protocol v1

This is the shared contract for the backend, SDKs and dashboard. [ADR 0009](../decisions/0009-protocol-and-reliability-boundaries.md) explains its trust and transaction boundaries. JSON fields use `snake_case`; timestamps are Unix milliseconds. All endpoints use JSON over HTTPS in production. Unknown request fields are rejected except inside customer event `properties` and user `metadata`.

## Access and errors

One self-hosted installation serves one project in MVP. Browser endpoints require `X-Krine-Public-Key`, an exact configured `Origin`, and an allowed source IP; the public key identifies the project and grants no backend authority. Server endpoints require `Authorization: Bearer <server_secret>`. Admin endpoints require a separate admin session cookie. Secrets are never accepted in URLs. Admin login uses an operator-provisioned password, rate limits failures, and sets an HttpOnly, Secure, SameSite=Strict cookie. State-changing admin requests require an exact same-origin `Origin` and a session-bound `X-CSRF-Token` returned by login/session. Local HTTP is an explicit development setting.

Krine uses its TCP peer IP unless that peer belongs to an operator-configured trusted-proxy CIDR. It then processes the configured forwarding header from the trusted end of the chain. Never trust arbitrary client forwarding headers. Browser proof IP is compared with the authoritative application's submitted `ip`; application integration must likewise derive that IP from its trusted proxy configuration. Normalize IPv4-mapped IPv6 before comparison.

Errors have `{ "error": { "code": "invalid_proof", "message": "...", "request_id": "...", "details": [] } }`; optional details are `{ "path": "...", "message": "..." }`. Statuses: 400 malformed JSON, 401 unauthenticated, 403 forbidden/origin/CSRF, 404 absent resource, 409 `input_conflict`/`operation_in_progress`/`revision_conflict`/`proof_used`, 413 oversized body, 422 invalid input/proof/expired proof, 429 rate limited, 503 dependency unavailable. `operation_in_progress` and 429 include `Retry-After`. Bodies never expose secrets or dependency responses. For an initial check with no known outcome, transport failures, request timeout, 429 and 5xx permit configured SDK availability fallback. A parsed authentication, proof, validation or conflict error never permits fallback regardless of HTTP status. Malformed successful responses are protocol errors, never evaluated allows. Continuation has stricter semantics below.

Limits: request body 64 KiB, event properties/metadata 16 KiB each with JSON nesting ≤16, 32 input properties, 1 KiB strings, identifiers 1–128 ASCII letters/digits/`_-.:` (user identifiers may use Unicode and are ≤256 bytes), 32 rules, 256 total condition nodes, depth 8, membership lists 1–32. Numbers are finite and within ±(2^53−1). Duplicate JSON object keys are rejected before canonicalization, including nested customer properties. Numeric values use their parsed IEEE-754 finite value: `1`, `1.0` and `1e0` are equivalent, as are positive and negative zero. The HTTP decoder limits nesting before policy validation. Rates and exact infrastructure timeouts are installation settings; 429 never reports an evaluated denial.

## Browser context and proof

`POST /v1/browser/context` accepts `{ client_token?: string, session_token?: string, signals?: Signals }` and returns `{ client_id, session_id, client_token, session_token, expires_at }`. Krine generates cryptographically random IDs and opaque credentials independent of inspectable entity IDs; browser-selected IDs never create authoritative relationships. `Signals` contains optional `language`, `timezone`, `platform`, `fingerprint` strings, positive integer `screen_width`, `screen_height` (max 32768), `hardware_concurrency` (max 1024), and `webdriver` boolean. Strings are ≤1 KiB. `webdriver` feeds `browser.automation_observed@1`; absent or invalid evidence remains unknown. Signals remain untrusted evidence. Client credentials persist in browser storage; session credentials use session storage. A session belongs to exactly one client. Invalid/expired context credentials create fresh context without transferring identity. Client credentials last 30 days; sessions expire after 24 hours. Browser observation does not count as an authoritative application event.

`POST /v1/browser/proofs` accepts `{ client_token, session_token, check }` and returns `{ proof, expires_at, client_id, session_id }`. The opaque proof has ≥256 bits of entropy and a 60-second initial acceptance lifetime, bound to project, client, session, check, observed source IP and the validated browser Origin hostname. Issuance establishes browser participation, never humanity. Store token digests rather than bearer tokens in durable records/logs. Invalid, expired, or mismatched context credentials return 422 `invalid_context` (or `context_expired` when expiry is distinguishable); this is separate from project authentication failures. `check` must name a published check. Browser SDK preparation returns the proof to the application's request handler; the backend must supply the matching action name itself.

## Backend events and identity

`POST /v1/contexts/resolve` requires the server credential and accepts one of two mutually exclusive request shapes:

- `{ client_token, session_token }` validates current, matching participation credentials for continuous login events and associations. Invalid or expired credentials return 422 `invalid_context` (or `context_expired` when distinguishable).
- `{ interaction: { proof, check, ip } }` resolves the context of a protected interaction. Krine verifies the issued proof is fresh and bound to the backend-selected action and normalized authoritative IP, then returns the client/session recorded in that proof. A missing, expired or mismatched proof returns 422 `invalid_proof`. Browser-selected IDs and mixed credential/interaction envelopes are rejected.

Both return `{ client_id, session_id, expires_at }`. Credential mode returns session expiry; interaction mode returns proof expiry. A still-valid issued proof remains resolvable after its participation credentials expire, matching initial check acceptance semantics. Resolution never creates context, consumes or reserves a proof, or authorizes the action. The subsequent check remains mandatory and may reject a proof that expired or was used after resolution. Pre-check events and associations must use interaction resolution so their context is the same one the check evaluates. No second browser credential handoff is needed for that action.

`POST /v1/events` accepts `{ event_id, name, occurred_at?, user_id?, client_id?, session_id?, ip?, properties?: object }`. At least one entity identifier is required. Session requires its matching client; supplied Krine IDs must exist. `occurred_at` is descriptive; windowed MVP metrics use first server acceptance time, so late submissions do not rewrite prior decisions. Future occurrence timestamps more than five minutes ahead are rejected. Response: `{ event_id, accepted_at, duplicate: boolean }`. The event ID uniquely identifies immutable content for 24 hours; exact retries have one effect, changed content returns 409. Retry after 24 hours is unsupported; integrations must not redeliver older operations. A success means supported metrics for checks started afterward include the event. Failure can have an unknown outcome: retry the same ID and body.

`POST /v1/associations` accepts `{ association_id, client_id, user_id, session_id?: string|null, metadata?: object }`; returns `{ association_id, client_id, user_id, session_id, credential_id, created_at, revoked_at: number|null, revision, revocation_reason, revoked_by, provenance: "backend", metadata }`. Its key/content and retry semantics match events. This records a reversible edge and never merges entities. Association timestamps and provenance are durable. Server IDs and metadata are authoritative customer facts; browser fingerprints are not. A check's optional `user_id` asserts its current subject but does not silently create a persistent relationship.

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

Outcomes are `ALLOW`, `DENY`, `CHALLENGE_REQUIRED`. `challenge` appears only on the intermediate outcome. Pending challenges expire five minutes after initial attempt acceptance; expiration returns a stable evaluated DENY. Ordinary retries return the current recorded state without consuming another proof or invoking a provider. Every challenge ID binds project, operation, rule, provider configuration revision and expiry; provider evidence must verify expected site, hostname, fixed action `krine_verify` and unpredictable per-step binding (`cdata`). Provider secrets/configuration are pinned for the attempt. Before verification persist the token digest and provider idempotency UUID; commit the verified result and rule advancement in one durable transition. In-flight identical submissions return 409 `operation_in_progress`; different evidence for that step conflicts. Evidence already bound to another step returns 409 `verification_used`. A five-second lease fences crashed workers: after expiry the same evidence can retry with its original provider UUID. An ordinary retry without that original token then finalizes as unavailable rather than guessing the provider outcome. Completed-step exact retries return the current attempt state without another provider call. Successful verification advances to the following rule, which may require a distinct challenge. Failed, expired or unavailable verification gives a stable DENY with the cause recorded. Unexpected challenge IDs and oversized/malformed tokens are request errors that do not finalize the operation. Turnstile tokens are nonempty ASCII without whitespace/control characters and ≤2048 bytes; binding uses ≤255 letters, digits, underscores or hyphens. Final responses remain identical for 24 hours after acceptance; later recovery returns 422 `operation_expired` while its tombstone is retained. Applications must not retry beyond `retry_until` and must independently prevent repeated execution of the protected action.

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

Lists return `{ items: T[], next_cursor: string|null }`; `limit` defaults 50, max 100. Opaque cursors use stable descending `(created_at,id)` order. Check-list `q` search accepts at most 128 bytes; Activity scalar filters accept at most 256 bytes. Every mutation except login requires `Idempotency-Key`, immutable payload validation and 24-hour replay; versioned edits additionally compare `revision` atomically. Sensitive provider writes replay only the redacted response.

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
| `PUT /providers/{capability}` | `{ revision, provider, enabled, config, test_token?, acknowledge_dependents?: boolean, reviewed_dependents_token?: string }` → `ProviderSummary`; enabled candidate requires a matching fresh `ready` or `configuration_checked` test token; replacement/disconnection requires explicit dependent-check acknowledgement |
| `POST /providers/{capability}/tests` | `{ revision, provider, enabled, config }` → `{ status: "ready"|"configuration_checked"|"unavailable"|"invalid", checked_at, message, test_token: string|null, dependent_checks: string[], dependent_versions: { check, version }[], dependents_token: string }`; tests candidate without saving it; server binds token to exact candidate digest, current revision and ten-minute expiry |
| `GET /activity/decisions` | Filters `check`, `operation_id` (exact), `outcome`, `reason` (exact), `entity`, `entity_kind`, `from`, `to`; items `DecisionSummary` |
| `GET /activity/decisions/{id}` | `DecisionDetail` |
| `GET /analytics/activity` | Bounded, exact latest-record counts, time series and decision breakdowns; see [Activity analytics](#activity-analytics). |
| `GET /activity/events` | Filters `name`, `provenance` (`backend` or `browser`), `entity`, `entity_kind`, `from`, `to`; items accepted event envelope + `accepted_at`, `provenance: "backend"|"browser"` |
| `GET /activity/events/{id}` | Accepted event envelope + `accepted_at`, `provenance`, linked entity identifiers and available metric effects |
| `GET /entities/{kind}/{id}` | `{ kind, id, first_seen, metadata, metrics: Snapshot.metrics, associations: Association[], recent_decisions: DecisionSummary[], recent_events: Event[] }`; kinds client/session/user/ip; recent lists capped at 20; associations capped at 100 with `associations_next_cursor`, accepted as `associations_cursor` on this endpoint |
| Relationship inspection and correction | See [relationship routes](#relationship-provenance-and-correction) below; revisions, reason and mutation identity are required for changes. |
| `GET /setup` | Optional `check`; `{ observations, history_retention, public_key: string|null, browser_credential_id: string|null, active_credentials: { browser: number, server: number }, browser_url, server_url, allowed_origins, sdk: { browser_package, server_package } }`; selects oldest active browser key; secrets omitted |
| `GET /credentials` | Bounded cursor pagination and optional `q` label search; `{ items: CredentialSummary[], next_cursor: string|null }`; includes revoked credentials |
| `POST /credentials` | `{ kind: "browser"|"server", label }` → `{ credential: CredentialSummary, secret: string|null, secret_status: "revealed"|"unrecoverable"|"not_applicable" }`; server secret appears only in original committed response; retries return current metadata and `unrecoverable` |
| `POST /credentials/{id}/revocations` | `{}` → revoked `CredentialSummary`; stop accepting revoked credential immediately |

`has_draft_changes` compares the saved draft policy with the active immutable policy by JSON value, independently of draft revision numbers or description edits. It is `true` while unpublished; `active_version: null` identifies that state. Saving the active policy again or undoing an edit returns it to `false`; publication also makes it `false`.

`ProviderSummary` is `{ capability, provider, enabled, revision, config, has_secret, status, message, checked_at, dependent_checks: string[], dependent_versions: { check: string, version: number }[], dependents_token: string }`; capabilities are `ip_intelligence` and `verification`. `config` contains public configuration only; secret writes use explicit `secret` within write config, omission retains the previous secret and `null` clears it. `status` is `unconfigured`, `disabled`, `ready` or `configuration_checked`; it describes the saved configuration test, not a live availability guarantee. Turnstile format checking returns `configuration_checked` with a message that live site-key/secret pairing is untested; real application verification remains strict. Proxycheck tests perform a one-second lookup of `1.1.1.1`: complete evidence reports `ready`; warnings or incomplete evidence with at least one usable normalized field report `configuration_checked`, with missing/invalid fields still unknown and an explicit reminder that other IPs may differ. No usable evidence, malformed responses and credential rejection cannot activate a candidate. Old revisions needed by pending attempts are retained. Candidate tests never change active configuration, and failed tests cannot be saved as enabled. Write config for proxycheck is `{ secret?: string|null }`; its key is optional for the public service tier. Turnstile uses `{ site_key?: string, secret?: string|null }`, with a valid site key and nonempty secret required when enabled. Omitted public fields retain the existing value. Disabled candidates need no test token. Replacing or disconnecting an existing provider revision with published dependents requires `acknowledge_dependents: true` and `reviewed_dependents_token` matching the exact sorted dependent check/version set returned by GET or test. Read the immutable policies listed in `dependent_versions` for review. Acknowledged replacement/disconnection rejects missing or stale tokens with `409 dependent_checks_changed`, including republished, added or removed dependents; refresh and review before sending a new mutation key. Candidate activation tokens remain valid for their original ten minutes after a stale review. Publication locks the union of previous and next dependencies, so changes cannot race this check. No lock spans operator review. Initial providers: `proxycheck` for IP intelligence and `turnstile` for verification; their adapters normalize evidence. Policies never mention either name. `CredentialSummary` is `{ id, kind: "browser"|"server", label, source: "bootstrap"|"administrator", public_key: string|null, created_at, revoked_at: number|null, revoked_by: "administrator"|null }`. Labels contain 1–128 bytes without control characters or surrounding whitespace. All browser credentials use the deployment’s exact origin allowlist. Server values contain 256 random bits and are stored only as SHA-256 digests. Secret-once creation is an intentional exception to response replay; on a lost first response revoke the inaccessible credential and create a replacement. Browser creations use `secret_status: "not_applicable"`; their public value remains in metadata. Create replays return current revocation state. Authentication checks PostgreSQL on every request; after revocation commits later authentication fails, while an already-authenticated request may finish. Existing participation/proof tokens are not revoked by key rotation. Setup returns no key if none is active. See [ADR 0012](../decisions/0012-durable-application-credentials.md) for permanent bootstrap import and upgrade requirements.

Activity scalar filters accept at most 256 bytes. `entity` search matches the exact identifier across client, session, user and IP fields. Optional `entity_kind` (`client`, `session`, `user`, `ip`) requires `entity` and restricts matching to that field. Links from a known entity must include its kind. Entity-detail recent history is likewise typed. Newly issued Activity cursors bind all filters, including entity kind; changing filters requires a fresh page. Legacy cursors remain accepted only for untyped requests. The additive `reason` and `provenance` filters bind cursors as well; cursors issued without these filters remain compatible. Both lists add `retention: { days, requested_days, applying, available_since }`, with the effective retention boundary in milliseconds; this does not promise uninterrupted historical coverage. Analytical visibility is asynchronous.

Setup adds `observations: { tracked_since, check: string|null, client_evidence: Receipt|null, backend_event: Receipt|null, check_attempt: Receipt|null }`. A `Receipt` is `{ received_at, basis: "tracked"|"retained_history", record: { kind: "event"|"decision", id, availability: "available"|"pending"|"not_retained"|"unavailable" } }`. Client evidence and backend events are installation-wide; the attempt belongs only to the requested check. Without `check`, the attempt is null. Unknown checks return 404. A receipt proves durable acceptance by Krine, never application-side enforcement. Invalid pre-admission requests do not create attempts.

`tracked_since` records when receipt tracking began. `tracked` is the first committed receipt since then; `retained_history` is the earliest surviving PostgreSQL reliability record found at upgrade, not an all-time first. Null means no receipt is known within this coverage. Markers survive analytical expiry without retaining payloads or credentials. `available` means detail exists in PostgreSQL or ClickHouse within retention, `pending` means an admitted attempt has no recorded evaluation yet, `not_retained` means it is expired or confirmed absent, and `unavailable` means analytical storage could not confirm availability. Setup also returns `history_retention: { days, requested_days, applying, available_since, visibility: "asynchronous" }`. A received record may precede its appearance in Activity lists.

Decision lists select summary fields from analytical storage; policy definitions, metric snapshots and full evaluation traces are retrieved only for an individual decision.

`DecisionSummary` is `{ decision_id, operation_id, check, policy_version, outcome, reason, accepted_at, completed_at: number|null, client_id, session_id, user_id: string|null, ip, source: "evaluation", reason_summary: ReasonSummary|null }`. This release records admitted evaluated attempts. Invalid requests remain HTTP errors, and local SDK fallback is not ingested into Activity. Neither is fabricated as an evaluated decision. Synthetic demo records may additionally carry `sample_data: { dataset_id: string, generator_version: string }`, preserved in summaries and detail; live and legacy records omit it. `DecisionDetail` adds `{ policy, snapshot, evaluation, relationship_ids, relationship_context, provider_revisions, provider_observations?, verification_transitions, requests }`. `provider_revisions` maps used capabilities to `{ revision, enabled }`; `provider_observations` records the actual normalized lookup status, safe cause and observation time. `verification_transitions` is an immutable chronological sequence `{ sequence, at, challenge_id: string|null, state, detail }`; states include `pending`, `verifying`, `passed`, `failed`, `expired` and `unavailable`. The latest Activity row represents one logical attempt throughout all steps; earlier analytical deliveries cannot overwrite newer state. `evaluation` is the core trace including every evaluated condition, explicit unknown cause and verification result. `requests` is bounded attempt metadata `{ at, kind: "initial"|"retry"|"verification", result }`, never proof/challenge bearer tokens. Browser credentials, proof tokens, provider secrets and verification tokens never appear in dashboard history.

`ReasonSummary` is captured with each immutable decision revision, never recomputed from current metrics, policy or providers:

```ts
type ReasonSummary = {
  schema_version: 1;
  reason: string;
  outcome: "ALLOW" | "DENY" | "CHALLENGE_REQUIRED";
  scope: "decisive_rule" | "otherwise";
  rule_id: string | null;
  rules: Array<{
    rule_id: string; position: number; route: string;
    result: "true" | "false" | "unknown"; compound: boolean;
    evidence: Array<{
      path: number[];
      reference: { source: "metric"; name: string; version: number }
        | { source: "input"; name: string };
      observed: { status: "known"; value: string | number | boolean }
        | { status: "unknown"; reason: string };
      observed_truncated: boolean;
      test: { op: "compare"; comparison: string; value: string | number | boolean }
        | { op: "in"; values: Array<string | number | boolean> }
        | { op: "between"; min: number; max: number }
        | { op: "known" };
      test_truncated: boolean;
      result: "true" | "false" | "unknown";
      provenance: { source: string; observed_at: number } | null;
    }>;
    evidence_truncated: boolean;
  }>;
  rules_truncated: boolean;
  provider_revisions: Record<string, { revision: number; enabled: boolean }>;
  truncated: boolean;
};
```

The sample includes the decisive rule, or up to three evaluated continuation rules explaining Otherwise. It includes at most four leaves in total, with zero-based paths into the captured condition tree. `position` is one-based. A compound rule's result cannot be inferred from one sampled leaf; inspect detail for complete logic. Unknown carries its original cause and metric version. Strings preview at most 64 UTF-8 bytes; `in` tests preview at most three values. The serialized summary is at most 8 KiB, with explicit truncation flags for omitted evidence and shortened values. Legacy records without a summary return null; they are never reconstructed using current evidence.

### Activity analytics

`GET /v1/admin/analytics/activity` uses the existing admin session. It requires `kind: decision|event`, `from` and `to`: nonnegative, safe integer Unix milliseconds with inclusive bounds and at most 31 days of covered milliseconds. Optional `bucket: 5m|1h|1d` selects a UTC-aligned interval; omission chooses the smallest interval fitting at most 400 buckets. Invalid ranges, repeated/unknown parameters and an interval requiring more buckets return 422.

Decision filters are `check`, `operation_id`, `outcome`, `reason`, `entity`, `entity_kind`. Event filters are `name`, `provenance`, `entity`, `entity_kind`. Scalar limits, exact byte-preserving identifiers and typed entity semantics match Activity lists. Filters belonging only to the other view are rejected. Reasons are captured result reasons, not a claim of fraud; `otherwise` can accompany Allow or Deny.

```ts
type DecisionCounts = {
  total: number; allow: number; deny: number;
  awaiting_verification: number; unknown: number;
};
type EventCounts = {
  total: number; backend: number; browser: number; unknown: number;
};
type Breakdown = {
  items: Array<{ value: string | null; count: number }>;
  other_count: number;
};
type ActivityAnalytics<T extends DecisionCounts | EventCounts> = {
  schema_version: 1;
  scope: {
    kind: "decision" | "event";
    check: string | null; operation_id: string | null; outcome: string | null;
    entity: string | null; entity_kind: "client" | "session" | "user" | "ip" | null;
    name: string | null; reason: string | null; provenance: "backend" | "browser" | null;
  };
  range: {
    from: number; to: number; time_basis: "accepted_at";
    effective_from: number | null; effective_to: number | null; bucket_ms: number;
  };
  as_of: number;
  retention: { days: number; requested_days: number; applying: boolean; available_since: number };
  visibility: "asynchronous";
  delivery: {
    scope: "installation"; observed_at: number; pending_records: number;
    oldest_record_accepted_at: number | null;
  };
  totals: T | null;
  buckets: Array<{ from: number; to: number; counts: T }>;
  breakdowns: { checks?: Breakdown; reasons?: Breakdown };
};
```

The effective range intersects requested bounds with the committed retention floor and PostgreSQL's observed clock (`as_of`). With no intersection, both effective bounds and totals are null, buckets are empty and breakdowns are empty. This represents unavailable expired/future coverage, not zero traffic. A successfully queried observable interval has exact counts, including zero-filled buckets. First/last buckets return clipped inclusive bounds; drilldown uses those bounds directly. A relative refresh advances both requested bounds; an absolute investigation preserves them.

Counts deduplicate deliveries and revisions by the existing logical record identity. Decisions are grouped by original acceptance time and their latest delivered outcome, so an older bucket can change after verification completes. They are not a historical snapshot of what was known at that earlier time. Total includes unknown/unreadable outcome or provenance; final denial proportions use only Allow plus Deny as denominator. No response infers rejected requests, SDK fallback, enforcement, fraud, human identity or evaluation latency. Unknown counts and null breakdown dimensions have no invented filter alias.

Decision responses include top 10 check and captured-reason counts, ordered by count descending and then UTF-8 value ascending, null last on ties. `other_count` accounts for all remaining records; each breakdown reconciles to the filtered total. Event breakdowns are empty in this version. All sections come from one bounded analytical statement; no approximate or partial counts are returned.

Delivery metadata is installation-wide even for a scoped chart. Its oldest timestamp is the original acceptance time of a record awaiting delivery, not the time its current revision was queued or a measured export delay. Zero pending rows does not establish complete history: an admitted evaluation may not yet have produced its first history revision. `as_of` is a server observation, not an export watermark. Retention is likewise a visibility boundary, not evidence of uninterrupted collection.

Each process admits at most two concurrent analytics requests. Queries cap execution at 3 seconds, memory at 256 MiB, threads at 2, read rows at 20 million, read bytes at 2 GiB, aggregation/sort groups at 100,000 and output at 1 MiB/1,620 rows. These are safety limits, not throughput promises. Budget exhaustion, concurrency saturation or analytical failure returns 503 `unavailable`; the caller must retain scope and show an honest failure state instead of substituting zeros. See [ADR 0017](../decisions/0017-bounded-activity-analytics.md).

### Query-addressed identifiers

Use these additive admin routes when building new clients. Values belong in
URL-encoded query parameters so valid `.` and `..` identifiers survive browser
path normalization. Existing path routes and response contracts remain supported.
See [ADR 0015](../decisions/0015-query-addressed-identifiers.md).

| Resource | Query-addressed route (admin prefix omitted) |
| --- | --- |
| Check detail | `GET /lookup/checks?name={name}` |
| Draft save | `PUT /lookup/checks/draft?name={name}` |
| Publication / restoration | `POST /lookup/checks/publications?name={name}`, `POST /lookup/checks/restorations?name={name}` |
| Check versions / version | `GET /lookup/checks/versions?name={name}`, `GET /lookup/checks/versions/{version}?name={name}` |
| Event | `GET /lookup/events?id={id}` |
| Entity / direct relationships | `GET /lookup/entities?kind={kind}&id={id}`, `GET /lookup/entities/relationships?kind={kind}&id={id}` |
| Relationship / audit | `GET /lookup/relationships?kind={kind}&id={id}` |
| Relationship correction / restoration | `POST /lookup/relationships/corrections?kind={kind}&id={id}`, `POST /lookup/relationships/restorations?kind={kind}&id={id}` |

List and detail routes accept the same pagination parameters as their path
counterparts. Selectors must occur exactly once; duplicate or unknown parameters
are invalid. Values are decoded once and retain the same domain validation:
encoded-looking user IDs such as literal `%2e` remain distinct from `.`.
Mutations use the existing logical target and action for idempotency, so replay
across aliases returns the same receipt; the same key for another target conflicts.
Persisted interrupted requests retain their exact original path, body and key.

## Retention and recovery

`KRINE_HISTORY_RETENTION_DAYS` controls analytical events/decisions (default 30, integer 2–3650). Every replica reads the shared durable setting; all deployment configurations must agree. A shorter window applies to reads immediately; physical deletion follows asynchronously on a four-hour cadence. An extension waits for legacy rolling TTL retirement, reported as `applying: true` with the previous effective `days` and new `requested_days`. After retirement, changes become effective at configuration commit. PostgreSQL is the single retention clock and persists the expiry boundary. Later increases cannot recover already expired records, including delayed exports. This does not change metric windows or security retention; see [ADR 0014](../decisions/0014-observed-connection-and-history.md). Uncorrected IP segments expire 30 days since last observation; backend assertions and corrected/restored IP segments with their audit remain durable. Reliability envelopes and final responses survive at least the 24-hour supported retry window. Proof/challenge tombstones last at least 24 hours beyond last valid use. Unexported delivery records are never age-deleted. Each unfinished attempt reserves one delivery slot, including while its current snapshot is already exported; subsequent states coalesce into the same slot with their complete immutable transition history. Capacity exhaustion rejects new events, browser observations and attempts before acknowledging them; already accepted attempts can finish within their reserved slots. Export acknowledgements apply only to the exact revision sent. Operator retention changes cannot erase active retry or challenge state. See ADR 0009 for event projection and restart behavior.

### Relationship provenance and correction

`POST /v1/associations` accepts optional `session_id` (omitted or null means no
session). A supplied session must belong to the supplied Krine client. Responses
retain the existing association fields and add nullable `session_id` and
`credential_id`, `revision`, nullable `revocation_reason` and `revoked_by`.
`revoked_at` is a timestamp or null: an exact retry reads current correction state
and never restores an assertion. The accepted assertion's original timestamp,
credential and metadata remain unchanged. Omitting session preserves legacy
request digests, including explicit-null retries.

Admin routes use the existing cookie, CSRF and mutation identity contract:

| Route | Contract |
| --- | --- |
| `GET /v1/admin/entities/{kind}/{id}/relationships` | Direct relationships; entity kind client, session, user or ip; `limit` 1–100 (default 50), opaque `cursor`; `{items,next_cursor}`. |
| `GET /v1/admin/relationships/{kind}/{id}` | Kind `backend` or `observed_ip`; `{relationship,audit:{items,next_cursor},recalculation:"complete"}`; the same pagination parameters apply to audit. |
| `POST /v1/admin/relationships/{kind}/{id}/corrections` | `{revision,reason}`; invalidate reviewed evidence. |
| `POST /v1/admin/relationships/{kind}/{id}/restorations` | `{revision,reason}`; restore original evidence. |

Mutation success is `{relationship,audit_id,recalculation:"complete"}`. Reasons
contain 1–512 bytes, no control characters or surrounding whitespace. A stale
revision returns 409 `revision_conflict`; correcting an already corrected row or
restoring an active row returns `relationship_state_conflict`. Restoring an IP
segment when a newer active segment exists returns `relationship_active`. The
same idempotency key recovers its original mutation receipt even after later
changes. Reusing the key for another request returns `input_conflict`.

Relationship records have `id`, `kind`, `client_id`, nullable `session_id`,
`user_id` and `ip`, `first_seen`, `last_seen`, `source`, nullable `credential_id`
and `last_credential_id`, `first_source`, `last_source`, nullable `first_event_id`
and `last_event_id`, `revision`, nullable `revoked_at`, `revocation_reason` and
`revoked_by`, and `metadata`. Backend `source` is `backend`; observed source is
`browser_observation` with `browser.context`, `browser.proof` or `legacy` detail.
Audit records have `id`, `at`, `action` (`correct`/`restore` for new records),
`reason`, `actor`, `revision` and the resulting immutable `relationship` snapshot.
Migrated audit fields that were not recorded remain null.

Decision `relationship_context` contains the sampled active backend `items`,
exact `total`, `truncated`, `observed_at` and the current matching `observed_ip`
summary or null. Samples contain no customer metadata. The legacy
`relationship_ids` mirrors those sampled IDs and is not a complete relationship
inventory when `truncated` is true. See [ADR 0013](../decisions/0013-reversible-relationship-evidence.md)
for correction cutoff, retention and current-metric semantics.
