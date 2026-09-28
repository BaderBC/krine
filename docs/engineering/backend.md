# Backend runtime

`krine-server` is the Axum service. Its public wire contract is
[protocol v1](protocol.md); [ADR 0010](../decisions/0010-axum-runtime-and-durable-projection.md)
records the runtime and recovery choices.

This first executable slice includes browser context and action proofs,
authenticated context resolution, backend events and associations, published
check evaluation, durable retries, operator sessions, policy draft/publication
history, metric discovery, current entity inspection, durable browser observations, and
activity backed by the ClickHouse outbox. Provider
configuration and challenge execution, credential management and relationship
correction remain separate implementation units. Challenge policies cannot be
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
| `KRINE_PUBLIC_KEY` | Bootstrap browser key, at least 16 bytes |
| `KRINE_SERVER_SECRET` | Independent backend credential, at least 32 bytes |
| `KRINE_ADMIN_PASSWORD` | Operator password, at least 16 bytes |
| `KRINE_PUBLIC_URL` | Exact external API origin, without trailing slash |
| `KRINE_ADMIN_ORIGIN` | Exact dashboard origin; defaults to public URL |
| `KRINE_ALLOWED_ORIGINS` | Comma-separated exact browser application origins |
| `KRINE_BIND` | HTTP listen address; defaults to `127.0.0.1:8080` |
| `KRINE_TRUSTED_PROXIES` | Comma-separated proxy CIDRs; defaults to none |
| `KRINE_DEVELOPMENT` | Explicit `true` allows HTTP origins and non-Secure local cookies |
| `KRINE_BROWSER_RATE_PER_MINUTE` | Browser requests per normalized source IP; defaults to 300 |
| `KRINE_SERVER_RATE_PER_MINUTE` | Backend requests per installation; defaults to 3,000 |
| `KRINE_LOGIN_RATE_PER_MINUTE` | Operator login attempts per source IP; defaults to 10 |
| `KRINE_MAX_PENDING_OUTBOX` | Pending export ceiling; defaults to 1,000,000 records |

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

The explicit real-store suite starts actual HTTP listeners against the configured
databases and creates unique test identifiers. Use a dedicated development or CI
installation, then run:

```sh
cargo test -p krine-server --test runtime -- --ignored --test-threads=1 --nocapture
```

It covers authoritative event visibility and numeric canonicalization,
concurrent event retries and proof ownership, operation recovery across a fresh
application instance, stale projection watermark recovery, publication revision
checks, unsupported challenge publication, explicit provider unknowns, context
resolution, hostile origins, CSRF, source-IP spoofing, duplicate JSON keys,
payload limits, and the maximum policy condition depth. An additional ignored library test forces a
projection rollback between metric reads and checks that the snapshot is rejected;
run it with `cargo test -p krine-server --lib -- --ignored`. This also runs a
20,000-event retained-window rebuild within the worker recovery budget.

No proof, session credential, server credential or provider token is retained in
activity. Operational logs contain error classes, not raw dependency responses.
