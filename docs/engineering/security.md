# Security invariants

These are product invariants, not implementation instructions.

## Browser is hostile

Assume an attacker can:

- modify or block client-side JavaScript;
- spoof browser APIs;
- send custom HTTP requests;
- forge untrusted client fields;
- automate a real browser.

Client-side data is evidence, not authority.

## Backend is authoritative for application facts

Application identity, business events and sensitive action inputs originate from the customer's backend whenever possible.

Do not let the browser authoritatively assert:

- `user_id`;
- email ownership;
- account status;
- transaction amount;
- business event outcomes.

## Fingerprint is evidence

A fingerprint is not a user ID and not a guaranteed device ID.

It contributes to trust evaluation.

## Protected browser actions require fresh interaction evidence

Current product direction is to use a short-lived, action-bound interaction proof obtained from the client immediately before a protected action.

The backend then performs the authoritative check.

The proof should be single-use.

Current direction is also to bind it to the source IP observed by Krine.

Exact protocol details remain open.

## Replay must fail

A proof accepted for one protected action must not be reusable to authorize the same or another action again.

The consume/evaluate path must be atomic from a security perspective.

## Missing data is explicit

Unavailable data must remain unknown.

Never silently map:

```text
timeout → safe
blocked client telemetry → safe
missing fingerprint → safe
```

Policies and metrics must be able to reason about unavailable evidence.

## Identity relationships are not infallible

Client↔user and client↔client relationships can be wrong.

Retain provenance and make relationships correctable.

## Decisions must be auditable

For any important decision, Krine should be able to reconstruct:

- which policy version ran;
- which branch was taken;
- which relevant metrics/inputs were present;
- what the result was.

## Self-hosted trust boundary

Core enforcement must not require contacting Krine-operated SaaS infrastructure.
