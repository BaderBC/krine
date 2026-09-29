# Backend runtime

`krine-server` is the Axum service. Its public wire contract is
[protocol v1](protocol.md); [ADR 0010](../decisions/0010-axum-runtime-and-durable-projection.md)
records the runtime and recovery choices. [ADR 0011](../decisions/0011-provider-attempts-and-versioned-history.md) records provider persistence and history ordering.

The runtime includes browser context and action proofs,
authenticated context resolution, backend events and associations, published
check evaluation, durable retries, operator sessions, policy draft/publication
history, metric discovery, current entity inspection, durable browser observations, and
activity backed by the ClickHouse outbox, tested provider configuration, IP
intelligence, persisted challenge continuation, and durable application credential
creation/revocation, inspectable relationship correction and observed application
connection. Challenge policies cannot be
published before verification is configured. Unconfigured provider metrics are
explicitly unknown.

## Configuration

Every required string setting accepts either the value or a corresponding
`_FILE` path. Setting both is an error. Files contain the complete value; only
trailing newline characters are removed. Do not put secrets in command arguments
or logs.

| Setting | Meaning |
| --- | --- |
| `KRINE_DATABASE_URL` | PostgreSQL connection URL for the existing `krine` database |
| `KRINE_VALKEY_URL` | Authenticated Valkey URL using named user `krine`, database 0 |
| `KRINE_CLICKHOUSE_URL` | ClickHouse HTTP endpoint |
| `KRINE_CLICKHOUSE_USER` | Database user; defaults to `krine` |
| `KRINE_CLICKHOUSE_PASSWORD` | ClickHouse password |
| `KRINE_PUBLIC_KEY` | Browser key imported once on first startup; 16–512 printable ASCII bytes without spaces |
| `KRINE_SERVER_SECRET` | Distinct server secret imported once on first startup; 32–512 printable ASCII bytes without spaces |
| `KRINE_ADMIN_PASSWORD` | Operator password, at least 16 bytes |
| `KRINE_PUBLIC_URL` | Exact external API origin, without trailing slash |
| `KRINE_ADMIN_ORIGIN` | Exact dashboard origin; defaults to public URL |
| `KRINE_ALLOWED_ORIGINS` | Comma-separated exact browser application origins |
| `KRINE_BIND` | HTTP listen address; defaults to `127.0.0.1:8080` |
| `KRINE_DASHBOARD_DIR` | Optional immutable built dashboard assets for same-origin serving |
| `KRINE_TRUSTED_PROXIES` | Comma-separated proxy CIDRs; defaults to none |
| `KRINE_DEVELOPMENT` | Explicit `true` allows HTTP origins and non-Secure local cookies |
| `KRINE_BROWSER_RATE_PER_MINUTE` | Browser requests per normalized source IP; defaults to 300 |
| `KRINE_SERVER_RATE_PER_MINUTE` | Backend requests per installation; defaults to 3,000 |
| `KRINE_LOGIN_RATE_PER_MINUTE` | Operator login attempts per source IP; defaults to 10 |
| `KRINE_HISTORY_RETENTION_DAYS` | Analytical history retention; defaults to 30, range 2–3650; all replicas must agree ([retention](deployment.md#analytical-retention)) |
| `KRINE_MAX_PENDING_OUTBOX` | Delivery capacity including unfinished-attempt reservations; defaults to 1,000,000 records |

Application credentials are thereafter managed through the authenticated
credential API. Changing bootstrap environment values or restarting does not add
keys or restore revoked ones. They remain required environment inputs for
deployment compatibility. Stop all older environment-authenticating binaries
before upgrading. [ADR 0012](../decisions/0012-durable-application-credentials.md)
defines import, one-time secret disclosure, revocation and backup semantics.

Origins use HTTPS unless development mode is enabled. Trust only the addresses
of actual ingress proxies; their forwarding chain must remove untrusted appended
entries. The server walks `X-Forwarded-For` from the trusted TCP end and stops at
the first untrusted hop. IPv4-mapped IPv6 addresses normalize to IPv4.

Run `cargo run -p krine-server` after configuring the environment and starting the
[three stores](deployment.md). PostgreSQL migrations run before the HTTP listener
opens. Export creates its table in the already provisioned ClickHouse database;
an analytical outage delays export but does not stop authorization. The database
user never needs cluster administration or permission to create databases.

`GET /health/live` reports the process is serving HTTP. `GET /health/ready`
validates PostgreSQL and rebuilds an invalid hot projection before returning
ready. It does not require an up-to-date analytical export. Shutdown drains HTTP
requests and signals the bounded recovery/export worker.

## Verification

Ordinary checks:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The explicit real-store suite starts actual HTTP listeners and can migrate or
reset its stores. Provision all three dedicated test stores using the [README](../../README.md), then use the helper's enforced isolation guard. Never point ignored
tests at a development installation containing data to retain:

```sh
./scripts/with-dev-env.py --isolated-stores cargo test -p krine-server --test runtime -- --ignored --test-threads=1 --nocapture
```

It covers authoritative event visibility and numeric canonicalization,
concurrent event retries and proof ownership, operation recovery across a fresh
application instance, stale projection watermark recovery, publication revision
checks, unconfigured challenge publication, explicit provider unknowns, context
resolution, hostile origins, CSRF, source-IP spoofing, duplicate JSON keys,
payload limits, and the maximum policy condition depth. An additional ignored library test forces a
projection rollback between metric reads and checks that the snapshot is rejected;
build the SDKs/example with `pnpm --filter @krine/protected-app... build`, then run
`./scripts/with-dev-env.py --isolated-stores cargo test -p krine-server --lib -- --ignored --test-threads=1`. This also runs a
20,000-event retained-window rebuild within the worker recovery budget.

No proof, session credential, server credential or provider token is retained in
activity. Operational logs contain error classes, not raw dependency responses.

## Providers and verification

Only policies referencing IP intelligence (including derived `ip.high_risk`)
perform enrichment. Proxycheck v3 uses a one-second total lookup budget and a
60-second cache keyed by configuration revision and normalized IP. Cache reads
and writes each have a 50 ms budget; failure performs a fresh lookup. A stale
observation is never substituted after a provider error. Missing or invalid
fields remain individually unknown. Provider output and its actual timestamp
are frozen with the original native snapshot before policy evaluation.

Turnstile Siteverify has a 1.5-second total budget and no redirects. The secret,
expected browser hostname, accepted IP, fixed action and random step binding
are pinned. All steps share five minutes from original acceptance. Continuation
uses a persisted token digest, stable UUID and five-second fenced lease; no token
plaintext is stored. Expiry, rejected evidence and provider unavailability produce
stable evaluated denials. Provider calls never hold database locks. Configuration
format checking cannot validate Turnstile site-key/secret pairing; operators must
complete a real challenge through their application to verify it.

The provider regression suite uses controlled HTTP transports compiled only in
tests, real PostgreSQL schemas and separate ClickHouse tables. All three base
stores must also be isolated; fixture namespaces are no substitute for isolating
the complete suite. The guarded helper supplies the dedicated Valkey URL:

```sh
pnpm --filter @krine/protected-app... build
./scripts/with-dev-env.py --isolated-stores cargo test -p krine-server --lib provider_integration -- --ignored --test-threads=1 --nocapture
```

Tests cover candidate activation binding, exact dependent-version review under
concurrent publication/addition/removal, partial evidence, bounded provider
outage, repeated and concurrent tokens, cross-step/operation replay, provider
success before a lost commit, lease fencing, policy/configuration changes while
pending, second challenges, worker expiry and delayed analytical delivery. Adapter
unit tests separately exercise malformed, oversized, redirected and slow bodies.
The [combined application test](../../examples/protected-app/README.md#verify)
also exercises both built SDKs, sequential verification and durable business
deduplication through the actual protected application process.

Stop the previous application before applying migration 0003. PostgreSQL rejects
old writer generations after migration, including old outbox acknowledgements.
The queue is renamed to `delivery_outbox`, so old exporters cannot read new rows.
History export creates `history_v2` with an explicit revision and copies legacy
immutable history in checkpointed batches of 100. Interrupted batches can repeat safely. Keep PostgreSQL and
ClickHouse backups together; do not roll application code back independently of
this schema. Migration 0004 requires writer generation 3 and coalesces each logical
delivery to its latest complete revision;
immutable transitions and final retry responses remain durable. Export acknowledges
only its captured revision. An unfinished attempt reserves a delivery slot even
when its latest snapshot has exported, so a full queue does not grow with each
challenge step. Pending attempts survive cleanup until their durable expired final
exports; cleanup never discards unexported finals. Historical provider revisions expire after 30 days unless current
or referenced by an unfinished attempt; expired activation tests are removed.

Relationship correction uses migration 0006 and writer generation 4. Stop all
older processes before upgrading. Assertions retain server credential and optional
session provenance; observed IPs retain browser credential/source provenance.
Admin correction/restoration and check snapshots coordinate per client, keeping
current counts and captured context coherent. Captured relationship samples are
bounded independently of the exact metric aggregation. Corrected IP segments
retain their audit beyond ordinary 30-day observation cleanup. See
[ADR 0013](../decisions/0013-reversible-relationship-evidence.md) for the durable
contract and [protocol](protocol.md#relationship-provenance-and-correction) for
routes and conflict behavior.

Observed connection and bounded captured Activity reasons use migration 0007 and
writer generation 5. Receipt markers commit with durable admission, survive
analytical outages/expiry and distinguish tracking from retained upgrade history.
Analytical retention is shared through PostgreSQL; changing it never alters metric
windows or retry protection. See [ADR 0014](../decisions/0014-observed-connection-and-history.md).
