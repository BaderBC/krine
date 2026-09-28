# Krine agent guide

Krine is an open-source, self-hosted trust decision engine.

The core product model is:

**Events → Entities → Metrics → Checks → Decisions**

Applications continuously provide Krine with trustworthy backend events and untrusted client-side signals. Before a protected action is executed, the backend asks Krine whether that action should be allowed. Krine evaluates current evidence, history, metrics and a no-code policy, and returns the decision.

## Stack

- Browser SDK: TypeScript
- Server SDK: TypeScript
- Dashboard: React + TypeScript + Vite
- Backend: Rust
- PostgreSQL: control-plane / durable configuration
- ClickHouse: high-volume events and decision history
- Valkey: realtime counters, short-lived state and hot-path data

Prefer a modular monolith. Do not introduce microservices, brokers, ML systems or new infrastructure without a measured reason.

## Product invariants

1. The browser is hostile.
2. Backend-originated application data is authoritative.
3. A fingerprint is evidence, never identity.
4. Krine owns its own client/session identifiers.
5. Identity relationships must remain inspectable and reversible.
6. Missing data is not equivalent to safe data.
7. Metrics are first-class, documented and versioned concepts.
8. Policies depend on normalized metrics/capabilities, not vendor-specific payloads.
9. Every decision must be explainable.
10. Core product operation must not depend on Krine-hosted cloud services.
11. Favor fewer, excellent product surfaces over feature count.
12. UI must remain minimal, quiet and obvious.

## Where to look

- Product intent: `docs/product/vision.md`
- MVP scope: `docs/product/mvp.md`
- UX principles: `docs/product/ux.md`
- Domain vocabulary: `docs/concepts/domain-model.md`
- Identity model: `docs/concepts/identity.md`
- Metrics: `docs/concepts/metrics.md`
- Checks and policies: `docs/concepts/checks-and-policies.md`
- Provider abstraction: `docs/concepts/providers.md`
- Security invariants: `docs/engineering/security.md`
- Failure semantics: `docs/engineering/reliability.md`
- Storage responsibilities: `docs/engineering/storage.md`
- Architecture overview: `ARCHITECTURE.md`
- Accepted MVP defaults: `docs/decisions/0007-mvp-contract-defaults.md`
- Explicitly unresolved questions: `docs/open-questions.md`
- Architectural rationale: `docs/decisions/`

Read only the documents relevant to the task. Do not treat `docs/open-questions.md` as settled design.

Use the accepted MVP defaults and resolve remaining implementation choices with sensible, changeable defaults. Routine SDK, protocol, provider, metric-catalog and retention choices do not require founder approval or block implementation. Document durable decisions as they become concrete.

When a substantial architectural decision is made, add or update an ADR instead of silently changing the system's assumptions.
