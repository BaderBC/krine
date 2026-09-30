# Production readiness

Status: active. Founder steering, 2026-09-30, supersedes the earlier MVP stopping condition.

## What must change

The current implementation passed its tests but does not give an operator enough visibility or confidence. Preserve Krine's plain language, compact navigation and self-hosted trust model. Strengthen visual hierarchy, useful data visualization, investigation depth and operating controls. Empty screens and small synthetic unit fixtures are not evidence of product quality.

The constitutional vision and UX principles remain authoritative. Earlier supporting-document choices to defer charts or forbid an overview are open to revision under the founder's explicit request. A chart earns its place by answering an operator's question and providing a direct path to its evidence. Enterprise does not imply hosted tenancy, billing, invented fraud scores or a compliance certification.

## Work in progress

1. **Product reference research:** inspect Castle's actual public UI, documentation, screenshots and workflows, with SEON as a secondary reference. Separate observed interfaces from marketing and inference. Produce concrete Krine screen and interaction recommendations.
2. **Data and seeding audit:** establish honest analytical facts, revision/deduplication semantics, bounded queries, retention, coverage and migration costs. Design a deterministic, isolated representative-data workflow and a separate live workload generator.
3. **Enterprise gap audit:** assess real investigation tasks, per-person access and auditability, operational telemetry, failure visibility, upgrades, recovery and measured capacity. Distinguish implemented foundations from thin product surfaces and missing capabilities.

The three audits are complete. Implementation now runs in separate analytics, representative-demo and dashboard worktrees. The research supports an Overview → filtered Activity → subject history → captured decision → observed check impact workflow. Public Castle screenshots establish design patterns, not authenticated access to its current product. The [Overview guide](https://docs.castle.io/docs/overview-dashboard) and [Explore guide](https://docs.castle.io/docs/exploring-data) are the main references.

The orchestrator owns shared contracts. Independent implementers execute bounded units in worktrees from a verified baseline; fresh QA reviews every implementation. Sensitive changes receive additional security review. Founder/UX review checks meaningful working milestones using representative data. The complete role and review model remains in `ORCHESTRATION.md`.

## Execution sequence

### 1. Establish a credible investigation dataset and query foundation

Define one consistent time/filter contract for summaries, charts, records and links. Counts must represent logical accepted records, deduplicated across delivery retries and decision revisions. Unknown, pending, unavailable, delayed and missing remain distinct. Expose coverage and analytical lag rather than presenting partial history as fresh or complete.

Build deterministic scenarios with ordinary returning users, new users, multiple sessions and clients, changing traffic, shared-client abuse, suspicious bursts, successful and failed verification, missing provider evidence, policy changes and recovery. Captured reasons, policy versions, metric values, relationships and timestamps must agree. Use realistic distributions and named investigative stories, not independent random rows.

Seed only a dedicated demonstration deployment with explicit ownership and non-production guards. Refuse accidental writes to existing/native deployments. Historical fixtures must be clearly labeled sample data and must not weaken live proof, timestamp or provider validation. A separate rate-controlled workload exercises real SDK/API ingestion and checks; historical imports do not prove capacity.

### 2. Deliver a polished traffic-to-user investigation flow

Start from a clear view of traffic, outcomes, changes and freshness. Every useful trend or breakdown leads to the exact filtered records. An operator can select a spike, identify an affected cohort, inspect a user's sessions and chronological behavior, follow a decision to its captured reason and inspect the evaluated policy version.

User detail must communicate a coherent history, relevant associations, recent changes and evidence limits without requiring raw-JSON archaeology. Preserve exact identifiers, typed entity boundaries, immutable historical context, reversible relationship evidence and ordinary browser navigation. Charts require readable scales, labeled denominators, accessible alternatives, keyboard interaction and useful empty/loading/error/partial states.

Treat the behavioral profile as its own complete workflow after Overview/Activity. Longer paginated tables alone do not satisfy it. Establish one bounded chronological event/decision cursor for an exact typed subject and range; retain direct attribution, show the subject's trend, group useful session/day context and keep relationships accessible beside the history. Preserve the originating investigation interval and offer an explicit way to widen it.

### 3. Strengthen routine policy and operator work

Make check performance and observed policy outcomes easy to inspect and compare across time and versions without claiming causation or replay. Add useful investigation details and efficient filtering where the reference research and real tasks justify them. Preserve reviewed publication, explicit unknown behavior and safe mutation recovery.

Replace the shared-password-only operating model with an explicit plan for individual operators, least-privilege roles, attributable administrative audit, session revocation/offboarding and enterprise sign-in. Define the trust contract before implementation; preserve a controlled bootstrap/recovery path. Provider secrets, application credentials and policy publication need server-enforced permissions, not hidden buttons alone.

The next access-design unit should establish stable operator identity, a small Viewer/Editor/Admin capability matrix, explicit recovery administration and standards-based enterprise sign-in. Use verified issuer and subject for external identity; display names and email are not account keys. Keep authorization current when sessions or mutation results are reused. Existing globally keyed mutation recovery must not disclose another operator's result, and role changes must fence concurrent privileged writes. Record administrative changes with the actor and result in the same durable transaction; legacy activity remains explicitly unattributed. This is an operator-access boundary, not a new customer IAM product. OIDC details require dedicated implementation and adversarial review against [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) and [OAuth security best practice](https://www.rfc-editor.org/rfc/rfc9700.html).

### 4. Prove operation at an explicit scale

Add actionable service/export/provider telemetry and operating guidance. Measure ingestion/check latency, resource bounds, query latency and export delay using an owned sustained workload while an operator investigates the dashboard. Test overload, outage, recovery, upgrades and backup restoration. Set and report an explicit supported workload and hardware profile from evidence; do not infer capacity from a brief burst or a populated chart.

User-specific deployment, scale, retention, SSO and compliance requirements have been requested asynchronously. Until clarified, work targets one self-hosted company with multiple operators. This is a working assumption, not an invented compliance commitment.

## Acceptance

- The running product looks deliberate and supports the complete investigation story with representative, substantial data.
- A technical operator can explain a traffic change and a particular user's behavior without reading implementation details or piecing together disconnected raw records.
- Charts, summaries, lists, pagination and detail pages reconcile under filters, revisions, retention, empty periods and outages.
- Seeding is repeatable, inspectable, safely isolated and documented; live-load evidence is separate and reproducible.
- Multi-operator security and audit trails are enforced and adversarially reviewed.
- Production visibility, failure response, capacity and recovery have measured evidence and honest limits.
- Every implementation unit passes independent QA. Final Founder/UX, security, simplification and whole-product review inspect the actual running system.
- Durable product/architecture docs match the new scope; all material findings are resolved; Git is clean and the final state is pushed.

Passing the old MVP checklist or a large test count alone does not satisfy this acceptance bar.
