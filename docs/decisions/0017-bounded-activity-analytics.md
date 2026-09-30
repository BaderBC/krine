# ADR 0017: Bounded Activity analytics

**Status:** Accepted

## Context

Investigators need to see when trust activity changed, narrow an interval and
open its underlying records. Recent-row lists alone cannot show a burst or the
shape of a subject's history. Charts must preserve Krine's authority, retention,
revision and missing-data semantics.

## Decision

Add one authenticated `/v1/admin/analytics/activity` resource with explicit,
bounded, inclusive millisecond ranges. Reuse exact Activity filter predicates;
add captured decision reason and event provenance filters to both relevant
surfaces and bind them to cursors. Preserve existing cursor digests when the
new filters are absent. The [protocol](../engineering/protocol.md#activity-analytics)
defines the response and limits.

Count latest delivered logical records using `FINAL`. Bucket decisions by their
immutable acceptance time and current recorded outcome. Completion may therefore
change an older bucket. Count backend events separately from browser evidence.
Return exact totals, bounded series, and top check/reason breakdowns from one
statement. Retain Unknown in the denominator accounting, and never infer fraud,
rejected requests, SDK fallback, enforcement or evaluation latency.

Preserve `history_v2` and its replacement identity `(kind,id)`. Add materialized
nullable scalar columns derived from each payload for filters and grouping;
retain full payloads for detail. Do not add mutable outcome, completion time,
subject or other values to the replacement key. In particular, application event
IDs have bounded retry protection, not an enforced all-time timestamp invariant.
A reused event identity must retain existing replacement semantics before time
or subject filtering.

The new named analytical migration adds metadata idempotently and validates the
complete expected column definitions before recording completion. Existing parts
calculate missing materialized values at read time; new parts store them. Old
parts therefore require separate performance measurement. Issue no MATERIALIZE,
new rolling TTL, new table copy or unrelated row-rewrite mutation. The current
retention checkpoint interprets later completed mutations as its cleanup barrier;
future rewrite migrations must coordinate their exact durable operation identity
with that recovery protocol. Additive columns need no PostgreSQL schema or
writer-generation change. Legacy backfill uses explicit target columns.
Only the analytics handler prepares these columns. Ordinary history delivery,
lists and detail reads remain available if analytical preparation fails.

Disable automatic PREWHERE movement for these `FINAL` queries. Bound intermediate
aggregation, sorting, scans, execution, memory, threads and final output. Throw on
limits rather than returning partial totals. Buffer the bounded HTTP result until
query completion, and limit analytics concurrency per application process. An
unavailable query yields an error and does not become an empty series.

Encode bound `param_*` values in ClickHouse's Escaped format before HTTP URL
encoding. This preserves literal backslashes and control characters across all
shared history queries; URL encoding alone does not. Transport settings remain
unchanged, and cursor hashes bind the original selectors.

Intersect requested ranges with the committed PostgreSQL retention floor and
server observation time. An entirely expired/future range has null totals;
a successfully queried empty observable range has zero counts. Return the
original and effective bounds, retention metadata and asynchronous visibility.
Installation-wide outbox count and oldest original acceptance time explain
pending delivery without claiming a complete watermark or measured export lag.

## Consequences

Activity and entity/check investigation can share one restrained chart contract
and ordinary record links. Analytical queries stay off the enforcement path.
No production authentication, proof, timestamp or provider boundary is weakened.
No new ClickHouse grant, store, aggregate counter view or historical copy is
required. Insert-triggered count materialization is unsuitable because repeated
outbox deliveries and evolving decision revisions would contribute repeatedly.

The existing identity-oriented sort order still limits pruning by time or
subject. Scalar columns reduce JSON work for newly stored parts; they do not
establish a million-row latency promise. Any later physical redesign requires
measured need and an explicit identity, migration, retention and delivery plan.
Per-process concurrency limits describe the supported single-host baseline,
not a fleet-wide admission controller.

Sources: ClickHouse's [replacement and FINAL semantics](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/replacingmergetree),
[column addition/materialization](https://clickhouse.com/docs/reference/statements/alter/column),
[query complexity limits](https://clickhouse.com/docs/concepts/features/configuration/settings/query-complexity),
and [HTTP parameter encoding and response buffering](https://clickhouse.com/docs/concepts/features/interfaces/http).
