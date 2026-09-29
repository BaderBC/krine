# Open questions

The MVP contracts are implemented. Use the references below for their current behavior; [ADR 0007](decisions/0007-mvp-contract-defaults.md) remains the basis for engineering discretion. Changes must preserve the product invariants and document durable decisions.

## Settled MVP contracts

| Area | Durable reference |
| --- | --- |
| SDK APIs, proofs, events, payload limits and retry windows | [SDK guide](engineering/sdks.md), [HTTP protocol](engineering/protocol.md), [transaction boundaries](decisions/0009-protocol-and-reliability-boundaries.md) |
| Identity provenance, inspection and correction | [Reversible relationship evidence](decisions/0013-reversible-relationship-evidence.md) |
| Metric catalog, policy representation and explicit versions | [Policy contract](engineering/protocol.md#policy-and-metric-schema), [runtime and projection](decisions/0010-axum-runtime-and-durable-projection.md) |
| Provider selection, normalized capabilities, freshness and verification | [Provider configuration](engineering/protocol.md#dashboard-api), [provider attempts](decisions/0011-provider-attempts-and-versioned-history.md) |
| Analytical retention and observed application connection | [History contract](decisions/0014-observed-connection-and-history.md) |

## Deferred product scope

- **Identity expansion:** probabilistic client graphs remain deferred. Email, phone and payment facts remain metadata until a concrete need justifies another entity type.
- **Custom metrics and providers:** user-authored metrics, a custom HTTP-provider format and additional provider categories need a separate scope decision.
- **Multiple projects and hosted tenancy:** organization management, cross-project UI, billing and hosted multi-tenancy remain outside MVP. Use separate production, staging and test deployments.
- **Advanced privacy controls:** collection, retention and privacy tooling beyond the documented controls need concrete operator requirements.
- **Historical replay and shadow rules:** post-MVP capabilities; their execution and comparison semantics remain unresolved.
- **Hosted network intelligence:** a long-term possibility with no chosen sharing model, reputation algorithm or commercial packaging. Core operation must remain self-hosted.
