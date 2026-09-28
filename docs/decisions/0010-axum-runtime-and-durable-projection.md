# ADR 0010: Axum runtime and durable projection recovery

**Status:** Accepted

## Context

The first executable vertical slice needs an HTTP runtime, concrete persistence,
and a recovery mechanism that honors ADR 0009 with the existing three stores.
The founder prefers Axum. No new infrastructure is warranted.

## Decision

Use Axum on Tokio for the modular Rust service, SQLx for PostgreSQL, redis-rs for
Valkey, and a bounded HTTP client for ClickHouse. Keep the pure evaluator in
`krine-core`. HTTP decoding, authentication, policy administration, browser
participation, ingestion, evaluation, projection and export are separate modules
in `krine-server`.

Use PostgreSQL migrations for configuration and bounded reliability envelopes.
An event's immutable envelope is committed before projection. Event acceptance
and projection changes share a short PostgreSQL coordination lock. This supplies
a closed input set while rebuilding a fresh Valkey generation, without a
cross-store transaction. Sorted sets keyed by generation, entity and event ID
make event projection naturally idempotent. The current generation and durable
watermark must match PostgreSQL, and the live Valkey `INFO server` incarnation
must match before reading hot metrics. Validate them again after the reads.
A failed validation leaves hot evidence unknown rather than known zero.
Capture the snapshot/acceptance timestamp after acquiring and recovering the
projection, and recheck proof expiry at that point. Hot evidence has an enforced
five-second read budget; counters retain their five-minute window plus that
budget and one second of expiry rounding. A read exceeding its budget is unknown.
This prevents lock waits, rebuild pruning or key expiry from creating an
apparently empty window at an earlier claimed snapshot time.

A single coordination row is a deliberate initial throughput tradeoff. Keep
lock and dependency deadlines bounded; measure concurrent ingestion and checks.
Partition this lock only when measured contention requires it, preserving the
same acknowledgement and generation guarantees.

A check first commits an operation identity, unique proof digest, policy,
metric snapshot and relationship context. Evaluation then finalizes that durable
envelope and creates an outbox entry in one transaction. A process interruption
between claim and finalization is recovered by an exact retry. Initial proof
expiry does not invalidate recovery. Provider calls are not implemented in this
unit; challenge publication requires configured verification and is rejected
until that capability exists.

Use a PostgreSQL outbox and ClickHouse `ReplacingMergeTree` keyed by record kind
and identity. Reads use `FINAL` to eliminate duplicate deliveries. Export may
lag; it never changes enforcement. Exported reliability records retain 48 hours
of recovery history, exceeding the 24-hour retry promise and the five-minute
materialized event window. Unexported records are not age-deleted. ClickHouse
owns the 30-day analytical history. Capacity exhaustion refuses new durable
acceptance before acknowledgement.

Bootstrap configuration provisions distinct browser, server and operator
credentials. All secret settings support file input. Valkey uses its named
`krine` identity and only `krine:*` keys. HTTP runs behind an operator-controlled
TLS endpoint; explicit development mode permits local HTTP. Forwarded IPs are
used only when the TCP peer is in the configured trusted proxy CIDRs.

## Consequences

The runtime follows the founder's framework preference and remains one deployable
service. PostgreSQL is deliberately on the authorization path for durable replay
protection. The current generation lock favors reviewable correctness over
unmeasured partitioning. ClickHouse failure is an export backlog; PostgreSQL or
participation-store failure remains an explicit availability failure.
