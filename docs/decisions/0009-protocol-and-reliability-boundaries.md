# ADR 0009: Protocol and reliability boundaries

**Status:** Accepted

## Context

The MVP needs one concrete contract across browser participation, authoritative checks, events, policy publication and investigation. Proof replay protection and event acknowledgement must remain correct during concurrency, dependency failure and process restart. PostgreSQL, Valkey and ClickHouse have distinct storage responsibilities; no distributed transaction spans them.

## Decision

Adopt the versioned JSON [HTTP protocol](../engineering/protocol.md). Separate public browser credentials, backend credentials and admin sessions. Issue opaque action/IP-bound proofs with a 60-second initial acceptance lifetime. An operation ID and canonical immutable request identify one logical attempt. A changed request conflicts; challenge evidence is a narrowly permitted continuation. Retain stable final results for 24 hours and allow challenge continuation for five minutes after initial acceptance. Pin the published policy, metric snapshot, relevant relationship context and provider configuration revisions at acceptance.

Use a pure, bounded, deterministic evaluator. Published policies declare typed backend inputs and exact metric versions. Ordered conditions use three-valued logic; default unknown and final paths deny. Verification succeeds into the next rule and failed/expired/unavailable verification denies. The server owns authenticated verification state; browser-supplied success flags never enter evaluation.

PostgreSQL owns durable configuration, relationships, and bounded reliability records: accepted event envelopes awaiting projection/export, immutable attempt envelopes and result snapshots during retry retention, proof consumption/operation uniqueness guards, and an export outbox. Durable uniqueness constraints and row locks serialize claim, continuation and finalization. These bounded records support recovery; ClickHouse remains the historical analytical store. Store only token digests in durable guards. Valkey owns browser context/proof issuance and atomically updated realtime windows; it is a core dependency. ClickHouse receives idempotently keyed history from the PostgreSQL outbox and may lag without weakening enforcement.

For events, first durably claim the immutable envelope and its acceptance timestamp. Apply all affected hot projections atomically with a Valkey script and an event-ID deduplication marker. Acknowledge only after the projection is confirmed visible; failure returns an error and leaves the durable envelope retryable. A worker or exact retry can repeat projection without double counting. Outbox export is independent of this acknowledgement. If PostgreSQL finalization fails after Valkey success, recovery repeats the idempotent projection and then records completion.

Valkey must never silently reset acknowledged counters to zero. Validate its current process incarnation (`run_id`) and durable projection watermark against PostgreSQL, not merely an in-cache readiness marker: restoring an old AOF/RDB can restore the marker while losing acknowledged counters. After restart, rollback, loss or mismatch, mark hot metrics unavailable and rebuild the entire retained active window from durable reliability envelopes before advertising readiness. Serialize rebuild/generation switching with new projection writes so a rebuild cannot overwrite an acknowledged concurrent event. Durable retention covers the longest materialized metric window, not merely the event retry window. PostgreSQL relationships and first-seen records rebuild their corresponding hot state. Acknowledged history must remain reconstructible throughout its influence on supported metrics. Eviction is disabled; memory pressure fails writes instead of dropping evidence. A check either reads a coherent ready snapshot or records explicit unknown due to unavailable state; it never treats an uninitialized projection as an empty known window.

A check claims operation identity and proof ownership durably before evaluation. A crash after claim leaves a resumable operation, never permission for a second operation to consume that proof. The unique operation record retains pinned context before external verification. A bounded worker lease may resume the same record; fencing prevents an expired worker from overwriting newer state. Provider verification is a side effect with potentially unknown outcome: persist its attempt identity first, use provider-supported retry identity when available, and deny with an explicit unavailable cause when success cannot be safely recovered. Never call an external provider while holding an unbounded database lock. Finalization writes the stable response and history outbox atomically. Returning a final response performs no additional decision side effects.

## Alternatives considered

- Valkey-only retry and acknowledgement records would lose the security/reliability promise after hot-store data loss.
- Synchronous ClickHouse history writes on every check would couple authorization to analytical availability and would not provide transactional replay protection.
- A broker adds another recovery boundary without removing the need for durable claims and idempotent projections.
- Re-evaluating after verification would let policy edits, new evidence or provider changes silently alter the original attempt.

## Consequences

Checks depend on PostgreSQL for durable one-attempt semantics and Valkey for fresh participation/hot metrics. Small durable reliability windows add relational writes but keep the modular monolith operable and auditable. Provider outages remain explicit evidence states. Operators must provision durable database storage and adequate Valkey memory; backup/restore must restore coherent reliability state before accepting traffic. Replaying a Krine result does not make the customer's protected business action idempotent.
