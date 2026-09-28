# MVP orchestration record

## Authority and purpose

Build the documented, production-grade self-hosted MVP. The product vision and UX principles govern scope and taste; accepted ADRs govern architecture. New implementation notes do not override them. The lead orchestrator does not implement production code.

Founder steering (2026-09-28): Castle (`castle.io`) and SEON inspired the platform. Use them as product reference points, subordinate to Krine's documented vision and self-hosting requirements. The Rust HTTP framework must be Axum, as explicitly requested. The backend implementation records that choice in its architecture decision.

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
| 0. Durable baseline | Preserve supplied documentation/skills, establish repository and orchestration record | Complete: a2d6e68 pushed |
| 1. Shared foundation | Concrete protocol, bounded typed policy evaluator, three-valued logic, versioned metric catalog, transaction/recovery ADR; independent QA and security review | Accepted after fresh QA; committing |
| 2. First deployed decision | Rust HTTP service using real PostgreSQL/Valkey/ClickHouse, both SDKs, evidence/event/association/metric/check flow, immutable trace; outside-in replay/concurrency/restart checks | Pending foundation |
| 3. Authoring and investigation | Restrained React dashboard, reviewed atomic publication/restoration, historical decisions/events/entities/metrics, credentials and integration instructions | Pending stable contracts |
| 4. Providers and verification | Real intelligence and challenge adapters, tested/masked configuration, bounded failures, same-attempt multi-step verification | Pending foundation |
| 5. Correction and operations | Auditable reversible associations, retention, health/diagnostics, secure deployment, usable runnable integration example | Pending |
| 6. Release gate | Full tests and running product walkthrough, security/final QA, Founder review, simplification, durable docs, clean pushed Git | Pending |

Parallel ownership follows shared contracts. The reviewed browser/server protocol subset now permits SDK implementation while the pure evaluator and admin contracts are finalized. SDKs own root pnpm configuration and `packages/`; deployment owns compose/deploy/scripts; the foundation owns Cargo/core/protocol/ADR 0009. Dashboard and backend wait for their shared contracts. Unit sizes may split at coherent review boundaries; none bypass QA.

## Acceptance and evidence ledger

Track concrete commands, runtime walkthroughs, review findings and their disposition here as units complete. The baseline contains no application, so no application test is currently claimed green. Docker daemon access is verified. GitHub repository [baderbc/krine](https://github.com/BaderBC/krine) was created and the starting context pushed. Direct sandbox network calls can misreport authentication; approved network access succeeds.

The highest-risk foundation is the combination of event acknowledgement visibility, replay versus retry recovery, pinned challenge context, and trusted IP/proxy handling. These receive dedicated adversarial review before dependent product work is accepted.

### Foundation review decisions

- Security finding accepted: a known verification requirement must survive continuation transport failure. Initial unknown checks retain the documented availability default; continuation after a known challenge cannot fall back to Allow. SDK/application state must preserve that distinction across retries and processes.
- Security finding accepted: a stale Valkey AOF/RDB can retain a readiness marker but lose acknowledged counters. Detect process incarnation/rollback against durable projection state; gate reads during reconstruction. Runtime verification must restore an older snapshot and race ingestion with reconstruction.
- Product contract corrections required: retain minimal create/revoke credentials, candidate provider testing before activation, publication checks against both reviewed draft and active versions, explicit reviewed restoration without silent draft replacement, and event detail inspection.
- Deployment work uses disjoint files. A local Docker DNS failure is being worked around through verified image download/load without changing shared Colima configuration.
- Initial security contract review is complete, with the two accepted corrections above. It is not runtime approval. Later security review must cover races, crashes, proof/challenge reuse, trusted proxy handling, auth substitution, CSRF, decoder bounds and hostile provider responses.

### Accepted foundation evidence

Fresh QA `foundation_qa` found no material findings in Cargo/core/LICENSE/protocol/ADR 0009. It independently passed `cargo fmt --all --check`, `cargo test --workspace --all-features --locked --offline` (14 tests), and strict workspace/all-target Clippy. Root also ran the evaluator tests independently and inspected the protocol/evaluator. The two security findings are resolved in the contract; backend runtime enforcement remains required work. ISC follows the supplied package manifest's existing license declaration.

Deployment foundation is under separate fresh QA (`deployment_qa`); root independently observed all three services healthy. SDK implementation remains active and unaccepted.
