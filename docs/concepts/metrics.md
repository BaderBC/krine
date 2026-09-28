# Metrics

Metrics are first-class product objects, not hidden implementation details.

## Two categories

### Primitive metrics

Simple observations or deterministic aggregations.

Examples:

- `ip.first_seen`
- `ip.country`
- `client.first_seen`
- `client.user_count_30d`
- `session.request_count_5m`
- `user.age`
- event counts over a window

Primitive does not necessarily mean raw; a straightforward time-window aggregation can still be primitive.

### Derived metrics

Higher-level interpretations based on other evidence or metrics.

Examples:

- `bot_score`
- `ip_risk`
- `multi_account_score`
- `trial_abuse_score`

A derived metric must not be a magical undocumented number.

## Metric metadata

Every metric should expose at least:

- stable name;
- primitive or derived classification;
- output type/range;
- human explanation;
- version;
- dependencies;
- source/provider where relevant;
- missing-data behavior;
- examples.

## Versioning

Derived metric behavior may change over time.

A substantial semantic change must be versioned so that policy behavior cannot silently change underneath customers.

The exact version-selection UX is not decided yet, but silent semantic drift is not acceptable.

## Missing data

`UNKNOWN` is a real state.

Example:

```text
IP provider timeout
≠
ip.risk = 0
```

Derived metrics must define how missing dependencies affect them.

## MVP

The MVP dashboard contains a read-only Metrics Catalog.

Users can inspect metrics and their README-like documentation.

User-authored metrics are intentionally deferred.

## Long-term direction

A future Krine may allow users to create derived metrics through a no-code dependency graph.

That should reuse the same first-class metric model rather than creating a separate "custom formula" subsystem.
