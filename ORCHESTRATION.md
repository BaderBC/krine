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
| `6eb889d` | Application credential settings | Fresh QA and security resolved malformed-setup secret loss and delayed-response revocation contradictions. Final 210 tests, 13 QA probes and 12 security probes passed; root verified the unchanged rebase and identical combined build. |
| `92f03a5` | Protected application ingress | Fresh ordinary QA and dedicated security approved 18 frozen paths. Actual six-service smoke, Chrome Allow→Deny/reload, sanitized source IP, managed-key rotation, restart persistence, hostile HTTP framing/no retries and startup-only secret access passed. Root verified identical patch IDs after rebase and passed the isolation guard. Normal Docker recipes and the full integration pipeline passed in GitHub run `36516537266`. |
| `f323980` | Combined protected verification regression | Fresh QA and dedicated security approve five paths exercising both SDKs, actual Axum/stores and the durable application through sequential challenges, replay, lost acknowledgements and three application crashes. Three cleanup findings were repaired and independently reproduced; the unchanged 150-second failure restores exact owned resources. Root preserved both accepted README sections through the only merge conflict and verified all four other file hashes unchanged. The separately reviewed `25f6181` fixes Linux process-group signaling; combined Ubuntu CI passes. |
| `6528a9d` | Relationship investigation and lossless addressing | Ordinary QA and dedicated security approve 40 frozen paths: 291 dashboard tests, independent DOM/browser review, actual Axum/Node tests and 123 additional hostile HTTP responses. ADR 0015 preserves all accepted identifiers, legacy routes and exact recovery requests. |
| `f0eba93` | Exact identifier search | Fresh QA approves two paths: 307 dashboard tests and 13 independent form/navigation probes. Entity searches preserve leading, trailing and Unicode whitespace; other search grammars still trim. |
| `0288334` | Bounded ClickHouse diagnostics | Ordinary QA and dedicated security approve eight frozen paths, interrupted/repeated startup, timestamp expiry, privilege boundaries and retained-volume upgrade. ADR 0016 documents pinned upstream behavior and honest metadata permissions. |
| `eeaa4de` | Observed connection, captured reasons and retention | Final independent full suite passes 87 tests after diagnostics repair. QA reproduced and verified rolling-TTL and mixed-clock fixes; security ran 1,080 explanation probes. ADR 0014 records monotonic expiry, bounded cleanup and receipt coverage. |

The first runtime/dashboard are vertical slices, not a reduction of MVP scope. Runtime contracts are in `docs/engineering/{protocol,backend,sdks}.md` and ADRs; consult them rather than inferring from this ledger.

## Current execution state

Accepted product changes are integrated and pushed in `/private/tmp/krine-mvp-integration`, branch `integrate/mvp-history-investigation`, now `e7f658f`. Main remains `82282c8` so the watched native frontend stays paired with its older API. Root resolved only mechanical composition conflicts: retain both Compose revision labels and all three test-module declarations. Fresh merged QA approved the product source at `4a42e38` after 90 full Rust tests, 368 JavaScript tests, static checks and 48 additional real HTTP responses. Report `/private/tmp/krine-merged-history-investigation-qa.md`.

Linux CI exposed a process-group signaling defect in the combined verification test: procps interpreted a negative PID as an option without `--`. The accepted one-file repair `25f6181` received fresh ordinary QA and dedicated security review, including private Linux PID-namespace reproduction, unrelated canaries, TERM escalation and original-error preservation. Reports `/private/tmp/krine-linux-kill-{qa,security}.md`. Full Ubuntu CI passes on the repair (`36569034344`), main (`36569034468`) and combined integration `9b312ed` (`36569033678`). That combined run took 12m37s and includes normal production Docker builds, ingress smoke, retained diagnostic upgrade and the protected verification regression. The Linux gate is closed. Never reproduce the original unsafe command on the host.

The six-file release documentation unit `e02b069` is independently approved, committed, pushed and merged into integration. The remaining unaccepted units are the observed dashboard and recovery verification. Release load/outage verification is prepared separately against exact accepted production images.

### Remaining sequence

