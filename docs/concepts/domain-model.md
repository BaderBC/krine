# Domain model

This document defines shared vocabulary. It does not define database tables.

## Event

Something observed or reported.

Two broad sources exist:

- client-side evidence / telemetry;
- authoritative backend application events.

Events describe what happened.

MVP events accept arbitrary JSON customer properties within a validated envelope. Submissions are idempotent, and acknowledged events affect applicable metrics in subsequent checks. See [event acknowledgement](../engineering/reliability.md#event-acknowledgement).

## Client

A Krine-managed client identifier representing a browser/client context over time.

A client is not guaranteed to represent one physical person or one physical device.

A fingerprint may provide evidence about a client, but is not the client identity itself.

## Session

A shorter-lived interaction context associated with a client.

## User / account

An application identity known authoritatively by the customer's backend.

Backend-side association may connect a Krine client to a user.

Do not assume that this relationship is permanent or always correct.

## Relationship

An observed or backend-asserted relationship between entities.

Relationships should preserve:

- source;
- time;
- confidence or authority where meaningful.

Relationships should be correctable rather than implemented as destructive identity merges.

## Metric

A named, documented value derived from current or historical evidence.

Metrics describe what Krine currently knows.

Metrics are either:

- primitive;
- derived.

See `metrics.md`.

## Check

An application-defined question such as `can_register`.

Checks decide what may happen next.

## Policy

The versioned no-code logic associated with a check.

It evaluates metrics and other allowed inputs and produces an outcome.

## Provider

A replaceable implementation of an external capability, such as:

- IP intelligence;
- challenge verification;
- email/domain intelligence.

Policies should depend on normalized Krine concepts rather than provider-specific payloads.

## Decision

The explainable result of evaluating a check.

At MVP level the authoritative backend result is primarily:

- allow;
- deny.

A policy may require additional verification before reaching a final decision.

## Core relationship

```text
Events describe what happened.
Metrics describe what we know.
Checks decide what may happen next.
```
