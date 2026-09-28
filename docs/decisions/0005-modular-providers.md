# ADR 0005: Modular provider abstraction

**Status:** Accepted

## Context

Customers may prefer different providers for IP intelligence, challenges and other enrichment. Hard-coding one vendor into policy logic would make Krine less portable and less self-hostable.

## Decision

Represent external capabilities through provider interfaces.

Policies and high-level metrics depend on normalized Krine semantics rather than vendor-specific response fields.

## Consequences

- providers can be swapped with less policy churn;
- Krine needs normalized capability contracts;
- provider failure/provenance must remain visible;
- provider configuration and business policy remain separate concerns.
