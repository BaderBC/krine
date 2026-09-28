# Open questions

Use the accepted defaults in [ADR 0007](decisions/0007-mvp-contract-defaults.md). Engineers should resolve the remaining details as implementation needs them, keep defaults easy to change, and document durable decisions. MVP implementation choices do not require founder approval or block implementation. Post-MVP scope remains deferred.

The sections below distinguish implementation choices from deferred product scope.

## Core protocol

Implementation choices:

- exact browser SDK API;
- exact server SDK API;
- exact interaction-proof wire format;
- bounded challenge-continuation lifetime and supported retry window;
- exact consume/check transaction boundaries.

The default proof lasts 60 seconds for initial acceptance, is single-use for one logical action attempt, and is action/IP-bound. Reject IP mismatches initially. A backend check can return `CHALLENGE_REQUIRED`; the browser completes verification and the application retries the same protected action. See `concepts/identity.md`, `concepts/checks-and-policies.md` and `engineering/reliability.md`.

## Event model

Defaults: arbitrary JSON customer properties, idempotent event submission, and acknowledged events visible to applicable metrics in subsequent checks. See `engineering/reliability.md`.

Implementation choices:

- canonical event envelope;
- event IDs and duplicate-detection mechanisms;
- client telemetry batching;
- per-metric treatment of timestamps and late events;
- documented payload limits;
- configurable retention periods and defaults.

## Identity graph

MVP relationships cover clients, backend-known users and observed IPs, alongside Krine session context. Probabilistic client graphs are deferred.

Engineers choose relationship representation while preserving provenance, inspection and correction. Email/phone/payment metadata can remain attached facts until a concrete need justifies another entity type.

## Metrics runtime

Start with a small useful built-in catalog and a few derived scores. Engineers choose and refine that set during implementation.

Implementation choices:

- representation of metric definitions;
- where each class of metric is computed;
- realtime feature materialization strategy;
- implementation of version selection and explicit upgrades within the [metric reference and policy flow](product/core-flows.md#2-create-change-and-restore-a-policy).

Published policies retain their metric semantics. Substantial semantic changes require a new metric version and an explicit policy upgrade.

## Policy representation

Policies follow draft → publish. Published versions are immutable and restorable.

Implementation choices:

- internal AST/graph format;
- whether a CEL-like expression layer exists underneath;
- implementation of the [ordered rule editor](product/information-architecture.md#policy-editor);
- policy execution engine details.

## Challenge provider

The provider model is agreed. MVP includes one default challenge provider and one IP provider.

Engineers select the initial implementations and document the choice. Provider selection does not require founder approval.

## Provider API

Implementation choices:

- normalized capability schemas;
- cache, freshness and timeout defaults and configuration UX.

Add a custom HTTP-provider format only if it fits without substantial extra scope; otherwise defer it.

## Multi-project / multi-tenant product

The data model should not make future project isolation impossible.

However, organization management, cross-project UI, billing and hosted multi-tenancy are not MVP decisions.

Separate prod/staging/test deployments are acceptable initially.

## Privacy tooling

Advanced collection/retention/privacy controls are valuable but not MVP requirements.

Do not invent a complex privacy product before actual needs are clear.

## Historical replay and shadow rules

Architecturally desirable, explicitly post-MVP.

Implementation semantics are unresolved.

## Hosted network intelligence

Long-term possibility only.

No sharing model, reputation algorithm or commercial packaging has been chosen.
