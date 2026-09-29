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
| `c4dc990` | Intelligence providers and durable verification | Ordinary QA plus dedicated security review resolved publication/dependency races, continuation capacity amplification and incoherent provider pinning. Final 59-test suite, differential PostgreSQL interleavings, replay/fencing and delayed history delivery passed. Native generation-3 upgrade preserves existing historical decisions. |
| `808ce5c` | Proof-bound context resolution | Ordinary QA, dedicated security review and fresh combined integration QA approved the unchanged seven-file patch. Independent read/consume races, renewal/expiry, authentication and SDK failure probes passed. Combined 60 Rust and 98 JavaScript tests passed; provider hostname and migration behavior remain intact. |
| `3a847ae` | Provider settings and mutation recovery | Fresh UI QA resolved three save-recovery findings, passed 154 tests and eight original failure probes, exercised malformed-response/reauthentication recovery in the browser, and independently verified real API configuration, two-tab conflicts and version-bound disconnect. |
| `868fa74` | Native browser fetch | Fresh QA independently reproduced the old Chrome receiver failure, verified default/injected fetch, exact retries and bounded timeout, and passed all 31 SDK tests. |
| `af85ea9` | Durable application credentials | Ordinary QA, adversarial security and fresh proof/credential integration QA approved. All 64 combined Rust tests and real HTTP/SDK rotation, revocation, replay and no-fallback probes passed. |
| `ea67a7e` | Browser context through key rotation | Fresh QA and dedicated identity security approved 19 tests plus 16 independent probes. Root's actual Chrome key A → revoke A → key B flow retained the same client/session and accumulated user context. |
| `26470d8` | Durable protected trial example | Fresh QA, accessibility repair/rereview and dedicated security approved 19 tests plus independent HTTP/process probes. Lost acknowledgements, crashes, concurrent recovery, framing/forwarding attacks and private-state checks passed. |
| `d60f6a0` | Inspectable, reversible relationship evidence | Fresh QA and dedicated security approved 69 full Rust tests, 21 SDK tests and independent correction/cleanup/locking/provenance probes. Exact counts remain separate from bounded historical samples; the accepted patch rebased unchanged. |

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

Accepted as `26470d8`. Both real SDKs, backend-owned identity/events, durable original operations and pending verification protect an actual persisted trial benefit across retries/concurrency/restarts. Known challenge continuation cannot fall back. Operator reviews/publishes the policy; no silent production seeding. The exact 18-file freeze is `/private/tmp/krine-protected-app-manifest.sha256`; handoff `/private/tmp/krine-protected-app-handoff.md`. Fresh QA found and then verified repair of lost focus and missing outcome announcements. Final ordinary and dedicated security reports are `/private/tmp/krine-protected-app-qa-final.md` and `/private/tmp/krine-protected-app-security.md`. Both approve the exact freeze; 19 tests and six independent adversarial security probes passed. Shared Docker ingress and combined provider walkthrough remain separate gates. The author now owns that ingress unit in an isolated worktree: authentic source-IP agreement, sanitized forwarding, narrow proxy trust, isolated application network and durable example state.

Reviewed native fixture `can_claim_trial` v1 uses `client.user_count_30d` v1 >= 2 → Deny, unknown → Deny, Otherwise Allow. Author published it explicitly; the application does not seed policy. The example records the authenticated account association/event before evaluation and explains same-browser-context evidence without claiming physical identity. Author reports 14 HTTP/process tests passing. Native example at localhost:3000 has demonstrated evaluated Allow for Ada and Deny for Ben using the same browser context. First Chrome execution confirmed native `Window.fetch` rejects the transport object as receiver; the separate two-file protocol repair passed independent actual-Chrome QA and is accepted as `868fa74`. Never mask this by substituting the example's transport.

Root approved an explicit temporary v2 fixture: prepend `ip.is_proxy@1 == true` → Deny, unknown → Deny; retain the shared-client rule and Otherwise Allow. Demonstrate an evaluated Unknown denial with IP intelligence unconfigured, then restore the original definition as a new version. Provider configuration stays unchanged. Live customer Turnstile pairing remains unverified; controlled-adapter verification is distinct evidence.

### Proof-bound context prerequisite

