# ADR 0016: Bounded ClickHouse diagnostics

**Status:** Accepted

## Context

ClickHouse's console logger and its analytical diagnostic tables have independent
configuration. The pinned 26.8.11.7 defaults collect a wide metrics row every
second, flush frequently and leave most diagnostic logs without a TTL. A long
running development instance accumulated enough metric-log merge work to hit
its memory limit and disrupt application queries. Its metric table had 2,109
columns. Raising limits would not bound this unrelated background workload.

Krine needs query/error investigation and crash evidence. Continuous database
profiling is not a core product capability, and must not consume resources needed
for application history and security decisions.

## Decision

Configure current query and crash logs with a seven-day TTL from their event
timestamp, in daily partitions. Bound their in-memory row queues; flush query
logs every minute or when the buffer threshold is reached. Disable the shipped high-frequency debug
and unused integration collectors. Preserve rotated warning/error console logs,
current system metrics and the application's restricted view of its own query
history. Do not expand the application's database permissions.

Apply this policy to existing volumes during the existing loopback-only bootstrap
phase. Force preparation of canonical `system.query_log` and `system.crash_log`
before inventorying their archives. Upstream ClickHouse may rename incompatible
definitions, including operator-customized canonical tables, to `name_N` before
the helper's filter runs. Rotation preserves rows and comments, but can mark
non-replicated MergeTree archives without a TTL read-only.

The helper then matches only a pinned upstream base name or a numeric rotation
suffix, the MergeTree engine and its exact upstream identifying comment. Its
mutations leave unrecognized system objects and every application database table
untouched; that restriction does not prevent upstream canonical-log rotation.

Drop recognized disabled debug-log tables, including their numeric archives.
For recognized query/crash archives, preserve recent rows: clear the read-only
flag and replace any different retention with the exact seven-day TTL.
Materialize it once;
matching metadata skips repeated work. Metadata and pending TTL mutation are
persisted together by the pinned server. Use `alter_sync=0` because an archive
loaded read-only has no background worker until the normal server restart.
That restart executes pending materialization; expiration remains asynchronous.
A failure during bootstrap prevents public readiness and a later startup resumes
from durable table metadata without a separate marker or parallel migration store.

The explicit additional bootstrap grants request selected `system.tables`
metadata columns, log flushing, DROP on enumerated disabled log families, and
TTL/settings alteration on the two retained families. The column list is not an
effective column-only restriction: pinned ClickHouse implicitly grants SELECT on
`system.tables`, with row visibility filtered by SHOW privileges. This baseline
metadata access grants no application rows, diagnostic contents or maintenance
authority.
Prefix privileges cover ClickHouse's numeric archives; the maintenance statements
additionally enforce exact names and metadata. The identity is restricted to
loopback and removed before the normal listener starts. It gains no application
data access or user-management authority.

## Consequences

Operators should export debug diagnostics needed for an ongoing investigation
before upgrading. Recent retained query/crash evidence survives schema/config
rotation; raw profiling history is deliberately retired. Unrecognized custom
archives keep their existing retention, including no TTL, rather than receiving
the seven-day bound. Operators remain responsible for those archives' retention
and read-only settings. Custom noncanonical objects are untouched by the helper.
Empty expired recognized archives may remain as metadata. Future ClickHouse
upgrades must review the upstream definitions and rerun the permission/upgrade
regressions.

Seven-day retention and bounded buffers control diagnostic workload; they are
not a disk quota, a capacity promise or a replacement for monitoring. Size the
host for the documented stores and measured application workload. Query logging
is buffered and can lose unflushed records during a crash or overflow. None of
these operational-log choices changes Krine event, decision or audit retention.

Sources: pinned [server configuration](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/programs/server/config.xml),
[log preparation/rotation](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Interpreters/SystemLog.cpp),
[MergeTree startup/ALTER behavior](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Storages/StorageMergeTree.cpp),
and [implicit metadata access](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Access/ContextAccess.cpp).