1. Finish rereview of the frozen 11-path dashboard unit in `/private/tmp/krine-observed-dashboard`. All three material QA findings were accepted and repaired: intermediate-width overlap, contradictory reason metadata and excessive Activity density. Author passes 376 tests, build/typecheck and actual Chrome at 601/600/390px. Independent rereview must confirm before acceptance. Preserve one-time secrets, scoped receipts and immutable explanations; no new navigation or editable retention control.
2. Finish fresh ordinary recovery QA and dedicated adversarial security review of the five-path unit described below. Ordinary QA owns the current exclusive Docker window and performs a fresh full image export/restore.
3. Run the prepared release load and dependency-outage harness after recovery releases resources. Exact `4a42e38` Linux/arm64 core image is `a1b8fe68d6910fd5d3dab0e025d6ea72121554fcca06de9b4e35a9e336bcfad9`, example `c2783e1e325548e83aaa898672ebfaa2601dedae57cf04248fd6a5015b9a3eb8`; ingress remains the accepted image. Preparation/logs are in `/private/tmp/krine-latest-image-preparation/`. Capture exact counts, retries, latency, fallback semantics, export recovery and one business grant. Fresh independent review follows. Earlier debug-only load evidence is a baseline, not release acceptance.
4. Integrate accepted final units, update the release frontend, and upgrade the native application with backup and matching frontend/backend. Exercise primary product flows. Run a fresh whole-workflow Founder review and explicit whole-product simplification review.
5. Resolve material findings, reconcile durable docs, run full checks and final independent QA/security/Founder, then clean commit and final push. No gate is satisfied merely by planning it.

## Review evidence and decisions

Temporary evidence paths below are local working artifacts; accepted implementation and durable contracts are committed. Git history retains earlier iteration details removed from this operational record.

### Identity, credentials and investigation

- Relationship backend: `/private/tmp/krine-relationships-{qa,security}.md`. Current metrics use exact active relationships; immutable historical samples have explicit totals/truncation. Correction/restoration is audited and never silently re-associates identity. ADR 0013 is authoritative.
- Relationship UI/addressing: `/private/tmp/krine-relationship-ui-{qa,security}.md`, 40-path manifest `/private/tmp/krine-relationship-ui-freeze.json` (SHA256 `a2bc981f695436c142d770ee5c9ee6b27c495553b90d8897dc239332aa1fe335`). Security correctly rejected path-normalized `.`/`..` IDs. Additive query selectors preserve existing identifiers, routes and exact legacy retries. Root accepted `6528a9d`; subsequent two-file exact-search repair is separately frozen/reviewed in `/private/tmp/krine-identifier-search-{freeze.json,qa.md}` and accepted as `f0eba93`.
- Credentials: `/private/tmp/krine-credential-ui-{qa,security}.md`. A malformed refresh cannot destroy the sole copy of a new secret; known revocation dominates a late creation response. Secrets remain memory-only. Backend bootstrap import is permanent and never resurrects revoked keys.
- Browser key rotation: accepted context namespace migration preserves Krine-owned client/session identity across rotation. Root exercised actual Chrome key A → revoke A → key B with unchanged identifiers.
- Proof-context resolution: accepted `808ce5c` resolves the exact proof/check/IP without consumption, preventing evidence recorded against a different browser context. Security, ordinary and integration reviews approve.

### Observed history and retention

Final 23-path manifest `/private/tmp/krine-observed-connection-freeze.json` has SHA256 `16208b7fa0b049fd5cfe85a018aec1e1f6422c4bac20d61f855034cd004c1b19`. Reports `/private/tmp/krine-observed-history-{qa,security}.md`. Full raw rerun `/private/tmp/krine-history-final-full-suite.log`: 87 passed, zero failed/ignored, 62.780 seconds; cleanup and preserved migration/unknown-schema checks passed.

Two material QA findings were fixed: a prior rolling ClickHouse TTL could erase history after retention extension; mixed host/PG clocks could lower the expiry floor. One PostgreSQL-clock monotonic boundary, absolute-cutoff mutation barriers and durable bounded cleanup now govern both. Independent actual-store probes verified legacy TTL extension, clock/config interleavings and unsent cleanup-intent recovery. A 60,200-row cleanup removed exactly 60,000 while preserving 200, in about 1.04 seconds. The separate long-running ClickHouse memory problem was fixed before final full approval; do not conflate it with the logical retention defects.

