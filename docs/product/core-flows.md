# Core user flows

These flows implement the [information architecture](information-architecture.md). Product behavior follows [MVP contract defaults](../decisions/0007-mvp-contract-defaults.md). The dashboard configures and explains checks; the customer's backend enforces their results.

## 1. Reach the first explained decision

Entry: a developer has started a self-hosted deployment and opened its dashboard. Installation and access setup belong to deployment instructions; the product adds no organization/project onboarding.

1. **Overview → Checks, empty.** Show “Create a check for an action your application protects,” **Create check**, and a secondary **Connect application** link. Do not populate example checks or empty statistic cards.
2. **Name the check.** Create it inline with a unique application-facing name such as `can_claim_trial`. Open its unpublished draft. Explain that the name is used in application code; keep the identifier stable after creation.
3. **Write and publish the policy.** Add a condition from the built-in catalog, read its meaning, choose the result and inspect the unknown path. A new draft's Otherwise outcome is Deny. Review and publish the first version. Publication alone does not mean the application is protected.
4. **Connect the application.** The check's Integration link opens the shared Application connection section with this check selected. Provide one browser example and one server example using the installed SDK versions. Server credentials appear only in the server setup. The examples cover client/session evidence, an authoritative backend event and association with a backend-known user.
5. **Wire the protected action.** The browser obtains a fresh action-bound proof and sends it with the protected request. The backend supplies authoritative identity/business inputs, calls the check, handles allow/deny/verification and prevents duplicate execution of its own action. Explain the default 60-second proof acceptance window, IP binding and stable operation key beside this example.
6. **Verify in the application.** Run a real action in the developer's own test deployment. The connection section shows received client evidence, a received backend event and the check's first attempt as compact rows with timestamps and record links. These are observations, not manually checked completion boxes. Analytical visibility may lag ingestion acknowledgement.
7. **Read the result.** Follow the recorded attempt to its explanation. It identifies the check, published policy, relevant values and path. Whether the result is allow or deny, the full loop is inspectable.

The integration example must show local SDK fallback clearly: its accepted default is Allow, with global and per-check overrides in server configuration. Changing a dashboard policy does not configure an unreachable SDK. Mark example configuration as an example unless the deployment actually reports its applied value. The developer must verify application-side enforcement; a received decision cannot prove it.

Completion: evidence and backend events are observed, the backend makes the check, and the developer can explain the result. When records exist, remove first-use prompts from Checks; integration instructions remain under Integration and Settings. No congratulatory screen or permanent setup checklist is needed.

If no attempt arrives, keep “No requests received” and link to connection instructions. If the request is invalid or lacks an active policy, show a configuration/request error where recorded. Do not describe it as an evaluated denial or turn it into fallback Allow.

## 2. Create, change and restore a policy

Entry: Checks → a check → Edit policy. One shared draft per check is sufficient for MVP. Opening an existing draft resumes it; the active policy remains visible by version reference.

1. Add or change a rule in the vertical editor. Pick a metric or supported trusted backend input, a compatible operator, a typed value and an outcome. Reveal compound conditions only when requested. Keep rule order, unknown handling and Otherwise readable.
2. Autosave the draft with explicit Saving, Saved or Save failed text. Failed persistence keeps the local edits and provides Retry. Warn before leaving with unsaved edits. Concurrent changes produce a conflict requiring reconciliation; do not silently overwrite another editor's work.
3. Choose **Review and publish**. A compact review on the same page shows the difference from the active version, including removed/reordered rules, unknown paths, Otherwise, verification branches and metric upgrades. For a first version, show the entire short policy. State “Applies to new attempts immediately.” Existing logical attempts retain their policy context.
4. Validate names, types, required values, metric versions and configured required capabilities. Distinguish missing configuration from a temporary provider outage. An outage does not prevent publishing an otherwise valid policy whose explicit failure paths handle it; show those consequences in the review. Do not invent replay predictions or impact percentages.
5. Choose **Publish version**. Publish atomically against the reviewed draft and active revision. Stale review or publication failure preserves the draft and identifies the problem. Success shows the new active version and a concise confirmation inline.

An unpublished check has no active policy. Save never activates it. A published check with an edited draft continues to use the last active version. Do not add an ambiguous pause switch; changing enforcement requires an explicit policy publication and review.