The protected-app author found a security gap: independently resolved credentials could describe client B while the action proof evaluated client A, allowing pre-check association/event evidence to target the wrong context. Accepted repair `808ce5c` adds mutually exclusive modes to the authenticated resolver: ordinary context credentials, or `{interaction: {proof, check, ip}}`. Interaction mode derives client/session IDs directly from the valid issued proof, validates freshness/action/normalized authoritative IP, and returns proof expiry without consuming or authorizing it. Mixed modes are rejected. Credential-only resolution remains for continuous context events. The browser API stays unchanged: a second bearer pair is unnecessary because the proof already binds the context, and requiring live context credentials would introduce rotation races and shorten a still-valid proof's lifetime. Protected-action examples use interaction resolution before associations/events. The protected application has resumed on the accepted integrated API.

### Provider UI and product refinements

Accepted as `3a847ae`. Fresh `provider_ui_qa` approved the repaired 19-file unit after 154 tests, eight independent failure probes, browser malformed-response/reauthentication recovery and its own matching-backend walkthrough. Provider configuration preserves exact mutation intent across authentication and malformed-response failures, reviews dependent policy versions and reconciles stale configuration. The same recovery repair covers draft save, publication and restoration.

Reports: `/private/tmp/krine-provider-ui-qa-final.md` and `/private/tmp/krine-provider-ui-qa-approved-sha256.txt`. Verification revision 7 is disabled; IP revision 0 remains unconfigured. No real customer provider pairing is claimed. The provider-write window is released. Credentials, relationship correction, observed setup and backend list summaries remain separate units. A fresh Founder agent will review the complete milestone.

### Application credentials

Credential backend and SDK continuity units are accepted as `af85ea9` and `ea67a7e`. Backend reports: `/private/tmp/krine-credentials-{qa,security}-review.md` and `/private/tmp/krine-credentials-integration-qa.md`. Browser reports: `/private/tmp/krine-browser-rotation-{qa,security}.md`. Root verified identical patches through clean rebases; no production conflict repair was needed. ADR 0012 and protocol documentation contain the durable contracts.

`credential_ui_implementer` owns `/private/tmp/krine-credential-ui`, branch `feat/credential-settings` from accepted `ea67a7e`. Compact create/list/revoke controls, secret-once memory-only display, exact mutation recovery and honest null-key setup passed 189 tests and the author's built-browser synthetic walkthrough. Fresh QA found a material P2: malformed setup refresh can unmount the credential model and discard a newly revealed secret; initial malformed setup can leave a blank panel. Root accepted it and delegated repair plus meaningful regressions before rereview. Report `/private/tmp/krine-credential-ui-qa.md`. Root Vite temporarily serves this worktree. Automatic browser approval rejected the native create-key submission before execution because it grants persistent access; it was not retried through another interface. QA's inert fixture submission was also rejected and not bypassed. Independent DOM probes, the author's successful inert browser walkthrough, native read-only inspection and independently proven real backend lifecycle remain distinct evidence.

The credential/settings frontend unit must also fix the existing local SDK reference: generated constructors currently omit `allowInsecureHttp: true` for HTTP deployment URLs, which both SDKs reject. Keep HTTPS snippets strict; show the explicit development option only for HTTP. Root independently reproduced constructor rejection. This is a tracked setup gap, not a waiver of the provider/recovery unit's independent approval.

Credential QA found the old URL-plus-key storage namespace lost participation on rotation. The accepted SDK now uses normalized installation URL with safe current-key legacy migration. Browsers must initialize the updated SDK before replacement of an older key-specific namespace; simultaneous SDK/key replacement cannot discover an unknown old namespace. Ordinary QA and security verified isolation, pairing, corrupt/blocked storage, renewal and concurrency.

Root verified the combined actual browser path against native schema 0005: key A produced `dec_fNE4qPQtJbSN7e0DVwLxfAcYgbXYo6_DgB9Z0hMlSQI`; after A was revoked, B produced `dec_QAtL-OqzCmwt-XUJ6v_kqk742hsrvTaMfiL_v2GFPRI`, preserving client `cli_lOTDRBDYv7HMFWgV2xqY-01EuGHUhIDtGFxKLsu2zoA` and session `ses_sEvn4oieyvXlqIr6_9x3K9FArJBZUk94xF7tVhAffvU`. The additional account raised the count and was denied. Both temporary keys were revoked afterward and the example restored to bootstrap configuration. Earlier root transition from a previously loaded SDK/key combination started new context, consistent with the documented unmigrated legacy boundary; it is not the continuity test above. Existing original decisions remain preserved.

### Relationship provenance and correction