Receipts, captured reason summaries, typed entity history and effective/requested retention contracts are in `docs/engineering/protocol.md` and ADR 0014. They do not fabricate invalid-request history, local SDK fallback, enforcement or uninterrupted coverage.

### Providers and protected application

Provider/backend reviews: `/private/tmp/krine-provider-{runtime-qa,snapshot-qa,security}-review.md`; configuration Founder report `/private/tmp/krine-configuration-founder.md`. Fixed real dependency/publication races, statement-snapshot pinning and continuation amplification. Fixed-origin bounded calls, revision-pinned normalized evidence and known-pending fail-closed behavior remain invariant. Core operation requires no Krine cloud.

Protected example reviews: `/private/tmp/krine-protected-app-qa-final.md`, `/private/tmp/krine-protected-app-security.md`; ingress reviews `/private/tmp/krine-ingress-{qa,security}.md`. The example persists original requests/pending/final results and one actual trial grant, with SQLite WAL/FULL durability. The operator publishes policy; deployment never silently seeds it. Same-context shared-user evidence is not physical identity.

Combined verification: `/private/tmp/krine-protected-verification-qa-final.md` and `/private/tmp/krine-protected-verification-security.md` approve the five-file macOS-reviewed source at `f323980`. Both built SDKs, actual Axum/stores and durable example execute eight operations, sequential challenges, replay/cross-binding failures, lost acknowledgements, three application crashes and exactly one grant. Ordinary QA independently repaired/retested assertion cleanup, abrupt harness exit and the unchanged 150-second deadline. The independently reviewed Linux cleanup repair and complete Ubuntu pipeline now pass, as recorded above. Strict provider HTTP and JSDOM widget adapters are controlled test boundaries: no live Turnstile pairing or actual Chrome challenge execution is claimed. No live key pair has been supplied; no validation bypass is authorized.

Ingress at `92f03a5` passed normal Linux image CI `36516537266`. Opt-in six-service example uses sanitizing Nginx, narrow proxy trust, separate private network and durable example state. Rootless read-only services read mapped secrets only at startup, then drop capabilities. A separate Linux secret-mode QA caught and fixed UID/mode access without weakening steady-state privileges.

### Diagnostics and retained-volume upgrade

Eight-path manifest `/private/tmp/krine-clickhouse-diagnostics-manifest.sha256` has SHA256 `9e399631f37861bb9e7a5aec8c310dab9db772a2af9e5fb290b16c8da4e9c251`. Ordinary and security reports use `/private/tmp/krine-clickhouse-diagnostics-{qa,security}.md`; both approve the final documentation repair as well as runtime behavior. Query/crash logs have seven-day timestamp TTL; unused high-frequency diagnostic logs are disabled. Application history and narrow maintenance privileges remain intact.

Pinned upstream behavior matters: canonical custom log names may be archived before the bootstrap helper runs, and ClickHouse implicitly grants scoped metadata visibility. The docs no longer promise untouched custom metadata or narrower effective metadata permissions than the engine provides. Recognized old archives alone receive maintenance. Failure keeps public readiness closed.

Actual retained-volume upgrade evidence: `/private/tmp/krine-retained-diagnostics-upgrade/report.md`. Only guarded test ClickHouse was recreated. Existing application schemas/rows, legacy log disk-part checksums and volumes were preserved; bootstrap identity is absent, required mutation columns work, command/error/log access is denied. Disk-part inventory includes inactive parts and is not an active-part count. Earlier “3,389 active parts” was a block-number misinterpretation and must not be repeated. The complete history suite subsequently passed without exception 241.

## Recovery rehearsal

Frozen five-path unit in `/private/tmp/krine-recovery`, branch `feat/recovery-verification`, base `9b312ed`; not yet accepted or committed. Manifest `/private/tmp/krine-recovery-freeze.json` SHA256 `5da57828ebbaa9d559b36f8d168a0e34f2dc27878ac9ff53c7c2a5d103302f27`; handoff `/private/tmp/krine-recovery-handoff.md`. Canonical operator procedure, exact-image two-project rehearsal, 13 isolation/archive checks and CI integration operationalize the existing architecture without new infrastructure or grants.

