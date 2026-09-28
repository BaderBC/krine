# Open questions

These topics are deliberately unresolved. Future work should decide them with implementation context rather than treating the current chat history as a hidden specification.

## Core protocol

Not yet fixed:

- exact browser SDK API;
- exact server SDK API;
- exact interaction-proof wire format;
- proof lifetime;
- how strongly IP mismatch should invalidate a proof;
- whether limited tolerance is needed for mobile/network changes;
- exact order of challenge vs policy evaluation;
- exact consume/check transaction boundaries.

Direction is documented in `concepts/identity.md` and `engineering/security.md`, but not the protocol.

## Event model

Not yet fixed:

- canonical event envelope;
- event IDs / idempotency semantics;
- client telemetry batching;
- event ordering guarantees;
- how arbitrary customer event properties are represented;
- retention defaults.

## Identity graph

Not yet fixed:

- precise confidence model;
- whether and how probabilistic client↔client relationships are stored;
- first set of relationship types;
- whether email/phone/payment method become full entities in MVP.

## Metrics runtime

Not yet fixed:

- representation of metric definitions;
- where each class of metric is computed;
- realtime feature materialization strategy;
- version pinning/upgrade UX;
- exact first built-in metrics.

## Policy representation

Not yet fixed:

- internal AST/graph format;
- whether a CEL-like expression layer exists underneath;
- editor implementation;
- policy execution engine details.

## Challenge provider

The provider model is agreed.

The initial default provider is not locked.

## Provider API

Not yet fixed:

- normalized capability schemas;
- custom HTTP-provider format;
- cache and timeout configuration UX.

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