To restore, open **Versions**, inspect the immutable prior version and choose **Restore this policy**. Review its difference from the currently active policy, then publish a new version using that definition and its metric versions. Record the source version; preserve all prior versions and decisions. Retain an existing draft until the user explicitly chooses to replace it. Validate required dependencies before restoration.

To upgrade a metric, follow its version link, read the semantic change and choose **Use this version in draft** in check context. Publication exposes the upgrade in the review. Reading the newest catalog page never upgrades a policy.

Completion: the active version is unambiguous, every behavior change is reviewable, and previous decisions still point to the definitions that produced them.

## 3. Add verification and complete an action

Entry: a draft rule → Then → Require verification, or the same outcome for an unknown condition.

If the capability is unconfigured, show **Configure verification** beside the rule. It opens the relevant Providers row with a return link to the saved draft. Collect required configuration, test it, save it and return. The policy refers to the normalized capability; vendor credentials and options stay in Settings.

Show the step's branches in the rule: verified → continue below; failed, expired or provider unavailable → deny. Review and publish through the normal flow. Do not add a separate challenge-policy editor.

```mermaid
sequenceDiagram
    participant Browser
    participant Backend as Application backend
    participant Krine
    participant Provider as Verification provider
    Browser->>Krine: Obtain action-bound proof
    Browser->>Backend: Protected request with proof
    Backend->>Krine: Check with trusted inputs and operation key
    Krine-->>Backend: CHALLENGE_REQUIRED
    Backend-->>Browser: Verification required; action remains pending
    Browser->>Provider: Complete verification
    Provider-->>Browser: Verification evidence
    Browser->>Backend: Continue the same protected attempt
    Backend->>Krine: Same operation plus verification evidence
    Krine->>Provider: Verify evidence through capability adapter
    Provider-->>Krine: Verification result
    Krine->>Krine: Follow the policy's continuation or failure path
    Krine-->>Backend: Allow / Deny / further verification required
    Backend-->>Browser: Action result or next required verification
```

The diagram describes responsibilities, not SDK signatures or a required provider wire protocol. The backend executes the action only after an authoritative final allow or its explicitly configured local availability fallback. Verification success by itself never authorizes execution.

Activity uses one row for the logical attempt. Its detail records each verification transition and any final decision. Ordinary retries recover the same attempt; challenge evidence advances it. A final result remains stable. If a later rule needs verification, its requirement remains explicit; the editor does not imply that the first successful challenge grants blanket approval.

The dashboard does not render an end user's challenge or offer a “mark verified” control. If the browser abandons verification, show the last recorded state. Label expiry only when known. Expired initial proof, replay or source-IP mismatch is a request failure with a specific reason, never local fallback Allow.

Completion: the same attempt reaches a traceable final result, or remains explicitly pending/failed. Application action execution remains idempotent even when requests are retried.

## 4. Explain a denial or unexpected allow

Entry: Check → View activity, Activity search, or a decision link copied from application diagnostics.

1. Find the attempt by check, operation ID, subject or time range. Filters persist in the URL. Read its short reason before opening it.
2. Open the explanation: outcome, policy version, matched rule and actual metric/input values. A denial caused by unavailable data says so: “IP risk unknown: provider timed out. Rule 2 denies when unknown.” A local fallback says “SDK fallback · Allow: Krine request timed out,” if that report reached Krine.
3. Expand the policy path only if needed. It identifies matched, unmatched, unknown and unreached conditions and the exact version of each relevant metric. Follow a metric link to learn its semantics or a subject link to inspect the evidence.
4. If the policy needs correction, follow **Edit current policy**. Show when the decision used an older policy. Resume or create the current draft without silently replacing it with historical logic. Publish through the normal review.
5. Return to Activity and observe later attempts. Historical decisions remain unchanged. There is no replay/simulation button in MVP.

Completion: the developer can state why the attempt received its result and identify whether the remedy belongs in the policy, integration, evidence or provider configuration.

## 5. Inspect evidence and correct an association

Entry: a subject link in a decision/event, or an exact identifier in Activity search.

1. Open the client, backend-known user or IP. Read its current metrics with timestamps, then its relationship rows. The page calls a browser context a Client, never a proven device or person.
2. Open an association's source record. Identify whether it was backend-asserted or observed, when it arose and which session context is attached. Shared IP or fingerprint evidence does not establish common identity.
3. For an incorrect association, choose **Correct association** on that row. Explain the change, require a short reason and confirm the specific endpoints. End/invalidate the association without deleting its evidence. An observed relationship should describe the correction's scope; do not imply that a new observation can never appear again.
4. Keep the correction record inspectable and offer **Restore association** with the same review. Show recalculation as pending until affected current metrics reflect the correction. Historical time-window metrics follow their documented correction semantics; do not promise every count will immediately fall.
5. Return to the original decision. Its recorded relationship context and metric values remain historical. New checks use the corrected state according to each metric's contract.