Final author rehearsal passed in 128.702s. Private evidence is `deploy/secrets/recovery/krine-recovery-n83grq0s`; only `result.json` is suitable for ordinary inspection. Other files may contain secrets/proofs. The run proves full stopped PG/ClickHouse/example recovery, immutable image archive integrity, managed credentials/revocations/bootstrap marker, exact decision retries and replay ownership, relationship audits, one SQLite grant, and retained analytical history after the corresponding acknowledged PG rows are removed. The old context is rejected while about 24 hours of its lifetime remain; a real pending challenge survives 34.967s of its five-minute window. A synthetic provider configuration makes no live verification claim. Fresh checks use the actual restored ingress peer independently of the old operation's immutable IP.

Source and target run sequentially with the same browser origins: API `127.0.0.1:39080`, application `localhost:34000`, subnet `10.203.85.0/24`. Restore uses new empty owned volumes, PG before application startup, empty Valkey, full numeric ownership/modes/ACLs/xattrs/symlinks, copied private configuration and exact images. Populated restore targets are refused. Success is written only after owned cleanup succeeds; original errors survive cleanup errors. Source and target volumes and all failed evidence remain preserved. Local existing-image use does not prove clean-host import; operator documentation includes import and platform constraints.

Fresh ordinary QA has passed the frozen manifest, 13 checks and seven independent refusal/failure probes. It now owns the full rehearsal window after root reclaimed unused compiler cache. Required export headroom is 7.610 GiB (2.2× six image sizes plus 4 GiB); root measured 8.126 GiB before clearance. No archive reuse, hard-link shortcut, image deletion, archive deletion or daemon changes. A dedicated security review follows; it need not duplicate a 1.575 GB image export to test distinct threats. All source/target/helper cleanup must preserve pre-existing container identity, mounts and state.

## Runtime and resource ownership

All store-consuming tests use exclusive coordinated windows. Never run destructive tests against native project `krine`, and never change shared Colima or unrelated Daylin services. The shared VM has 2 CPUs, 1.914 GiB RAM and no swap; documented deployment minimum is 4 GiB. Local timings are not a supported production sizing claim.

### Guarded test fixture

Project `krine-test-deployment`, PG `25432`, Valkey `26379`, ClickHouse `28123`; secrets directory `deploy/secrets/test-deployment`. Latest ClickHouse ID begins `34ab0915`, retained volume `krine-test-deployment_clickhouse_data`; PostgreSQL/Valkey identities unchanged. Use `diagnostics-retention-overlay.yaml` and the staged diagnostics/retention entrypoint for future recreation, not the older retention-only overlay.

The original `krine` DB has migration 0007's old checksum and must not be migrated or rewritten. Approved repaired database `krine_retention_repair_20260929` is selected **after** the unchanged guard by `/private/tmp/krine-retention-test-db.py`. Preserve unknown schema `pt_93c718a5b1882ec80b7cff170687ee84`. Example invocation from the reviewed worktree:

```sh
COMPOSE_PROJECT_NAME=krine-test-deployment \
KRINE_SECRETS_DIR=/Users/bstrama/Projects/krine/deploy/secrets/test-deployment \
KRINE_POSTGRES_PORT=25432 KRINE_VALKEY_PORT=26379 KRINE_CLICKHOUSE_PORT=28123 \
./scripts/with-dev-env.py --isolated-stores \
python3 /private/tmp/krine-retention-test-db.py \
cargo test --workspace --locked -- --include-ignored --test-threads=1
```

The ingress fixture wrapper selects a different six-service project and must not be substituted. A prior isolation mistake migrated shared native state through a provider-only wrapper; it was recovered forward without deletion. The guard and ownership rules prevent recurrence.

### Preserved native product

API at `127.0.0.1:8080`, dashboard `127.0.0.1:5174`, protected example `localhost:3000`; native stores use `15432/16379/18123`. Do not touch unrelated `5173`. API remains schema 0006/writer 4 at `d60f6a0`; dashboard `6eb889d`. Existing API/example/Vite sessions are `96578`/`85663`/`30008`. Upgrade deliberately with matching sources and backup, not by changing watched main beneath the old API.

