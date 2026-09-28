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
| 1. Shared foundation | Concrete protocol, bounded typed policy evaluator, three-valued logic, versioned metric catalog, transaction/recovery ADR; independent QA and security review | Accepted and pushed: bc4823d |
| 2. First deployed decision | Axum HTTP service using real PostgreSQL/Valkey/ClickHouse, both SDKs, evidence/event/association/metric/check flow, immutable trace; outside-in replay/concurrency/restart checks | SDK and first backend slice accepted; real-browser dashboard gate pending |
| 3. Authoring and investigation | Restrained React dashboard, reviewed atomic publication/restoration, historical decisions/events/entities/metrics, credentials and integration instructions | First dashboard unit active against shared protocol |
| 4. Providers and verification | Real intelligence and challenge adapters, tested/masked configuration, bounded failures, same-attempt multi-step verification | Pending foundation |
| 5. Correction and operations | Auditable reversible associations, retention, health/diagnostics, secure deployment, usable runnable integration example | Pending |
| 6. Release gate | Full tests and running product walkthrough, security/final QA, Founder review, simplification, durable docs, clean pushed Git | Pending |

Parallel ownership follows shared contracts. SDK packages and deployment storage are accepted. Backend owns its crate, migrations, Cargo changes and narrow runtime contract amendments; dashboard owns `apps/dashboard` and coordinated pnpm lock changes. Unit sizes may split at coherent review boundaries; none bypass QA.

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

Deployment foundation is accepted after fresh QA and a fix/rereview cycle. Root independently observed all three services healthy. QA verified private production networking, dev loopback binds, authentication, secret generation/permissions/preservation/rejection, startup failure and environment consistency. Implementer verified persistence across container replacement. The accepted least-privilege fixes passed actual allowed/denied commands, including Lua namespace isolation, restricted ClickHouse grants and removal of the temporary bootstrap identity. QA inspected upstream startup ordering and authenticated readiness.

### Active implementation and findings

- `backend_vertical_implementer`: owns `crates/krine-server`, Cargo additions, migrations, backend tests, ADR 0010 and backend runtime documentation. Implements the first real secure decision slice against the running stores using Axum.
- Accepted SDKs serialize trusted pending context; continuation throws on unavailability and never returns fallback Allow.
- Deployment QA findings resolved: Valkey now uses named `krine` authentication, a command allowlist and `krine:*` key restrictions; ClickHouse has required table operations only in the precreated `krine` database. Administrative and external-source grants are denied. Existing volumes and secrets were preserved.
- SDK verification uses pnpm 11.28.2. Root corrected the initial manager choice after checking upstream support: pnpm 9 is unsupported. Verified scoped executable: `/tmp/krine-pnpm-tool/node_modules/.bin/pnpm`; prepend its directory to PATH. Global user tooling remains unchanged. Current Node requirement for development is >=22.13.
- Root's early backend review requested integer-preserving strict JSON decoding and a decoder nesting limit compatible with valid depth-8 policies, while keeping the separate customer properties depth limit. Regression tests are required before handoff.
- SDK QA findings accepted: the documented `trustedKrineContext` had no authenticated source, and browser proof context-expiry errors disagreed with SDK renewal logic. Add server-authenticated `POST /v1/contexts/resolve` taking issued client/session credentials and returning verified IDs/expiry; SDK exposes `resolveContext`. It validates existing matching context without issuing context or consuming a proof. Browser callers never assert trusted IDs. Backend uses dedicated `invalid_context`/`context_expired` errors so the SDK can renew once while preserving genuine authentication failures. Backend owns this narrow protocol amendment; SDK fixes follow QA handoff.
- SDK QA also reproduced a live unfinished 307 response stream surviving five request deadlines after redirect refusal. Accepted fix: close terminal transport resources and add a streaming-response regression.
- SDK fixes are accepted after independent rereview: explicit browser `getContextCredentials`, server `resolveContext`, documented authenticated handoff, exact context recovery codes and terminal transport abort. QA independently passed 29 tests, build/typecheck and three package packs under pnpm 11.28.2, then installed those tarballs in an isolated consumer and verified types and runtime handoff. The streaming redirect closes promptly with no target request. Real Axum/browser end-to-end testing remains required.
- `dashboard_implementer` owns `apps/dashboard` and dashboard runtime notes. Uses frontend-design/web-design-guidelines for first real authoring/investigation UI against the shared admin contract. Root pnpm/lock changes require coordination; no mock production data or fake settings controls. Runtime backend integration, independent QA and UX review remain required.
- Deployment milestone is pushed as `be26e36`. Current development services use named user `krine`, ports PostgreSQL 15432 / Valkey 16379 / ClickHouse HTTP 18123. Secret files remain ignored in `deploy/secrets/`; local image workaround is `/private/tmp/krine-local-images.yaml`.
- SDK milestone is pushed as `455f642`. Dashboard may now update the workspace lock for its dependencies.
- `runtime_security_review` independently attacks the first runtime while its author finishes tests; final approval waits for the exact handoff. Ordinary fresh backend QA is still required in addition to this specialist review.
- Security independently passed actual older-RDB restoration in an isolated Valkey container and PostgreSQL schema: a retained generation marker concealed one missing acknowledged event, but incarnation/watermark recovery plus concurrent ingestion produced the correct count of three. Temporary fixture resources were removed.
- Runtime findings accepted: (1) Valkey's fixed configuration file in sticky `/tmp` prevented same-container restart after ownership changed; backend author owns the narrow entrypoint fix and repeated restart/persistence verification. (2) Redis reconnect waits could hold the projection lock beyond the nominal response timeout; bound reconnect and complete worker operations. (3) A check timestamp taken before a projection-lock wait could predate later wall-clock pruning, producing a known undercount at the five-minute boundary. Require coherent snapshot timing and an independent reproduction/rereview. None is waived as an MVP limitation.
- Recovery volume is now a measured requirement: an isolated 10,000-event rebuild took 13.4 seconds and exceeded the five-second worker budget. That volume fits the default admitted request rate. Batch projection round trips while preserving generation fencing and durable acknowledgement; require autonomous recovery under representative retained volume. Raising request timeouts alone is not an acceptable fix.
- Independent rereview of the batched projection passed autonomous 20,000-event recovery in 0.758 seconds without a readiness request performing the rebuild. The original window-boundary reproduction now records a coherent later snapshot; older-RDB recovery passed again. Security approval still waits for the exact final runtime handoff.
- Root exercised the built browser and server SDKs against the actual Axum service: issued/resolved context, published a velocity policy, received evaluated Allow at zero events, associated a backend-known user, ingested and retried one event, received evaluated Deny at one event, recovered the original Allow, rejected cross-operation proof reuse and inspected the pinned metric/relationship trace. Check `orchestrator_1790632948670`, decision `dec_RJMMneU2Feovp63TZzAT1zsBd2v3Qal3htprDKb8xnM`. This is live HTTP integration evidence, not yet the final real-browser/application walkthrough.
- Scoped runtime security review is accepted on the frozen first backend handoff. Ordinary fresh `backend_qa` passed formatting, strict Clippy, workspace tests and real-store HTTP tests, then found two accepted defects: decision lists retrieved complete traces before summarizing and exceeded the bounded response at valid policy sizes; entity history discarded entity kind and mixed colliding user/client IDs. Both require implementation fixes and independent rereview before commit.
- First backend scope now includes durable browser observation outbox records, observed IP relationships and read-only entity inspection. Provider execution/configuration, credentials, correction mutations, richer setup/request history and release-load acceptance remain follow-up work.
- First backend unit accepted after security review and ordinary QA fix/rereview. Original independent large-trace reproduction now succeeds at page limits 1/20/30/50/100 while preserving complete 320,263-byte details. Colliding user/client IDs remain isolated. All three real-store HTTP tests, workspace tests, formatting, strict Clippy, build and whitespace checks pass. The Valkey entrypoint restart fix is included in this acceptance.
- `dashboard_qa` is independently reviewing the frozen first dashboard unit. Its author passed build/typecheck and 18 tests, plus live create/publish/restore/investigation and 390-pixel keyboard/long-ID checks. Live integration found and fixed JSONB key-order equality, typed select normalization and stale-restoration recovery before handoff. Root observed the real recorded denial and its pinned values in the browser; final dashboard acceptance remains pending.
- Root now owns development processes so they survive author handoffs: API exec session `63008` on 127.0.0.1:8080 with admin Origin `http://127.0.0.1:5174`; Vite exec session `74940` on 127.0.0.1:5174. Port 5173 belongs to an unrelated process and was preserved.

