# Information architecture

Krine opens on **Overview**. The horizontal navigation contains **Overview**, **Checks**, **Activity** and **Metrics**, followed by a quieter **Settings** link. Operators scan recorded activity, investigate changes and configure protected actions in Checks.

This document describes the dashboard structure. [UX principles](ux.md) govern product taste; the [MVP scope](mvp.md) and [accepted contracts](../decisions/0007-mvp-contract-defaults.md) govern behavior. [Core flows](core-flows.md) describe the interactions. [ADR 0018](../decisions/0018-operator-overview-and-investigation.md) updates the landing page and investigation direction; the policy editor choices in [ADR 0008](../decisions/0008-check-centered-information-architecture.md) remain in force.

## Navigation

| Destination | User question | Default surface | Primary action |
| --- | --- | --- | --- |
| Overview | What changed in recorded activity? | Counts, accepted-time trend and recorded reasons | Drill into a scoped interval |
| Checks | What actions do I protect, and how? | Compact check list; open a check to read its active policy | Create check; then Edit policy |
| Activity | What happened, and why? | Recent check attempts, with an Events view | Open a record |
| Metrics | What can my policies know? | Searchable, read-only catalog | Read a metric |
| Settings | How is this deployment connected? | Application connection and provider capabilities | Configure the relevant connection |

Use one compact header, a content column and normal document scrolling. The product name links to Overview. A deployment label helps distinguish separate installations; it is plain text, not a project switcher. On narrow screens, the primary links remain visible and detail content stacks vertically.

```text
Krine · staging       Overview   Checks   Activity   Metrics              Settings

Checks                                                   Create check

Name                 Policy          Last activity
can_register         v3              Allow · 2 minutes ago
can_claim_trial      v7 · Draft       Deny · 4 minutes ago
can_send_email       Unpublished      No requests received
```

The example data and metric names in these designs are illustrative. The implementation chooses the initial metric catalog.

## Where each concept lives

| Concept | Home | Contextual entry |
| --- | --- | --- |
| Check | Checks | Decision → check |
| Policy and its versions | Inside its check | Decision → exact evaluated version |
| Decision or pending check attempt | Activity → Decisions | Check → View activity |
| Backend event or client evidence | Activity → Events | Entity → related events; explanation → contributing evidence |
| Client, user, IP and session context | Linked entity detail | Activity search, decision or event identifiers |
| Metric definition | Metrics | Policy condition or decision value → exact metric version |
| Provider | Settings → Providers | Missing capability or unavailable metric → relevant configuration |
| SDK setup and credentials | Settings → Application connection | Empty Checks state or check → Integration |

Entities get inspectable pages without a separate inventory destination. Sessions remain context within these pages. Policies belong to checks. Providers are configuration. Events and decisions share the investigation destination but retain distinct views and provenance.

## Routes and navigation state

Routes describe dashboard navigation, not public API contracts.

| Route | Content |
| --- | --- |
| `/` | Overview; time and optional check scope in the query |
| `/checks` | Check list; creation uses a name field inline |
| `/inspect/check?name=:checkName` | Active policy, or draft if never published |
| `/inspect/check?name=:checkName&view=draft` | Editable draft |
| `/inspect/check?name=:checkName&version=:version` | Immutable published policy |
| `/activity?view=decisions` | Check attempts; default Activity view |
| `/activity?view=events` | Events and client evidence |
| `/activity/decisions/:attemptId` | One logical action attempt and its explanation |
| `/inspect/event?id=:eventId` | One event and its provenance |
| `/inspect/entity?kind=:type&id=:entityId` | Client, backend-known user, session or observed IP |
| `/metrics` | Metric catalog |
| `/metrics/:metricId?version=:version` | Versioned definition |
| `/settings` | Application connection, Providers and collapsed Diagnostics |

Preserve Activity filters, search, time range and pagination in the URL. Check and entity links open this same Activity view with scope applied. Settings sections have anchors; integration links carry the check context. Evidence disclosures have stable anchors where useful. Secrets, proof tokens and form contents never enter URLs.

Use ordinary links for records and references. Back returns to the previous list, filters and scroll position. Related detail pages use a small return link or breadcrumb; do not stack drawers or open modal chains.

## Checks: the working surface

The list shows name, publication state and last activity. A draft indicator means unpublished changes exist; a published version identifies what is running. Show a text warning beside a check only when a known issue affects it. Avoid an invented overall health score.

Opening a check shows its name, active version and readable policy. Keep **Edit policy** prominent. **View activity**, **Integration** and **Versions** are secondary links. Versions expands a compact list on this page. There is no overview tab, separate policy application or permanent inspector pane.