Launch helpers `/private/tmp/krine-runtime-env.py` and `/private/tmp/krine-example-rotation-launch.py` load private secrets without printing them. Current private admin password path `/private/tmp/krine-dashboard-admin-password`. PG backup `/private/tmp/krine-before-relationship-upgrade/postgres.dump` (940,780 bytes) is an upgrade precaution, not disaster-recovery evidence.

Native Chrome resumed Cora's existing policy-3 Deny without a new trial request: operation `c574da60-c827-4fd8-9ad0-e3220ba73a79`, decision `dec_QAtL-OqzCmwt-XUJ6v_kqk742hsrvTaMfiL_v2GFPRI`, captured `client.user_count_30d@1 = 2`, Rule 1 `>= 2`, Unknown → Deny. Screenshots `/private/tmp/krine-native-example-resumed.png` and `/private/tmp/krine-native-denial-explanation-resumed.png`; product tabs `2019370715` and `2019370604`. Earlier computer-use review rejected repeated native correction and key-creation submissions before execution. Do not repeat/reroute those rejected writes; isolated newly owned test fixtures are distinct.

Stopped ingress projects `krine-test-example` and `krine-test-ingress-qa` retain managed credentials and volumes. Old reviewed images and offline contexts in `/private/tmp/krine-ingress-*` are preserved for reuse. Do not resurrect revoked bootstrap credentials. Disk reclamation removes only verified unused Krine compiler artifacts after scoped `lsof` and ownership checks. Removed caches include inactive credentials/relationships targets, accepted relationship UI target, main incremental/old-release/unused `.rlib` and `.rmeta` files, completed audit build target, and completed proof-context security target. Preserve the running native executable and its hardlinks, active build targets, installed audit tool, source, node modules, evidence, images, archives and every volume. Recheck free space before each export or large build; do not prune shared Docker/Colima or unrelated caches.

## Product and simplification disposition

Fresh configuration Founder review at `6eb889d` kept the check-centered product and rejected extra feature families. Example discoverability, resolved session association and honest application-owned fallback copy are now implemented; observed connection receipts and captured Activity reasons are now in repair rereview. Core/backend/SDK simplification previously inspected about 1,749 lines and found no justified rewrite. A fresh whole-product pass with `code-simplification` remains required after integration; correctness and capability cannot be traded for fewer lines.

## Release documentation

Accepted `e02b069` covers six Markdown paths and is merged into integration. Fresh independent QA approved `/private/tmp/krine-release-documentation-qa.md`: built and packed all SDKs, installed standalone and nested-workspace consumers, ran three offline frozen reinstalls, 32 ESM assertions, four strict TypeScript checks, a real browser Vite bundle and 33 link checks. Local tarballs require the documented root `pnpm-workspace.yaml` protocol override; installing three tarballs alone still leaves a registry dependency. No registry publication or unsupported Node runtime claim is made. Fresh bootstrap import, managed credential rotation, exact query limits and settled open questions now match durable behavior. Canonical SDK instructions avoid duplicate setup recipes. Recovery documentation remains in its separately reviewed unit.

## Dependency audits

Prior pnpm full/production audits reported no advisories. RustSec reports only `RUSTSEC-2023-0071` in SQLx's unused optional MySQL/RSA lockfile chain. `scripts/audit-rust.py` proves neither is selected in the all-workspace/all-feature/all-target graph before allowing that single exception. Fresh QA independently added real/aliased selected dependencies and confirmed rejection. No active vulnerable dependency is waived. At integrated4a42e38, root reran the full pnpm audit (zero advisories) and guarded Rust audit against updated RustSec `f23b768236fe2880e4cfa167da662cad8ca79240` (1,277 advisories, 270 locked packages): passed. The first command lacked the installed audit tool on PATH; the corrected invocation used `/private/tmp/krine-audit-tool/bin`. Reconcile documentation using `/private/tmp/krine-final-documentation-notes.md`; verify unchanged dependency graphs or rerun after dependency changes.
