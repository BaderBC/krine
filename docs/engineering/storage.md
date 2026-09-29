# Storage responsibilities

Krine uses three stores with distinct ownership. [ADR 0009](../decisions/0009-protocol-and-reliability-boundaries.md) records the transaction and recovery boundaries.

## PostgreSQL

PostgreSQL owns durable configuration and enforcement state:

- checks, policy drafts and published versions, provider configuration and shared deployment settings;
- application credentials, revocations, the permanent bootstrap marker and operator sessions;
- entities, relationship provenance and correction audit;
- accepted event envelopes and projection recovery progress;
- operation identity, unique proof ownership, pinned evidence, verification state and retry responses;
- the delivery outbox for analytical history.

PostgreSQL participates in authorization. Its reliability envelopes support bounded retries and projection recovery; they do not replace ClickHouse history. Unexported delivery records remain durable. Credential and relationship guarantees are defined in [ADR 0012](../decisions/0012-durable-application-credentials.md) and [ADR 0013](../decisions/0013-reversible-relationship-evidence.md).

## ClickHouse

ClickHouse owns analytical event, browser-observation and decision history. It receives asynchronous, idempotent deliveries from the PostgreSQL outbox. Checks use captured evidence and realtime metrics rather than scanning analytical history.

Analytical retention is separate from retry and metric recovery retention; see the [retention contract](protocol.md#retention-and-recovery).

## Valkey

Valkey holds short-lived browser participation credentials and issued proofs, realtime event windows, request rate limits and provider lookup caches. It is a core runtime dependency. PostgreSQL owns proof consumption and operation recovery, so losing an issued proof cannot free an accepted proof for another operation.

Hot event projections are rebuilt from retained PostgreSQL envelopes after incarnation or watermark mismatch. Until a coherent projection is available, affected metrics remain unknown rather than becoming known zero. [ADR 0010](../decisions/0010-axum-runtime-and-durable-projection.md) explains this coordination.

## Metric catalog

The built-in metric definitions and versions are compiled into [`krine-core`](../../crates/krine-core/src/catalog.rs) and served by the backend. Published policies persist references to those exact versions; PostgreSQL does not maintain a second catalog.

## Event broker

The PostgreSQL outbox connects durable acceptance to analytical delivery. No broker is required. Add infrastructure only when measured ingestion or reliability requirements justify another boundary.
