# ADR 0001: Rust backend, TypeScript clients

**Status:** Accepted

## Context

Krine needs a high-throughput, low-latency backend while keeping SDK and frontend development straightforward.

## Decision

Use:

- Rust for the platform backend;
- TypeScript for browser SDK;
- TypeScript for server SDK;
- React + TypeScript + Vite for the dashboard.

## Consequences

- security/hot-path backend logic can be optimized in one systems language;
- browser/server integration remains natural for JavaScript applications;
- the dashboard shares the TypeScript ecosystem;
- additional languages should be added only when user demand or technical constraints justify them.
