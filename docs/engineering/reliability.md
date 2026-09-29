# Reliability and failure semantics

Krine sits on protected application actions. Failure behavior is therefore part of the product contract.

## Backend-side fallback

For an initial check whose outcome is unknown, the server SDK supports local fallback when Krine is unavailable, including request timeouts. The default is `ALLOW`, with global and per-check overrides.

Example configuration:

```text
default: allow
can_withdraw: deny
can_change_email: deny
```

Every result identifies whether it came from a Krine evaluation or local SDK fallback. Fallback also reports why evaluation was unavailable. An explicit denial, challenge requirement, invalid proof, authentication error or invalid request must not become a fallback allow.

Use the [SDK guide](sdks.md#authoritative-application-integration) for configuration and the [error contract](sdks.md#error-and-retry-contract) for eligible availability failures.

## Idempotent checks and timeout recovery

Persist one immutable request and stable operation key for each logical protected action attempt. Exact retries recover that attempt and its final decision without consuming another proof. Reusing a key with different business inputs is an error. Concurrent duplicates must not start independent evaluations.

`CHALLENGE_REQUIRED` is an intermediate state. Verified challenge completion may advance the same attempt; an ordinary transport retry must not bypass verification. Final decisions remain stable across retries.

After observing a challenge, persist its trusted pending context and use `continueCheck` for every retry, including retries without verification evidence. Continuation never applies availability fallback: a Krine availability failure leaves the application action pending and raises a typed error. Switching back to the initial `check` API would lose this protection. See [pending verification](sdks.md#pending-verification-must-survive-processes).

A timeout can leave the result unknown even when the SDK returns configured fallback. Recover the same saved request rather than starting another attempt. The [HTTP protocol](protocol.md#authoritative-checks) defines the retry window, `retry_until` and bounded challenge lifetime. Recovery of an accepted operation can outlive its proof's initial expiry.

The customer's backend remains responsible for idempotent execution of its business operation, including when fallback allowed it to proceed. Replaying a Krine decision must not execute that operation twice.

## Event acknowledgement

Customer event properties may contain arbitrary JSON within a validated envelope and documented payload limits. Preserve the distinction between authoritative backend events and untrusted client evidence.

Event submission is idempotent: retrying the same event identity and content has one effect; reusing that identity with different content is an error. A successful ingestion acknowledgement means the event's effect is visible to applicable supported metrics in checks started afterward for the affected entities. Return an error if that visibility cannot be guaranteed.

Dashboard and analytical views may update later. The MVP promises no global ordering across independently submitted events; each metric documents its time basis and treatment of late events. [ADR 0009](../decisions/0009-protocol-and-reliability-boundaries.md) and [ADR 0010](../decisions/0010-axum-runtime-and-durable-projection.md) define durable acceptance, idempotent projection and recovery; the [storage guide](storage.md) summarizes ownership.

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