Correction is an authenticated administrative action, separate from backend-originated facts and client evidence. It never merges identities or silently rewrites the application's user records.

Completion: the mistaken relationship is corrected with provenance and a reversible record. Ordinary inspection requires no editing mode or graph navigation.

## 6. Configure intelligence and diagnose missing data

Entry: Settings → Providers, or an unavailable metric's **Provider settings** link.

1. Expand the required capability, such as IP intelligence. Choose the shipped implementation where a choice exists; enter required configuration. Avoid a marketplace or connector gallery.
2. Test the entered configuration before saving. Report success or the specific connection problem inline. Failed tests retain non-secret input and preserve the active configuration. Label when the implementation cannot safely perform a live test.
3. Save the tested configuration. For a replacement or disconnect, show dependent checks and their unknown/failure paths before confirmation. Provider identity changes stay in provenance; a change in normalized metric semantics requires a metric version and explicit policy upgrade.
4. Inspect subsequent evidence through the affected check's Activity. A connection test confirms reachability/configuration only; it does not prove a metric is present or that protected actions are enforced correctly.

During an outage, preserve the unknown value and its cause. Link directly to the provider configuration; show affected checks there. Restoring connectivity does not rewrite old decisions. If the whole Krine service is unavailable, the server SDK's local configuration applies; the dashboard cannot change it while unreachable and cannot guarantee it received every fallback report.

Completion: the capability is configured and its actual contribution to later decisions can be inspected. Advanced cache, timeout and retention controls remain deployment configuration until a demonstrated operator task needs dashboard controls.

## Shared states

| Situation | What the interface says or does |
| --- | --- |
| No checks | One sentence, Create check, secondary connection link |
| Check published, no traffic | No requests received; Integration link |
| No filter matches | No matching records; clear filters or change time range |
| No retained records | State available retention coverage; do not imply nothing happened |
| Loading | Stable page structure and labeled loading state; no fake zeroes |
| Refresh/query failure | Preserve prior data as stale, show last refresh and Retry |
| Unknown metric | Unknown plus the reason; link to definition and relevant evidence |
| Save failed | Preserve edits, explain recovery and keep publication state unchanged |
| Concurrent edit/publish | Identify the stale revision; preserve work for reconciliation |
| Invalid form | Field-level error, focus first error, retain valid input |
| Destructive configuration change | Name the affected resource and consequences; confirm or offer undo |
| Insufficient access | Explain the denied action while preserving allowed read access |

## Daily investigation

Open Overview, choose an interval and inspect its recorded outcomes and trend. Follow a series, protected action, recorded reason or time bucket into Activity. The resulting address preserves the exact inclusive bounds and filters. Open an explanation, then return to the same evidence page. Refresh a relative interval to advance both bounds; refreshing an absolute investigation keeps its interval fixed.

Subject lookup and pivots open the existing typed context page. Completing behavioral profiles remains a separate product gate: preserve the investigation interval, combine events and decisions in a paginated direct history, group actual session/day context, and keep relationships accessible without scanning a long table.

## Acceptance walkthroughs

These are implementation acceptance scenarios, not claims that a UI already passes them.

- From an empty deployment, create one check, connect both SDKs, observe backend and client evidence and inspect a real decision without an onboarding wizard.
- Build a compound policy with a challenge and explicit unknown behavior using a keyboard. Read its complete ordinary flow without manipulating a canvas.
- Save a draft while requests use the active version. Publish, restore a prior definition and verify that older decisions still open their original policy/metric versions.
- Follow a denial to its metric, evidence and entity, then return with Activity filters intact. Repeat with a long identifier and a narrow viewport.
- Timeout an IP provider and distinguish Unknown → policy Deny from Krine unavailable → local SDK fallback Allow. A missing fallback report must not appear as a recorded evaluation.
- Retry and complete a challenged attempt; verify that Activity does not count retries as new protected actions and does not label challenge success as final authorization.
- Correct and restore an association without merging identities, losing provenance or changing the explanation of an old decision.
- Fail a save, refresh and concurrent publish; verify that work is preserved and no stale or unsaved state is presented as current.
