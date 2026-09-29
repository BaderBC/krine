# ADR 0011: Pinned providers, fenced verification and versioned history

**Status:** Accepted

## Context

External evidence is fallible. A protected attempt must survive timeouts, provider
configuration changes and crashes without consuming another browser proof,
changing the evaluated policy or authorizing an unverified action. A pending
challenge can advance through several ordered rules while remaining one Activity
record. An older analytical delivery must never resurrect its pending state.

## Decision

Use fixed-origin proxycheck v3 for IP intelligence and Turnstile for verification.
Policies continue to depend on normalized metrics and verification capability.
Keep adapters bounded, redirect-free, strict about successful fields, and free of
request/body logging. No production endpoint overrides or test-credential bypasses.

Claim an attempt's immutable input, policy, native evidence, relationships,
required provider revisions and validated browser hostname in PostgreSQL before
external enrichment. Only referenced IP metrics trigger a lookup. Freeze the
first durably committed enrichment result, including per-field unknown causes,
revision and actual observation time. A 60-second revision/IP cache is an
optimization; stale evidence never replaces failed fresh lookup.

Each challenge step has a random identity and binding, one rule, pinned provider
revision and stable UUID. Persist its globally unique token digest before calling
Siteverify. The request includes the pinned secret/IP and validates hostname,
`krine_verify`, binding and timestamp. Allow five seconds of provider clock skew
without extending the original five-minute attempt deadline. Never persist the
token plaintext. A five-second lease and incrementing fence allow the original
evidence to recover an interrupted provider call with the same UUID. Only the
current unexpired fence can commit. Recovery without that original evidence after
lease expiry is unavailable and denies. Ordinary pending retries call no provider.
Passed steps advance against the same snapshot; each further challenge is distinct.
Final responses remain stable for the original 24-hour recovery window.

Provider configuration revisions are immutable. Candidate tests bind their exact
resolved configuration digest and current revision to a ten-minute activation
token. Configuration writes compare revision and require explicit acknowledgement
when published checks depend on the capability. Bind that review to the exact
sorted check/version set; stale confirmation conflicts before mutation. Publication
locks previous and next capabilities in fixed order, including removed dependencies,
so review validation and policy changes serialize without locking human review.
Keep credentials in protected
PostgreSQL configuration, separate from public read models and attempt/history
payloads. Turnstile provides no safe read-only pairing test: report
`configuration_checked` honestly and require an application challenge to establish
live pairing. Proxycheck tests a fixed public address; usable partial evidence reports
`configuration_checked`, retaining unknown fields and warning that other IPs may
differ. Wholly unusable evidence cannot activate a candidate. No dashboard widget wizard.

Persist chronological verification transitions with each attempt state change.
Keep one delivery row per logical attempt with a monotonically increasing revision.
Each update coalesces the complete snapshot and immutable transition list into that
row. An unfinished attempt reserves one delivery slot even after its latest state
has exported, so continuation and finalization stay within admission capacity.
Export releases database locks before network I/O and acknowledges only the exact
revision sent; an old acknowledgement cannot clear a newer queued revision.
ClickHouse `ReplacingMergeTree(revision)` makes delayed/ambiguous delivery
idempotent and deterministic. Queries return one latest logical attempt while
preserving its transition history. Upgrade from the legacy immutable table by
idempotent revision-one copies into `history_v2`, checkpointing each 100-record
batch in PostgreSQL before marking completion.
The supported single-host upgrade stops the old writer first; schema guards make
surviving old writers fail instead of acknowledging incompatible exports. Rename
the PostgreSQL queue to `delivery_outbox` so old exporters also fail before sending
new revision payloads to the legacy analytical table. Migration 0004 requires writer
generation 3 because a generation-2 exporter acknowledged whole rows without
checking the revision. Pending attempts survive reliability cleanup until expiry
produces and exports their final transition.

## Consequences

External calls hold no database locks. Native evidence remains pinned even when
an interrupted lookup is retried before its first durable completion. Provider
outage is explicit unknown evidence or a failed verification, not an availability
fallback allow. The SDK still owns initial service-outage fallback.

The lease can require a same-token retry after a process interruption. If the
provider cannot recover that UUID/token result, the attempt denies. This favors
security over guessing whether a consumed token had succeeded. Configured providers
are optional and self-hosted Krine never depends on a Krine-operated service.
