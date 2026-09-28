# Reliability and failure semantics

Krine sits on protected application actions. Failure behavior is therefore part of the product contract.

## Backend-side fallback

The server SDK supports local fallback behavior when Krine itself is unavailable, including when a request times out. The default fallback is `allow`, with a configurable global default and per-check overrides.

Example configuration:

```text
default: allow
can_withdraw: deny
can_change_email: deny
```

Every result identifies whether it came from a Krine evaluation or local SDK fallback. Fallback also reports why evaluation was unavailable. An explicit denial, challenge requirement, invalid proof, authentication error or invalid request must not become a fallback allow.

Exact SDK syntax remains an implementation decision.

## Idempotent checks and timeout recovery

Use a stable operation key for one logical protected action attempt. Retries with the same key and business inputs recover that attempt and its final decision without repeating effects. Reusing a key with different business inputs is an error. Concurrent duplicates must not start independent evaluations.

`CHALLENGE_REQUIRED` is an intermediate state. Verified challenge completion may advance the same attempt; an ordinary transport retry must not bypass verification. Final decisions remain stable across retries.

A timeout means the result may be unknown, even if the SDK returns a configured fallback. Retry the same operation rather than starting another attempt. Keep recovery available for a documented retry window that outlives initial proof expiry. Challenge continuation also has a bounded lifetime chosen and documented during implementation.

The customer's backend remains responsible for idempotent execution of its business operation, including when fallback allowed it to proceed. Replaying a Krine decision must not execute that operation twice.

## Event acknowledgement

Customer event properties may contain arbitrary JSON within a validated envelope and documented payload limits. Preserve the distinction between authoritative backend events and untrusted client evidence.

Event submission is idempotent: retrying the same event identity and content has one effect; reusing that identity with different content is an error. A successful ingestion acknowledgement means the event's effect is visible to applicable supported metrics in checks started afterward for the affected entities. Return an error if that visibility cannot be guaranteed.

Dashboard and analytical views may update later. The MVP promises no global ordering across independently submitted events; each metric documents its time basis and treatment of late events. Choose batching and storage mechanisms during implementation without weakening the acknowledgement guarantee.

## Why fallback is local

If Krine is unavailable, the application cannot ask Krine how to handle Krine being unavailable.

Therefore the server SDK must have enough local configuration to choose the configured fail-open/fail-closed result.

The frontend may improve UX during outages but may never manufacture an authoritative allow result.

## Provider failures

External provider failure is distinct from negative reputation.

Examples:

```text
ip.risk = UNKNOWN
provider_status = TIMEOUT
```

not:

```text
ip.risk = 0
```

## Hot path

The decision path must be designed for low and predictable latency.

Avoid arbitrary analytical queries over large event history during every check.

Historical information needed by policies should be materialized into realtime metrics/features where appropriate.

## Concurrency

The implementation must assume concurrent checks and retries.

One-time proof consumption, counters, quotas and similar security-sensitive state need atomic semantics.

## Deployment philosophy

Deployment UX matters, but runtime quality matters more than minimizing dependency count.

A dependency is acceptable when it materially improves correctness, latency, throughput or operational simplicity.

Do not add infrastructure only because it is fashionable or theoretically scalable.