### Remaining product gates

The first backend/dashboard units are vertical slices, not a scope reduction. Required follow-up units include real IP intelligence and persisted verification continuations; tested provider configuration; minimal credential creation/revocation; durable browser evidence and observed relationships; auditable association correction/restoration; connection observations and useful activity/error/retention states; the working protected-application SDK example; full application deployment, quickstart, CI and operational recovery. Provider, security, outage, concurrency and stale-snapshot tests must exercise actual running boundaries. Every follow-up implementation receives fresh QA.

### Provider implementation direction

Read-only primary-source research selected fixed-origin proxycheck v3 (`ver=24-June-2026`, `tag=0`) and Turnstile. A live public-IP lookup verified the proxycheck wire fields `detections.risk`, `detections.proxy` and `location.country_code`; the downloadable beta OpenAPI disagrees and must not drive parsing. Normalize risk by 100, map proxy specifically, and preserve null/invalid data as unknown. Start with a one-second lookup budget and a 60-second revision/IP cache without stale-success substitution. Freeze observation time and provider revision in decisions. Credentials appear in the provider query string, so never log the request URL. Sources: [proxycheck API](https://proxycheck.io/api/) and [official example](https://proxycheck.io/).

Turnstile requires a pinned secret/revision, accepted IP, expected hostname from the proof's validated Origin, fixed `krine_verify` action, random per-step cdata and persisted UUID idempotency key. Validate timestamp and all binding fields. Persist token digest, lease and fencing before external verification; commit advancement only for the current fence. Retry identical evidence with the same UUID; ambiguous unrecoverable success fails closed. All challenge steps share the original five-minute deadline. Calls run outside database locks. Sources: [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) and [widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/).

Candidate testing binds the exact candidate digest/current revision to a short-lived activation token. Proxycheck can perform a bounded fixed-public-IP lookup. Turnstile has no documented safe read-only secret/site-key pairing test: use an honest `configuration_checked` result stating that live verification has not been tested and must be verified through the application. This uses the core-flow allowance for limited tests, avoids forcing the dashboard hostname into a customer's widget, and never claims pairing success. Public dummy keys do not prove production binding; do not add validation bypasses for them. Subsequent real application verification must be inspectable.
