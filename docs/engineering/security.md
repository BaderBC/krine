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

Use a short-lived, action-bound interaction proof obtained from the client immediately before a protected action.

The backend then performs the authoritative check.

The proof is single-use for one logical action attempt.

The MVP defaults are a 60-second initial acceptance window and binding to the source IP observed by Krine, with IP mismatches rejected.

Exact protocol details are engineering decisions within [ADR 0007](../decisions/0007-mvp-contract-defaults.md).

## Replay must fail

A proof accepted for one protected action must not be reusable to authorize the same or another action again.

The consume/evaluate path must be atomic from a security perspective.

Recovering a recorded result or continuing a verified challenge for the same logical attempt is permitted. These operations must not grant a second authorization or repeat decision side effects. The customer's backend must also prevent duplicate execution of its protected business action.

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
