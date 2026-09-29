# ADR 0014: Observed connection and bounded analytical history

**Status:** Accepted

## Context

Application connection must report evidence Krine actually received, including
when analytical storage is unavailable. A received decision does not prove that
the application enforced it. Activity needs a useful explanation without loading
whole policy snapshots for every row. ADR 0007 requires configurable analytical
retention without weakening retry protection or changing metric semantics.

## Decision

Store one small PostgreSQL receipt marker for client evidence, one for backend
events and one per check for its first admitted attempt. Insert the marker in the
same transaction as the durable receipt or operation claim, using the existing
unique key to resolve concurrent first arrivals. Rollback removes both. Later
traffic and retries cannot overwrite the marker. It contains only the record ID,
accepted timestamp and coverage basis; no request payload or secret.

Record when tracking began. At upgrade, backfill only the oldest surviving
PostgreSQL reliability records and label them `retained_history`. These are not
all-time firsts and do not imply complete historical coverage. New markers use
`tracked`. Global evidence/event receipts remain explicitly separate from the
selected check. Invalid requests before admission create no attempt. This release
does not ingest local SDK fallback reports or add a request-error pipeline.

Setup reports detail availability independently from receipt presence. Check at
most three IDs in the outbox, indexed operation claims and, where necessary,
ClickHouse. Distinguish available, pending evaluation, confirmed missing/expired,
and temporarily unavailable. Markers survive history expiry so connection status
does not revert to “nothing received.” Activity lists remain asynchronous.

Capture a typed reason sample with each decision's history revision from that
revision's policy, trace and evidence snapshot. Include its decisive rule or a
bounded sample of Otherwise continuations, metric versions, original Unknown
causes and provider revisions. Bound it to three rules, four condition leaves and
8 KiB of serialized UTF-8, with explicit structural and value truncation. Keep
full logic in decision detail. Legacy records return no sample rather than using
current metrics to invent one. Queries project only this bounded sample and
existing scalar summaries, not complete decision envelopes.

Activity search may match an exact ID across namespaces for general investigation.
An optional validated entity kind narrows it to that namespace; entity links must
supply the kind. New cursors bind all filters. Older cursors remain supported for
untyped requests only. No identity inference follows from equal strings.

Analytical events and decisions default to 30 days. Operators set an integer
`KRINE_HISTORY_RETENTION_DAYS` between 2 and 3650 for the deployment. Startup
persists the target in PostgreSQL; all replicas read that shared target. Every
replica must use matching configuration. There is no dashboard retention control.

PostgreSQL is the retention clock. Configuration changes, history reads and
cleanup advance a committed monotonic `expired_before` boundary. Configuration
captures the smaller of the previous effective window and the requested window,
even after a period without reads. Neither a clock step backward, a later increase,
lagging physical deletion nor delayed delivery can reveal already expired data.

Retire existing rolling ClickHouse TTLs before activating an extension. Remove
TTL metadata from each owned history table, then wait for a deletion mutation at
a committed absolute cutoff to finish. Recompute the previous effective boundary
when both barriers finish. Until then APIs expose the effective `days`,
`requested_days` and `applying`; shortening takes effect immediately. After this
one-time transition, increases take effect at configuration commit, including
during analytical outages. Increasing retention grows future coverage; it never
recovers data already expired.

Physical cleanup uses `DELETE WHERE at < <committed cutoff>`, with no rolling TTL.
A separate worker polls pending work every 30 seconds and schedules at most one
job per table every four hours after the previous job completes. It scans the
timestamp column and rewrites affected parts asynchronously. Idle polls use only
PostgreSQL. History export and decisions do not await physical completion. One
advisory transaction lock coordinates replicas; short separate transactions
commit the cutoff and job intent before sending irreversible work. Recovery checks
mutation identifiers/status, including after lost HTTP responses or process death.
A fixed query ID per table rejects simultaneous submissions, and
`number_of_mutations_to_throw=1` rejects a second unfinished mutation. Retries use
the same committed cutoff. Only the four required metadata columns are granted
on `system.mutations`; queries restrict them to the two owned history tables.

The barrier is tied to pinned ClickHouse 26.8.11.7. In
[`StorageMergeTree.cpp`](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Storages/StorageMergeTree.cpp),
`CurrentlyMergingPartsTagger` reserves merge source parts;
`selectPartsToMutate` excludes reserved parts; `getMutationsStatus` reports done
only after active parts have reached the mutation version. An old TTL merge
therefore must commit before its resulting part can cross the retirement barrier.
Metadata removal alone is insufficient. In
[`ProcessList.cpp`](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Interpreters/ProcessList.cpp),
query IDs are registered under the process-list mutex and duplicates are rejected.
The queue guard in
[`MergeTreeData.cpp`](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Storages/MergeTree/MergeTreeData.cpp)
checks unfinished mutations before submission. Together these prevent overlapping
submissions and a backlog of uncertain retries without granting query cancellation
or access to mutation commands/errors. Revalidate these properties when upgrading
ClickHouse. Operators must not alter the owned tables independently.

Export still acknowledges only successfully delivered exact revisions. Delayed
outbox delivery may reach ClickHouse after expiry, but read filters and absolute
cutoff cleanup keep it invisible and eligible for deletion. Never age-delete undelivered records to
implement retention. Existing PostgreSQL retry/replay protection, 30-day metric
windows and relationship correction retention remain independent.

## Consequences

PostgreSQL stores a bounded number of receipt markers per check and a single
retention setting with two cleanup checkpoints. ClickHouse remains the analytical
store. Setup can explain coverage and outages without scanning historical payloads
or adding infrastructure.
Increasing retention provides future coverage, not data recovery; APIs expose the
effective boundary so operators can see this distinction.

Migration 0007 requires writer generation 5. Fresh and earlier supported databases
retain the dedicated generation-3 migration connection until the complete migration
chain finishes; runtime connections then use generation 5. Stop all older servers
before upgrade. Existing database fences reject their durable writes, but cannot
stop an old process from issuing ClickHouse DDL. Matching fleet configuration and
controlled upgrades remain operational requirements.
