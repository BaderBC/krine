# ADR 0004: Metrics are first-class product objects

**Status:** Accepted

## Context

Security platforms often expose opaque scores such as `bot_score` without making their meaning, dependencies or evolution clear. Krine policies will depend heavily on these values.

## Decision

Treat every metric as a documented, inspectable, versioned first-class object.

Separate:

- primitive metrics;
- derived metrics.

The MVP exposes a read-only Metrics Catalog.

## Consequences

- policies can use semantic metrics rather than provider payloads;
- derived scores cannot remain unexplained magic numbers;
- metric changes need explicit version/evolution semantics;
- future custom metrics can extend the same model instead of becoming a separate subsystem.
