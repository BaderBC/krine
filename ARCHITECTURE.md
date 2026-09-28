# Architecture overview

This file is intentionally a map, not a protocol or database specification.

## High-level flow

```text
Client-side signals ─────┐
                         │
Backend application events ──► event/entity history
                         │
                         ▼
                    Metrics layer
                primitive + derived
                         │
                         ▼
                     Check policy
                         │
                         ▼
                 explainable decision
                         │
                         ▼
                       Backend
```

The browser is not authoritative. Client-side collection contributes evidence only.

The backend is authoritative for application events, user identity enrichment and enforcement of Krine decisions.

## Main product areas

### Browser SDK

TypeScript.

Responsibilities currently agreed:

- maintain Krine client/session context;
- collect fingerprint/browser/device evidence;
- optionally collect passive client telemetry;
- participate in the interaction-proof / challenge flow before protected actions.

The exact wire protocol is deliberately not fixed yet.

### Server SDK

TypeScript.

Responsibilities currently agreed:

- emit authoritative application events;
- associate Krine client context with backend-known users or metadata;
- request authoritative checks from Krine;
- apply local fail-open / fail-closed behavior when Krine is unavailable.

### Platform backend

Rust.

Prefer a modular monolith with clear internal module boundaries. Split services only when runtime or scaling evidence justifies it.

Logical areas include:

- event ingestion;
- identity and relationships;
- metrics;
- provider integrations;
- checks / policy evaluation;
- decisions and explanations;
- dashboard/query APIs.

These are logical responsibilities, not mandatory process boundaries.

### Dashboard

React + TypeScript + Vite.

The UI should revolve around a small number of first-class product concepts, especially:

- Checks
- Metrics
- Clients / users
- Decisions
- Providers

Avoid dashboard sprawl.

## Storage responsibilities

### PostgreSQL

Durable control-plane and relational configuration, such as:

- policy/check definitions;
- metric definitions;
- provider configuration;
- identity relationships;
- durable settings.

### ClickHouse

High-volume historical data, such as:

- events;
- telemetry;
- decisions;
- analytical history.

### Valkey

Realtime / short-lived hot-path state, such as:

- velocity counters;
- short-lived proof state;
- TTL-based values;
- hot features and counters.

See `docs/engineering/storage.md`.

## Design principle

Krine may internally resemble a realtime data platform:

```text
events → entities → metrics → checks
```

But unlike an analytics product, checks are on the security hot path. Realtime state must therefore be fast and explicit rather than relying on arbitrary analytical queries during each request.
