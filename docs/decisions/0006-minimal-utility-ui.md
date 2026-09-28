# ADR 0006: Minimal utility-style UI

**Status:** Accepted

## Context

Krine will contain sophisticated security and data concepts. Exposing every internal subsystem as enterprise-dashboard navigation would make the product difficult to understand and visually noisy.

## Decision

Optimize the UI for minimalism and progressive disclosure.

Use fewer screens, controls and navigation levels. Prefer clarity and restraint over decorative complexity.

Checks and metrics are primary product concepts.

## Consequences

- new backend capabilities do not automatically become new navigation entries;
- design work should prioritize removing unnecessary UI;
- advanced details remain available through drill-down rather than dominating primary screens;
- visually generic "AI SaaS" patterns should be actively avoided.