`relationship_backend_implementer` owns `/private/tmp/krine-relationships`, branch `feat/relationship-correction` from `ea67a7e`. Migration 0006 and ADR 0013 are reserved. The approved direction retains backend assertion IDs with optional matching session and authenticated credential provenance, exposes bounded backend/observed-IP relationship inspection, and adds revision-checked reasoned correction/restoration with audit. Observed correction closes the reviewed segment; later observation creates a fresh segment. Restoration conflicts with a newer active segment. Current metrics update synchronously; historical decisions retain bounded immutable relationship summaries with explicit total/truncation and exact metric counts. Shared per-client locking must preserve coherent snapshots with existing lock ordering. Legacy request digests must remain compatible.

Accepted as `d60f6a0` after ordinary and adversarial review; reports `/private/tmp/krine-relationships-qa.md` and `/private/tmp/krine-relationships-security.md`. No graph, merging, blocklist, new metric family or general identity framework. The exact 18-file unit is frozen in `/private/tmp/krine-relationships-freeze.json` with handoff `/private/tmp/krine-relationships-handoff.md`; 69 full Rust tests and 21 protocol/server SDK tests passed. Independent probes covered source authority, old-writer fences, cleanup races, deterministic provider/client/projection locks and 5,001 assertions with exact metrics and bounded history. Frontend follows this accepted contract.

The backend author now owns a separate observed-connection, captured Activity-reason and configurable analytical-retention unit from `d60f6a0`. Compact observed timestamps/record references must distinguish ingestion from enforcement; summaries must remain bounded and explain historical captured evidence. Retention configuration must preserve retry guarantees and metric windows. No frontend or unreported-error/fallback fabrication belongs in that unit.

### Deployment integration

Accepted image fixture `krine-app-test` at port 18080 is currently stopped with volumes/image preserved to conserve the shared 2 GiB Docker VM; it contains accepted backend `ef1a8c7`, QA-green dashboard and deployment code. Image `sha256:7b02b1220fcf1d53bc81f4d0a554cefc12ec2929c2dec8ea80fa71e5f009b6bc`. Handoff `/private/tmp/krine-app-deployment-handoff.md`; QA `/private/tmp/krine-deployment-qa/review.md`; exact owned manifest `/private/tmp/krine-app-owned-manifest.json`.

Two CI failures were repaired and independently reviewed: clean-checkout consumers needed protocol build artifacts before typecheck (`23d1880`), and Linux host-owned mode-0600 secrets needed startup-only read capability (`9c612d5`). Earlier failed runs are `36498331039` and `36499323249`; neither was treated as passing evidence.

Fresh `linux_startup_qa` approved the four-file startup repair in `/private/tmp/krine-linux-secret-fix-manifest.json`. It independently reproduced the old access failure and verified the actual entrypoint reads Linux UID1001/mode0600 dummy secrets, then runs as UID/GID10001 with zero effective/permitted/ambient capabilities, no-new-privileges, unreadable secret mounts and a read-only root filesystem. Failure diagnostics do not expose secret values. Report `/private/tmp/krine-linux-secret-fix-qa.md`.