Observed check usage belongs to filtered Activity. Overview and Activity use server aggregates over the selected interval, rather than counting the visible page. Show recorded Allow, Deny and currently Awaiting verification states. Unknown outcomes remain separate from a known denial caused by unknown evidence. Do not invent evaluation latency, missing-evidence totals or SDK fallback metrics. A check filter includes every policy version; version-specific impact requires an explicit supported filter.

### Policy editor

Use a vertical sequence of numbered **When → Then** rules followed by **Otherwise**. A matched allow or deny ends evaluation. A false condition proceeds to the next rule. Order is part of the policy and stays visible.

```text
Checks / can_claim_trial
Editing draft · Active v7                          Review and publish

1  When  [client.user_count_30d v1] [greater than] [3]
   Then  [Deny]
   If condition is unknown: [Deny]

2  When  [ip_risk v1] [greater than] [0.8]
   Then  [Require verification]
   If condition is unknown: [Deny]
   Verified → continue below
   Failed, expired or provider unavailable → deny

   Add rule

Otherwise [Allow]

Draft saved. Requests continue to use v7.
```

Expand only the rule being edited. Other rules remain readable sentences, including their unknown-data behavior. The input picker separates metrics from trusted backend inputs. A metric choice reveals its meaning, type, unit, version and missing-data semantics next to the condition. Operators and value controls follow the selected type; arbitrary customer JSON does not automatically become a typed policy input.

Start with a single condition. **Add condition** reveals **All / Any** grouping; a condition menu exposes **Not** and nested groups. These express AND, OR and NOT without a canvas, connectors or scripting. Provide move-up/down controls, grouping and removal through keyboard-accessible actions; dragging is unnecessary.

Unknown stays distinct from false. In a group, a decisive false resolves All and a decisive true resolves Any; otherwise an unresolved dependency leaves the condition unknown. Not preserves unknown. **Is known / Is unknown** conditions evaluate availability explicitly. An unresolved condition uses its visible **If condition is unknown** outcome: Deny by default, Require verification, or Continue to next rule. Continuing is an explicit policy choice, including when it can reach Otherwise Allow.

The MVP verification step has fixed, visible branches: verified → continue to the next rule; failed, expired or provider unavailable → deny. The explanation retains the specific cause. An abandoned attempt remains unresolved unless Krine records an expiry or final result. Successful verification satisfies that step only; later rules still apply. Whole-service failure uses the server SDK's separate availability policy.

