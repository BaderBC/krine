# ADR 0002: PostgreSQL, ClickHouse and Valkey

**Status:** Accepted direction

## Context

Krine combines control-plane configuration, very large event history and latency-sensitive realtime security state. Treating all three workloads as the same database problem would compromise either simplicity or performance.

## Decision

Use:

- PostgreSQL for durable relational/control-plane data;
- ClickHouse for high-volume historical/analytical data;
- Valkey for realtime counters, TTL state and hot-path data.

Do not select an event broker yet.

## Consequences

- deployment has multiple core dependencies;
- each dependency has a clear access-pattern responsibility;
- deployment UX must make this stack easy to operate;
- future agents should not collapse the stack merely to reduce dependency count unless measurements justify it.
