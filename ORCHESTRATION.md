# MVP orchestration record

## Authority and purpose

Build the documented, production-grade self-hosted MVP. The product vision and UX principles govern scope and taste; accepted ADRs govern architecture. New implementation notes do not override them. The lead orchestrator does not implement production code.

## Roles and values

- **Orchestrator:** understands the whole product, sets bounded tasks, resolves disagreements, inspects evidence, integrates work, and commits and pushes accepted units. Values coherence, simplicity, reliability, and finishing the actual product.
- **Implementer:** builds the simplest excellent implementation, including meaningful verification and durable documentation. Owns correctness, maintainability, security, and consistency; does not silently redefine product scope.
- **Fresh QA/Hater:** independently reviews every implementation unit and its fixes. Assumes it cannot ship until evidence proves otherwise. Reports material defects with reproduction, impact, and file references. Does not trade quality for convenience.
- **Fresh Founder/Product critic:** reviews QA-green product milestones and the final product against vision and UX. Removes needless surfaces and identifies missing end-to-end capability without lowering quality.
- **Specialists:** used for a distinct need. Proofs, identity, replay, policy evaluation, provider boundaries, and decision concurrency receive adversarial security review in addition to QA. UI receives UX/accessibility review.

## Review loop

1. Orchestrator defines scope, ownership, relevant contracts, and acceptance evidence.
2. Implementer builds and runs relevant checks, then hands off the exact diff and evidence.
3. A fresh QA agent reviews independently; the implementer never approves its own work.
4. Orchestrator accepts material findings or records a specific evidence-based rejection. Difficulty is never a reason to reject a valid finding.
5. Implementer fixes accepted findings; QA reviews the fixes again. QA or the orchestrator is normally the last actor on the unit.
6. Orchestrator accepts, commits, and pushes a coherent unit after verification. Integration receives further QA when it introduces meaningful risk.

Product review occurs after the first explained browser-to-backend decision, after the complete configuration/investigation/verification workflow, and before completion. Explicit simplification review follows major functionality and precedes completion.

## Parallel work and Git

Parallelize independent implementation only after shared contracts are stable. Start branches/worktrees from an accepted baseline where useful; otherwise assign disjoint file ownership in the shared workspace. Never allow competing definitions of foundational contracts. Inspect the initial dirty tree and preserve existing work. Use pnpm for every JavaScript/TypeScript workspace. The orchestrator owns integration and regular meaningful commits/pushes to `baderbc/krine`; no unnecessary history rewriting.

## Completion gate

Completion requires the documented loop: self-host, install both SDKs, accumulate evidence and authoritative events, inspect identity/metrics, configure external intelligence and verification, author/publish no-code checks, enforce authoritative checks, complete verification, and explain outcomes. Retries, replay, missing data, outages, concurrent requests, validation, and auditability must have evidence.

Before completion: run full relevant checks, run the actual application, exercise primary end-to-end flows, obtain final fresh QA and Founder review, complete simplification review, resolve every material finding, reconcile durable docs, ensure clean Git, and commit/push final state. Compilation or a happy-path demo is insufficient.

## Current state

- Initial inspection: documentation-only repository on `master`, one initial commit, no configured remote. Existing uncommitted docs and installed skills are user-provided context and must be preserved.
- Product and architectural reading completed; the initial read-only scope audit found no material contradiction. ADRs 0007–0008 refine the core vision consistently.

## Execution sequence

| Unit | Outcome and acceptance | State |
| --- | --- | --- |
| 0. Durable baseline | Preserve supplied documentation/skills, establish repository and orchestration record | In progress |
| 1. Shared foundation | Concrete protocol, bounded typed policy evaluator, three-valued logic, versioned metric catalog, transaction/recovery ADR; independent QA and security review | Implementer active |
| 2. First deployed decision | Rust HTTP service using real PostgreSQL/Valkey/ClickHouse, both SDKs, evidence/event/association/metric/check flow, immutable trace; outside-in replay/concurrency/restart checks | Pending foundation |
| 3. Authoring and investigation | Restrained React dashboard, reviewed atomic publication/restoration, historical decisions/events/entities/metrics, credentials and integration instructions | Pending stable contracts |
| 4. Providers and verification | Real intelligence and challenge adapters, tested/masked configuration, bounded failures, same-attempt multi-step verification | Pending foundation |
| 5. Correction and operations | Auditable reversible associations, retention, health/diagnostics, secure deployment, usable runnable integration example | Pending |
| 6. Release gate | Full tests and running product walkthrough, security/final QA, Founder review, simplification, durable docs, clean pushed Git | Pending |

Parallel ownership follows shared contracts: Rust backend, TypeScript SDKs/example, and dashboard can proceed independently once unit 1 is accepted. Deployment/tooling may proceed independently now. Unit sizes may split at coherent review boundaries; none bypass QA.

## Acceptance and evidence ledger

Track concrete commands, runtime walkthroughs, review findings and their disposition here as units complete. The baseline contains no application, so no application test is currently claimed green. Docker daemon access is verified. GitHub authentication works with network access; `baderbc/krine` does not yet exist.

The highest-risk foundation is the combination of event acknowledgement visibility, replay versus retry recovery, pinned challenge context, and trusted IP/proxy handling. These receive dedicated adversarial review before dependent product work is accepted.