New drafts start with **Otherwise Deny**. Saving a draft never activates it. Publishing reviews changes to rule order, conditions, unknown outcomes, final outcome and metric versions. See [publishing and restoration](core-flows.md#2-create-change-and-restore-a-policy).

## Overview: scan and investigate

Lead with a compact interval/check toolbar, recorded counts and one accepted-time trend. Keep the whole useful trend visible on a laptop; show protected actions and recorded reasons below it. A count, series, reason or interval link opens Activity with the exact population it counted. A conflicting zero series must not replace an active filter and broaden the result. Typed subject lookup is available beside the page introduction.

Use UTC-aligned buckets clipped to the requested and retained interval. Accessible chart data lives in a collapsed table, so hundreds of buckets do not add mandatory Tab stops. Missing retained coverage is different from a successful zero count. Record delivery is asynchronous; charts and lists are independent observations. Relative refresh advances both time bounds; copied absolute intervals remain fixed.

## Activity: one investigation surface

Default to **Decisions**, the last 24 hours and newest first. Use a **Decisions / Events** view switch, one search field and a time control. Result/check filters appear in Decisions; event name/source filters appear in Events. Additional filters stay behind a single More filters control. A short version of the same trend sits above the compact evidence table. Exact-range editing stays collapsed on a chart drilldown, with the selected interval readable beside the filters.

The search field accepts a check name, operation/record ID or exact client/user/IP identifier. Matching entities can be opened directly, including those with no activity in the selected period. Explain supported inputs in the field's help text; do not require query syntax or add a global command palette.

| View | Default columns | Record granularity |
| --- | --- | --- |
| Decisions | Time, check, result/state, subject, short reason | One logical action attempt; retries and challenge continuation stay inside it |
| Events | Time, event name, source, subject | One accepted event; duplicate submissions do not create duplicate business events |

Show Allow, Deny, Awaiting verification, Request rejected and Evaluation error as distinct text states. A rejected request has a reason such as invalid proof or missing active policy; it has no evaluated policy outcome. A reported local result reads **SDK fallback · Allow** or **SDK fallback · Deny**. If its Krine evaluation is later recovered, show the two outcomes separately within the attempt. Never present an SDK fallback as an evaluated decision.

Activity covers records Krine has received and retained. An unreachable SDK may be unable to report fallback; the absence of a record does not prove that the application did nothing. Show the last successful refresh time and any query failure. Rows change only on an explicit refresh or navigation so investigation does not move under the user.

### Decision detail

Lead with check, outcome, time and the shortest sufficient explanation:

```text
can_claim_trial → Deny
Policy v7 · Rule 1

client.user_count_30d v1 = 7
Rule denies when greater than 3.

Client cl_…    User user_…    IP …

Policy path      Evidence      Request details
```

The final line represents disclosure links below the explanation, not another tab bar. The complete policy path shows evaluated conditions, actual values, unknown causes, verification transitions and rules not reached. Evidence reveals source, observation time, freshness and retained supporting records. Request details contain operation identity, session context and diagnostic metadata; sensitive values remain redacted. Pending attempts lead with the next required verification; rejected requests and evaluation failures lead with the cause and recovery action. Do not fabricate a policy path when evaluation never ran.

Use values captured for the evaluation, linked to their exact metric definitions. Current entity values never replace historical evidence. Retention gaps read **Evidence no longer retained** while the recorded decision trace remains distinguishable from unavailable raw data. Viewing a historical policy is read-only; **Edit current policy** explicitly starts or resumes the current draft.

### Event and entity detail

An event opens with name, source, occurrence/receipt times and associated identifiers. Label **Backend assertion** and **Client evidence** explicitly. A source describes authority, not whether a reported event is desirable. Properties are an expandable read-only payload, not a schema designer.

The current entity page opens with its type and identifier, then current metrics, relationships and a recent-activity sample. This sample is not the completed behavioral investigation: the next bounded unit must preserve the originating interval, add a direct subject trend and paginated unified event/decision history, group by recorded day/session context, and keep relationships visible beside history. Related-client activity must remain distinct from the user’s own records. Context navigation remains available when history is unavailable. Current metric values carry an as-of time. Each relationship shows endpoints, provenance, authority, first/last observation and status. IP sharing and fingerprints never become a “same person” assertion. Session IDs link into filtered evidence within this context.

Relationship correction lives on the affected relationship row. Preserve the original assertion and correction history, explain the effect on future derived values and leave past decisions intact. There is no merge-identities button, graph canvas, separate cases area or generic blocklist.

## Metrics: a small reference library

The catalog shows name, one-line meaning, primitive/derived kind and current version. Search covers names and descriptions. A compact kind filter is sufficient; provider branding does not organize the catalog.

Each definition is a readable document: meaning, type/range/unit, version, examples, dependencies, provenance/provider capability, time window/freshness and missing-data behavior. Show the derivation of derived metrics in understandable terms. An observed value appears only with explicit entity or decision context, never as a supposed global value.

Policy and decision links open the version they used. A newer version is a quiet **New version available** link, with the semantic change explained. Upgrading edits a draft and requires publication; catalog updates cannot silently change running policies. Metrics remain first-class through their catalog, stable links and documentation without acquiring a separate creation workflow.

## Settings: configuration at the edge

Use a single page with three sections:

- **Application connection:** deployment URL, installed-version SDK instructions, existing credentials and minimal create/revoke controls. Check-specific integration links select the relevant example. Keep server credentials distinct from browser-safe configuration; reveal newly created secrets only in the credential flow, never in browser snippets.
- **Providers:** one row per supported capability, with implementation, configured state and last connection-test result/time. Expand a row to enter configuration, test and save it. Link to checks that depend on it. Credentials stay masked after saving. A successful connection test is not a promise of future availability.
- **Diagnostics:** collapsed by default, with relevant component errors, refresh time and deployment-configured retention information. Advanced runtime settings remain documented deployment configuration in MVP.

Show setup links where a missing connection blocks a task. Ongoing provider failure appears beside affected evidence and checks. A deployment-wide query failure warrants one persistent inline notice. Healthy operation needs no status ribbon, notification center or dashboard of component cards.

## Interaction floor

Apply the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) as an implementation checklist, subordinate to [Krine's UX principles](ux.md) for product taste. Use sentence case for Krine's quiet interface. This specification is not a UI-code compliance audit.

Use semantic links, buttons, forms and tables; labeled controls; visible unobscured keyboard focus; and text alongside result colors. Restore focus after dialogs, announce asynchronous save/error states and protect unsaved edits. Navigation state must survive links and Back. Keep reordering usable without dragging, allow zoom and paste, respect reduced motion and format dates/numbers for the locale. Show the timezone and exact timestamps on inspection. Paginate long lists and preserve full identifiers for inspection/copy. Empty, loading, stale and failed states must remain distinguishable.

## UI budget

Keep four primary destinations, one settings destination and one policy editor. Each task has one primary action. Read-only pages need none. A normal policy requires no tab changes, canvas manipulation or infrastructure tour.

Exclude standalone Policies/Providers/Entities navigation, setup wizard, decorative analytics surfaces, project switcher, policy templates gallery, onboarding tours, graph visualization, testing/replay product and permanent detail drawers. Reconsider an exclusion only when a demonstrated task cannot remain clear within these surfaces.
