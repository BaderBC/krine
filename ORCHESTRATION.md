# MVP orchestration record

## Authority and purpose

Finish the documented, production-grade self-hosted MVP. `docs/product/vision.md` and `docs/product/ux.md` govern product scope and taste; accepted ADRs govern architecture. New implementation notes do not override them. The lead orchestrator **does not implement production code**.

Founder steering: Castle (`castle.io`) and SEON inspired Krine. Treat them as references subordinate to Krine's vision and self-hosting requirement. Use Axum for Rust HTTP; ADR 0010 records that choice.

## Roles and values

- **Orchestrator:** understands the whole product, defines bounded tasks, owns architecture and integration, resolves disagreements, inspects evidence, commits and pushes accepted units. Values coherence, simplicity, reliability and completion.
- **Implementer:** builds the simplest excellent implementation, with strong verification and durable documentation. Owns correctness, maintainability and security; does not silently redefine scope.
- **Fresh QA/Hater:** independently reviews every implementation unit, including small changes. Assumes it cannot ship until evidence proves otherwise. Reports material defects with reproduction, impact and references. Difficulty never justifies waiving a valid finding.
- **Fresh Founder/Product critic:** reviews QA-green milestones and the final product against vision/UX. Removes needless surfaces and identifies missing end-to-end capability without reducing quality.
- **Specialists:** bring a distinct perspective. Proofs, identity, replay, policy evaluation, provider boundaries and decision concurrency receive additional adversarial security review. UI receives UX/accessibility review.

## Review loop

1. Orchestrator defines scope, ownership, contracts and acceptance evidence.
2. Implementer builds, verifies and hands off the exact diff.
3. Fresh QA independently reviews; implementers never approve their own work.
4. Orchestrator accepts material findings or records a specific evidence-based rejection.
5. Implementer fixes; QA rereviews until findings are resolved. QA or orchestrator normally acts last on the unit.
6. Orchestrator accepts, commits and pushes. Meaningful integration risk receives further QA.

Founder review occurs after the first explained browser-to-backend decision, after the complete configuration/investigation/verification workflow, and before completion. Explicit `code-simplification` review follows major functionality and precedes completion. Simplification preserves capability, security, correctness and test quality.

## Parallel work and Git

