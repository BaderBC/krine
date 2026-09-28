# Reliability and failure semantics

Krine sits on protected application actions. Failure behavior is therefore part of the product contract.

## Backend-side fallback

The server SDK should support local fallback behavior when Krine itself is unavailable.

Conceptually:

```text
default: allow
can_withdraw: deny
can_change_email: deny
```

A global/default policy such as "allow all unless overridden" should be possible.

Exact SDK syntax remains an implementation decision.

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
