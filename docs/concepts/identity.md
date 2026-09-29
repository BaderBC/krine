# Identity model

Identity is intentionally separated from fingerprinting.

## Krine client identity

Krine creates and maintains its own client identifier.

A fingerprint must not be used directly as the primary identity key.

Reasons include:

- fingerprints can change;
- fingerprints can collide;
- fingerprint inputs can be spoofed;
- multiple people can share an environment;
- the same user can legitimately use multiple clients.

## Fingerprints

Fingerprints are evidence.

They may help estimate that two client observations are related, but they do not prove physical-device or human identity.

## Backend-known users

The customer's backend is authoritative for application identity.

After authentication or another trusted backend event, the backend may associate:

```text
client_x → user_123
```

and enrich the user with backend-known metadata such as email or phone where product requirements justify it.

The [SDK guide](../engineering/sdks.md#events-and-identity) defines context resolution and authoritative association requests.

## MVP relationship scope

Start with clients, backend-known users and observed IPs (`client ↔ user ↔ IP`). Keep Krine session context alongside these relationships. Sharing an IP does not establish that two clients or users are the same identity.

Probabilistic client-to-client graphs are deferred. Email, phone and similar backend-known facts can remain metadata until a concrete product need justifies another entity type.

## Do not destructively merge

A client-to-user relationship can be wrong or later become stale.

Therefore identity association should remain inspectable and correctable rather than physically merging all data into one irreversible record.

## Client-side vs backend-side data

Client-side evidence is naturally keyed by Krine client/session context.

Backend events are naturally keyed by application user/account identity.

Krine's identity layer connects these worlds while retaining provenance.

## Interaction proof defaults

For protected browser actions:

- the browser obtains a fresh Krine interaction proof;
- the customer's backend performs the authoritative check;
- the proof expires after 60 seconds by default for initial acceptance;
- the proof is single-use for one logical action attempt;
- the proof is bound to the action and source IP observed by Krine;
- an IP mismatch is rejected in MVP.

Retries may recover the same attempt, and verified challenge completion may continue it. A consumed proof cannot start another attempt. Proof expiry does not erase an already-recorded result within the supported retry window.

The [HTTP protocol](../engineering/protocol.md) defines the wire format, bounded challenge lifetime and retry window. These contracts implement [ADR 0007](../decisions/0007-mvp-contract-defaults.md) and the [reliability guarantees](../engineering/reliability.md); changes must preserve explicit recovery semantics.
