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

The exact SDK/protocol shape is not fixed yet.

## Do not destructively merge

A client-to-user relationship can be wrong or later become stale.

Therefore identity association should remain inspectable and correctable rather than physically merging all data into one irreversible record.

## Client-side vs backend-side data

Client-side evidence is naturally keyed by Krine client/session context.

Backend events are naturally keyed by application user/account identity.

Krine's identity layer connects these worlds while retaining provenance.

## Interaction proof direction

For protected browser actions, the current direction is:

- the browser obtains a fresh Krine interaction proof;
- the customer's backend performs the authoritative check;
- the proof must be short-lived and single-use;
- the proof should be bound to the action;
- current direction is also to bind it to the source IP observed by Krine.

Exact expiry, IP mismatch tolerance and wire protocol remain open design questions.

See `../open-questions.md`.
