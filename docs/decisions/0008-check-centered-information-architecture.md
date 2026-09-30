# ADR 0008: Check-centered information architecture

**Status:** Accepted; landing-page and chart-deferral choices superseded by [ADR 0018](0018-operator-overview-and-investigation.md)

## Context

The MVP needs policy authoring, evidence inspection, metric documentation and provider setup. Mirroring every domain object in navigation would turn a small trust utility into an infrastructure console. [UX principles](../product/ux.md) require checks to be central, metrics to teach and advanced configuration to stay secondary.

## Decision

Use three primary destinations: Checks, Activity and Metrics. Checks is the default route. Settings is a secondary utility destination.

Policies and versions live inside checks. Activity contains separate views for decision attempts and events. Entities are reachable through identifiers and evidence links, including direct lookup. Metrics retain a searchable catalog and versioned reference pages. Providers and SDK setup live in Settings, with contextual links from tasks that need them.

Use an ordered, no-code rule editor with progressive disclosure for boolean groups. Keep missing-data paths explicit. Require a reviewed publication to change enforcement; drafts do not affect the active policy. Restore a prior policy by publishing its definition as a new immutable version. An in-progress logical attempt retains its policy context through retries and verification.

For the MVP editor, new policies default to Otherwise Deny and unresolved conditions default to Deny. Users can explicitly route an unknown condition to verification or the next rule. Verification succeeds into the next rule; failed, expired or unavailable verification denies through an explicit policy branch. Preserve the cause in the explanation. These policy defaults are separate from the accepted local server-SDK fallback default of Allow.

Use canonical detail pages and normal browser navigation. Avoid a separate home dashboard, policy canvas, entity graph, onboarding wizard and permanent inspector panels.

The [information architecture](../product/information-architecture.md) and [core flows](../product/core-flows.md) specify the product behavior. They guide implementation; they do not fix the policy storage format, public API, provider protocol or visual component library.

## Alternatives considered

- **One destination per domain object:** easy to map to backend modules, but spreads routine tasks across too many surfaces.
- **Only Checks and Activity:** reduces one navigation label but makes the first-class metric catalog harder to discover. Metrics earns its own small reference surface.
- **General graph editor:** supports arbitrary flows but adds spatial editing, branching controls and accessibility work to ordinary policies. Ordered rules and disclosed boolean groups cover the MVP.
- **Overview dashboard:** duplicates check and activity information before the user has chosen a task. Checks provides the useful starting point.

## Consequences

- Minimal navigation still requires excellent contextual links, identifier lookup and browser-history behavior.
- Policy execution must preserve rule order, unknown semantics and verification continuation. The editor must explain the behavior it publishes.
- Activity must group retries/continuations by logical attempt and distinguish evaluated outcomes, pending verification, request errors and reported SDK fallback.
- Historical explanations require the evaluated policy, metric versions, values and relevant relationship context; current data cannot substitute for that record.
- Association correction requires an auditable, reversible action within entity detail, without introducing identity merges.
- The design adds no infrastructure or post-MVP replay, rollout, custom-metric or organization-management product.

This ADR refines [ADR 0006](0006-minimal-utility-ui.md) within the contracts of [ADR 0007](0007-mvp-contract-defaults.md).