Parallelize independent implementation after shared contracts stabilize. Use branches/worktrees from accepted baselines where useful, or assign disjoint ownership in the shared tree. Do not let agents redefine the same foundational contract independently. Preserve user changes and inspect dirty state before staging. Use pnpm for every JavaScript workspace. Commit meaningful accepted units and push regularly to [baderbc/krine](https://github.com/BaderBC/krine); do not rewrite public history unnecessarily.

Freeze implementation units during review. Do not stage other agents' unaccepted work. Durable decisions belong in ADRs; this file tracks orchestration rather than duplicating API truth.

## Completion gate

Completion requires the full documented loop: self-host; install both SDKs; observe client evidence and authoritative events; associate and inspect entities; inspect metrics; configure intelligence and verification; author/publish/restore no-code checks; enforce protected actions; continue verification; investigate and correct relationships; explain outcomes. Retry, replay, missing-data, outage, concurrency and auditability behavior must have evidence.

Before completion: full relevant checks, actual running application, primary end-to-end flows, final fresh QA and Founder review, explicit simplification review, security review, resolution of material findings, accurate durable docs, clean Git, final commit and push. Compilation, scaffolding or a happy path does not satisfy this gate.

## Accepted milestones

| Commit | Accepted unit | Evidence and resolved findings |
| --- | --- | --- |
| `a2d6e68` | Supplied documentation/skills and orchestration baseline | Initial repository was documentation-only; existing user context preserved; GitHub repository created. |
| `bc4823d` | Core evaluator, catalog and protocol | Fresh QA: 14 tests, format and strict Clippy. Security contracts require known-challenge failures to stay closed and old Valkey snapshots to trigger reconstruction. ADR 0009 records immutable operation and retry boundaries. |
| `be26e36` | Persistent storage deployment | Fresh QA and repair/rereview: private storage, authenticated readiness, preserved secrets/data, scoped Valkey ACL, restricted ClickHouse grants, bootstrap identity removal. Root observed all stores healthy. |
| `455f642` | Browser/server TypeScript SDKs | Fresh QA: 29 tests, build/typecheck, three packed packages installed in an isolated consumer. Fixed authenticated context handoff and renewal codes, plus unfinished redirect-stream cleanup. Continuation never applies availability fallback. |
| `46a59fd` | First durable Axum runtime | Fresh ordinary QA plus independent adversarial security. Fixed same-container Valkey restart, bounded reconnects, snapshot-window undercounts, batched reconstruction, oversized analytical lists and cross-kind entity collisions. Actual older-RDB restoration and concurrent ingestion passed; 20,000-event autonomous recovery took 0.758 seconds. Three real-store HTTP tests and strict Rust checks passed. |
| `ef1a8c7` | Saved draft-change contract | Independent 13-case HTTP review: content equality, publication, description-only updates, undo, JSON object/numeric equivalence, rule order, restoration and stale revisions; list/detail/mutations agree. |
| `8e80020` | Dashboard authoring and investigation | Fresh QA, three repair/rereview rounds, 68 tests, typecheck/build and six hostile reproductions. Fixed late-response recovery loss, independent draft/publication ordering, misleading superseded notices, Activity return scope, hidden decisive evidence, terminal loading states, exact timestamps and draft visibility. Live browser authoring/publication/restoration/investigation and narrow-layout evidence. |
| `f94e101` | Complete application image and deployment/CI | Fresh `application_delivery_qa` approved exact 20-file manifest. Independent HTTP/auth/CSRF/CSP/static-route tests, rootless/read-only execution, secret handling, isolation and dependency-audit guards, dependency outages, persistence through restart and graceful shutdown. Provider-combined image and final recovery remain separate gates. |
| `23d1880` | Clean-checkout CI build order | Fresh deployment QA reproduced missing protocol artifacts in a clean archive, then passed build, typecheck and all 97 tests with workspace build preceding typecheck. |
| `9c612d5` | Linux secret-file startup | Fresh `linux_startup_qa` reproduced UID1001/mode0600 access failure and verified startup-only read capability, zero capabilities after gosu, no-new-privileges and read-only mounts/root filesystem. GitHub run `36502963726` passed complete build, real-store tests, image startup/HTTP/restart and dependency audits. |

The first runtime/dashboard are vertical slices, not a reduction of MVP scope. Runtime contracts are in `docs/engineering/{protocol,backend,sdks}.md` and ADRs; consult them rather than inferring from this ledger.

### Root integration evidence

Both built SDKs exercised the actual Axum service: issue/resolve context, publish a velocity policy, Allow at zero events, associate a backend-known user, acknowledge/retry an event, Deny at one event, recover the original Allow, reject cross-operation proof reuse, and inspect pinned relationship/metric evidence. Fixture `orchestrator_1790632948670`; denial `dec_RJMMneU2Feovp63TZzAT1zsBd2v3Qal3htprDKb8xnM`. Root subsequently inspected both historical Allow and Deny in Chrome.

A short debug-build burst ran 64 event→proof→check sequences with eight workers in 1.226 seconds, no fallback, correct post-ack denial and exact count 64. Check p50/p95: 45.82/87.08 ms; event: 86.28/119.66 ms. Sixteen concurrent final retries converged after 17 documented busy responses. This is diagnostic evidence, **not** production throughput acceptance. Harness `/private/tmp/krine-orchestrator-load.mjs`.

## Active implementation and review

### Providers and verification

The provider backend is accepted after three security repairs. Handoff `/private/tmp/krine-provider-handoff.md`, narrow final repair `/private/tmp/krine-provider-snapshot-handoff.md`, exact 18-path freeze `/private/tmp/krine-provider-snapshot-freeze.json`. Fresh ordinary `provider_runtime_qa` approved the broader unit after 58 tests and independent capacity/fencing/cache probes; fresh `provider_snapshot_qa` independently passed all 59 final tests, strict checks, the old-code failure and repaired pinning/missing-revision/unrelated-lock probes. Final specialist `provider_security_review` approved the exact freeze after independently verifying activation, disconnect and enabled-rotation interleavings. Reports: `/private/tmp/krine-provider-{runtime-qa,snapshot-qa,security}-review.md`.

The fresh security review independently passed hostile provider payloads, immutable-field mutations, cross-operation token reuse, lease/fencing recovery, pinned configuration/cache behavior and history migration cases. Two P2 findings were accepted:

1. IP-policy publication could race provider disconnect after dependency inspection. Publication must coordinate every referenced capability, including derived IP metrics, without forbidding policies whose explicit unknown path permits unconfigured IP intelligence.
2. Multi-step continuation could exceed full outbox capacity by appending snapshots. Keep one revisioned delivery slot per attempt, reserve unfinished attempts even after export, retain the complete transition list, and acknowledge only the exact exported revision. Expired pending cleanup must preserve a durable final. Migration 0004 also fences older writers.
3. Provider pinning joined immutable revision data in the same statement that waited for a current-revision row lock. PostgreSQL could return the newly current revision with an older statement snapshot unable to see its enabled row, falsely freezing missing evidence. Read the locked revision and its immutable state coherently; independently reproduce the configuration-change interleaving before acceptance. Probe: `security_provider_pin_waits_for_coherent_revision_state` in `/private/tmp/krine-provider-security-rereview-probes.rs`.

Root also requires provider replacement/disconnect confirmation to bind the exact reviewed dependent check/active-version set, rejecting stale review. Publication coordinates the union of active and proposed capabilities so additions, republishing and removals share that boundary. GET/test expose immutable dependent versions and a token; save requires the reviewed token alongside acknowledgement.

Root accepted candidate-test refinement: a reachable partial proxycheck observation with at least one known normalized field may activate as honestly `configuration_checked`; wholly unusable, malformed or credential-error responses cannot. Per-field unknown causes remain explicit.

Provider direction is fixed-origin proxycheck v3 and Turnstile, with bounded redirect-free calls, pinned revisions/evidence, no stale-success substitution, single-attempt fenced verification and no production test bypass. Turnstile has no safe read-only key-pairing test: configuration checking must not claim live pairing. ADR 0011 and provider code contain the concrete contracts. Research sources: [proxycheck](https://proxycheck.io/api/), [Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [widget configuration](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/).

### Protected application

`application_deployment_implementer` now owns the separate `examples/protected-app/` unit and coordinated pnpm lock changes. Build a useful trial-abuse example with both real SDKs, backend-owned identity/events, a durable original operation and pending verification, and an actual persisted benefit awarded once across retries/concurrency/restarts. Known challenge continuation cannot fall back. Verify actual browser/backend source-IP agreement; never fabricate addresses or trust arbitrary forwarding headers. Operator reviews/publishes the policy; no silent production seeding. Fresh QA and adversarial security review are required after handoff.

### Proof-bound context prerequisite

The protected-app author found an accepted security gap: independently resolved credentials can describe client B while the action proof evaluates client A, allowing pre-check association/event evidence to target the wrong context. Repair is isolated in `/private/tmp/krine-proof-context`, branch `fix/proof-bound-context`, from accepted `23d1880`; provider files in the main tree remain frozen. The existing authenticated resolver gains mutually exclusive modes: ordinary context credentials, or `{interaction: {proof, check, ip}}`. Interaction mode derives client/session IDs directly from the valid issued proof, validates freshness/action/normalized authoritative IP, and returns proof expiry without consuming or authorizing it. Mixed modes are rejected. Credential-only resolution remains for continuous context events. The browser API stays unchanged: a second bearer pair is unnecessary because the proof already binds the context, and requiring live context credentials would introduce rotation races and shorten a still-valid proof’s lifetime. Protected-action examples use interaction resolution before associations/events. Fresh independent QA and adversarial security review precede integration; provider-combined integration gets further verification. The protected application is paused for this prerequisite.

### Provider UI and product refinements

After completing its independent product review, `first_milestone_founder` has a separate implementer assignment for `apps/dashboard/` and dashboard documentation: tested provider candidate/save/disconnect flows, contribution/verification explanations, and the frontend-only accepted refinements below. It will not approve its own changes. Fresh independent QA and a new Founder agent must review this later milestone. Credentials, correction, observed setup and backend list summaries wait for their backend contracts. The example author owns pnpm lock changes; coordinate dependency edits.

Provider UI is frozen in `/private/tmp/krine-provider-ui-sha256.txt` (15 paths), with handoff `/private/tmp/krine-provider-ui-handoff.md`. Author verification: 107 tests including StrictMode provider flows, typecheck/build, and controlled browser keyboard/narrow-layout walks. Fresh QA and real matching-backend write walkthrough remain required.

Fresh `provider_ui_qa` owns that independent review. `proof_context_qa` separately reviews the seven-file proof resolver unit in `/private/tmp/krine-proof-context`; author evidence and hashes are in `/private/tmp/krine-proof-context-{handoff.md,manifest.json}`. The focused resolver wrapper isolates a unique PostgreSQL schema and private Valkey and must never select broader tests. `provider_snapshot_implementer` owns the narrow pinning-race repair and its controlled PostgreSQL regression; ordinary and security rereview follow.

Proof-context ordinary QA approved the seven-file freeze, including independent read-only concurrency, IP normalization, expiry and proof-replay probes. The now-completed provider snapshot QA agent has a distinct dedicated security-review assignment for the proof unit, which it did not author or ordinarily review. Merged provider integration remains a separate gate after that verdict.

UI QA reproduced an accepted P2: a lost provider-save response followed by HTTP 401/403 clears the original pending mutation although authentication precedes idempotency replay and cannot prove the original outcome. Preserve the frozen request through reauthentication. The adjacent draft controller also clears intent on every 4xx; QA is independently checking publication/recovery there. Malformed successful provider responses must not strand the form or silently discard unknown mutation outcomes. Repairs and fresh rereview remain required.

### Deployment integration

Accepted image fixture `krine-app-test` at port 18080 is currently stopped with volumes/image preserved to conserve the shared 2 GiB Docker VM; it contains accepted backend `ef1a8c7`, QA-green dashboard and deployment code. Image `sha256:7b02b1220fcf1d53bc81f4d0a554cefc12ec2929c2dec8ea80fa71e5f009b6bc`. Handoff `/private/tmp/krine-app-deployment-handoff.md`; QA `/private/tmp/krine-deployment-qa/review.md`; exact owned manifest `/private/tmp/krine-app-owned-manifest.json`.

Two CI failures were repaired and independently reviewed: clean-checkout consumers needed protocol build artifacts before typecheck (`23d1880`), and Linux host-owned mode-0600 secrets needed startup-only read capability (`9c612d5`). Earlier failed runs are `36498331039` and `36499323249`; neither was treated as passing evidence.

Fresh `linux_startup_qa` approved the four-file startup repair in `/private/tmp/krine-linux-secret-fix-manifest.json`. It independently reproduced the old access failure and verified the actual entrypoint reads Linux UID1001/mode0600 dummy secrets, then runs as UID/GID10001 with zero effective/permitted/ambient capabilities, no-new-privileges, unreadable secret mounts and a read-only root filesystem. Failure diagnostics do not expose secret values. Report `/private/tmp/krine-linux-secret-fix-qa.md`.

Replacement [CI run 36502963726](https://github.com/BaderBC/krine/actions/runs/36502963726) on `9c612d5` completed successfully: static checks, unit/frontend suites, dependency audits, actual-store recovery, Linux image build, Linux-owned secret regression, full application smoke and restart. Provider-combined image, protected-app ingress, release load/outages and a full separate backup/restore walkthrough remain gates. Restart persistence does not prove disaster recovery. A mode-0600 PostgreSQL snapshot was taken read-only at `/private/tmp/krine-before-provider-upgrade/postgres.dump` before the planned native provider upgrade; it is a local guard, not the final disaster-recovery proof.

### Founder/Product disposition

Fresh first-milestone review kept the restrained check-centered shape and prioritized the useful protected application. No extra metric/provider families, navigation, analytics dashboard or marketplace are needed.

Seven launch improvements are accepted for remaining UI work:

- Compact captured-evidence reasons in bounded Activity lists.
- Leading explanation for Otherwise outcomes, including why protective rules continued. Root confirmed the current gap in the real historical Allow page.
- Entity-applicable metrics rather than irrelevant unknown rows.
- Progressive disclosure of setup reference, with observed state, credentials and providers accessible.
- Meaningful metric units rather than serialization bounds in conditions.
- Published versions rather than draft counters in routine publication review.
- Task-specific read-error recovery text rather than request-identity internals.

Association correction/provenance remain required. This was milestone direction, not launch approval. Fresh review follows the complete configuration/verification/correction milestone and final product.

## Remaining sequence

1. Finish provider security repairs; fresh ordinary QA and security rereview; accept/commit/push.
2. Complete tested provider configuration UI and Founder simplifications against stable contracts.
3. Minimal credentials: create/revoke, secret shown once, metadata-only replay, immediate revocation and no bootstrap resurrection on restart.
4. Inspectable backend/observed relationship provenance and session/source context; reversible reasoned correction/restoration; correct current metrics and immutable historical decisions. Coordinate any narrow SDK association contract addition with fresh review.
5. Observed connection timestamps/links; useful bounded Activity summaries and request errors distinguished from evaluated Deny/fallback; honest retention coverage and configurable analytical retention.
6. Finish protected application and review actual Allow, evidence Deny, Unknown and multi-step verification through one coherent application flow.
7. Accepted combined application image; actual CI; separate backup/restore; measured release-build load and provider/store outage recovery.
8. Explicit simplification review and reviewed fixes; final fresh QA, security and Founder review; all full tests and end-to-end walkthroughs; accurate docs; clean committed/pushed Git.

Routine engineering choices need no founder approval. Ask only for material changes to product behavior, public API, UX, security/trust model, launch scope or positioning that cannot reasonably be resolved from accepted context.

## Runtime and test isolation

Root-owned development API: exec session `16125`, 127.0.0.1:8080, admin Origin `http://127.0.0.1:5174`. Dashboard Vite: session `74940`, port 5174. Unrelated port 5173 is preserved. Current API includes **unaccepted provider code matching migration 0003**, with providers unconfigured. Do not apply migration 0004 while that process runs; coordinate stop/build/start after review.

Shared development stores: Compose project `krine`, PostgreSQL 15432 / Valkey 16379 / ClickHouse 18123; ignored `deploy/secrets/`. Root wrapper `/private/tmp/krine-runtime-env.py` loads secrets without printing them. It is for the running development application, **not destructive tests**. Scoped pnpm 11.28.2 executable `/tmp/krine-pnpm-tool/node_modules/.bin/pnpm`; development Node 24.21 LTS, Rust 1.98.0. SDK consumer requirements are separate. Local Docker DNS workaround uses verified downloaded image digests and `/private/tmp/krine-local-images.yaml`; do not change shared daemon configuration.

**Isolation incident and rule:** a specialist selected broad ignored tests through a provider-only wrapper. Projection tests used the shared stores and applied migration 0003, breaking the older API's history reads. Tests stopped; no rollback/deletion was attempted. Root restarted its API with matching code, preserving data; readiness and existing historical detail now work. This does not approve providers.

Every migration/recovery/destructive fixture must prove isolation for **all three stores**. The accepted `scripts/with-dev-env.py --isolated-stores` verifies a named `krine-test-*`/`krine-ci` project, actual loopback port ownership, no foreign URL/file overrides and no running app. QA independently rejected 15 unsafe configurations and a real extra app-labelled container. Temporary provider wrappers must also isolate all stores for broad selections; never use the older provider-only wrapper until repaired.

Available guarded fixture: `krine-test-deployment`, ports 25432/26379/28123, secrets `deploy/secrets/test-deployment`, no application. Coordinate ownership before tests. Do not reset shared stores or unrelated containers. Separate HTTP cookie jars avoid overwriting root's Chrome admin session: host cookies are shared across ports.

## Dependency audit disposition

pnpm production and full audits reported no advisories at the first dashboard milestone. RustSec cargo-audit 0.22.2 against database `ef03605143a913024f864d2edf476adad5720c93` reported only [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) in SQLx's unused optional MySQL/RSA lockfile chain. `scripts/audit-rust.py` proves neither package is selected in the all-workspace/all-feature/all-target graph before applying that single exception. Fresh QA independently introduced real RSA and SQLx/MySQL dependencies, including aliases, and verified rejection before audit. No active vulnerable dependency is waived; rerun audits at release.