Replacement [CI run 36502963726](https://github.com/BaderBC/krine/actions/runs/36502963726) on `9c612d5` completed successfully: static checks, unit/frontend suites, dependency audits, actual-store recovery, Linux image build, Linux-owned secret regression, full application smoke and restart. Subsequent full runs on `c4dc990` (`36503907531`), `808ce5c` (`36504664191`) and `3a847ae` (`36505485060`) also passed, including the combined provider image. The complete credential/browser integration also passed full CI/image run `36506905439` on `ea67a7e`; earlier intermediate pushes were cancelled by the configured newer-run policy. Final updated image, protected-app ingress, release load/outages and a full separate backup/restore walkthrough remain gates. Restart persistence does not prove disaster recovery. A mode-0600 PostgreSQL snapshot was taken read-only at `/private/tmp/krine-before-provider-upgrade/postgres.dump` before the planned native provider upgrade; it is a local guard, not the final disaster-recovery proof.

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

1. Finish credential UI recovery repair, QA rereview and security review; integrate the accepted unit.
2. Implement and independently review restrained relationship inspection/correction UI against the accepted backend.
3. Complete observed connection timestamps/links, bounded Activity explanations and honest configurable analytical retention. Preserve the distinction between recorded evaluations, request errors and local fallback without claiming unreported activity exists.
4. Verify the complete protected application, including repeated verification steps using strict controlled integration and, if credentials become available, real provider pairing. Root asked for optional local Turnstile configuration; none has been supplied. Official dummy responses lack Krine's required action/binding, so they are not a substitute and no production bypass is permitted.
5. Review shared Docker ingress and the final combined image; run a separate backup/restore walkthrough, measured release-build load and provider/store outage recovery.
6. Run explicit simplification review and reviewed fixes; final fresh QA, security and Founder review; all full tests and end-to-end walkthroughs; accurate docs; clean committed/pushed Git.

Routine engineering choices need no founder approval. Ask only for material changes to product behavior, public API, UX, security/trust model, launch scope or positioning that cannot reasonably be resolved from accepted context.

## Runtime and test isolation

Root-owned development API: exec session `80790`, 127.0.0.1:8080, admin Origin `http://127.0.0.1:5174`. Dashboard Vite: session `53425`, port 5174, temporarily serving the credential UI worktree for author verification. Unrelated port 5173 is preserved. Current API is accepted integrated commit `ea67a7e`, writer generation 3 and migrations through 0005. Before upgrading, root gracefully stopped the old API and saved a mode-0600 PostgreSQL dump at `/private/tmp/krine-before-credential-upgrade/postgres.dump` (930147 bytes). Native example is now root-owned session `93921` at localhost:3000 with its original credentials; Ada and Ben have one grant each, Cora has a preserved Deny, and earlier example decisions remain historical. Root gracefully stopped old processes before upgrades and verified readiness; an existing historical decision survived the provider migration. After the author UI walkthrough, IP intelligence is unconfigured at revision 0; verification is disabled at revision 7 with retained synthetic configuration and dependency `qa_provider_ui_author_20260929` v1. Its write window is released; coordinate further writes explicitly.

Shared development stores: Compose project `krine`, PostgreSQL 15432 / Valkey 16379 / ClickHouse 18123; ignored `deploy/secrets/`. Root wrapper `/private/tmp/krine-runtime-env.py` loads secrets without printing them. It is for the running development application, **not destructive tests**. Scoped pnpm 11.28.2 executable `/tmp/krine-pnpm-tool/node_modules/.bin/pnpm`; development Node 24.21 LTS, Rust 1.98.0. SDK consumer requirements are separate. Local Docker DNS workaround uses verified downloaded image digests and `/private/tmp/krine-local-images.yaml`; do not change shared daemon configuration.

**Isolation incident and rule:** a specialist selected broad ignored tests through a provider-only wrapper. Projection tests used the shared stores and applied migration 0003, breaking the older API's history reads. Tests stopped; no rollback/deletion was attempted. Root restarted its API with matching code, preserving data; readiness and existing historical detail now work. This does not approve providers.

Every migration/recovery/destructive fixture must prove isolation for **all three stores**. The accepted `scripts/with-dev-env.py --isolated-stores` verifies a named `krine-test-*`/`krine-ci` project, actual loopback port ownership, no foreign URL/file overrides and no running app. QA independently rejected 15 unsafe configurations and a real extra app-labelled container. Temporary provider wrappers must also isolate all stores for broad selections; never use the older provider-only wrapper until repaired.

Available guarded fixture: `krine-test-deployment`, ports 25432/26379/28123, secrets `deploy/secrets/test-deployment`, no application. Coordinate ownership before tests. Do not reset shared stores or unrelated containers. Separate HTTP cookie jars avoid overwriting root's Chrome admin session: host cookies are shared across ports.

Credential QA/security applied migration 0005 to the **dedicated test public schema only** and released the fixture. Older accepted builds must use a fresh database/schema for further tests; never roll that shared test schema back or route them to the native stores. Native schema is now 0005. Relationship implementation/reviews applied migration 0006 / writer generation 4 to the guarded fixture public schema, then released it. The observed-connection backend author currently owns that fixture. Native remains schema 0005; older builds must use unique test schemas.

## Dependency audit disposition

pnpm production and full audits reported no advisories at the first dashboard milestone. RustSec cargo-audit 0.22.2 against database `ef03605143a913024f864d2edf476adad5720c93` reported only [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) in SQLx's unused optional MySQL/RSA lockfile chain. `scripts/audit-rust.py` proves neither package is selected in the all-workspace/all-feature/all-target graph before applying that single exception. Fresh QA independently introduced real RSA and SQLx/MySQL dependencies, including aliases, and verified rejection before audit. No active vulnerable dependency is waived; rerun audits at release.
