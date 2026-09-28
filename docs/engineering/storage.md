# Storage responsibilities

This document records responsibility boundaries, not schemas.

## PostgreSQL

Use PostgreSQL for durable relational/control-plane state.

Likely responsibilities:

- checks and policy definitions;
- metric catalog/definitions;
- provider configuration;
- identity relationships;
- durable project/configuration data.

## ClickHouse

Use ClickHouse for high-volume historical/analytical data.

Likely responsibilities:

- application events;
- client telemetry;
- decision history;
- analytical time-series/history.

## Valkey

Use Valkey for realtime and short-lived hot state.

Likely responsibilities:

- velocity counters;
- TTL-backed features;
- one-time proof state/consumption;
- short-lived decision inputs;
- hot metric state.

Valkey is currently considered a core architectural component, not merely an optional cache.

## Event broker

No broker has been selected.

Do not introduce Kafka, Redpanda, NATS or another bus until ingestion/reliability requirements demonstrate why it is needed.

## Principle

Choose storage according to access pattern:

- durable relational truth → PostgreSQL;
- large historical analytical scans → ClickHouse;
- low-latency mutable/ephemeral state → Valkey.

The detailed schema should emerge from protocol and implementation work rather than being invented prematurely in documentation.
