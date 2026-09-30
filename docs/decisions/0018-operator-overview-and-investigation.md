# ADR 0018: Operator overview and investigation

**Status:** Accepted

## Context

The first dashboard made individual checks explainable but left operators to infer
changes from a small activity page. The founder requested a useful daily overview,
strong charts and clearer user-behavior investigation, while retaining Krine's
plain language and restrained layout. This supersedes ADR 0008's landing-page and
chart-deferral choices; Checks remains the protected-action concept.

Official Castle references demonstrate a useful sequence: an
[overview of activity](https://docs.castle.io/docs/overview-dashboard),
[filtered exploration](https://docs.castle.io/docs/exploring-data), and a
[user profile](https://docs.castle.io/changelog/updated-user-profile-view).
The observed hierarchy, trend-to-record pivots and nearby context inform this
workflow. They do not establish Krine capabilities or justify copying Castle's
branding, risk scores or claims about physical-device identity.

## Decision

Keep a shallow horizontal navigation and open on Overview. Show recorded check
counts, one time trend, protected actions and reasons; make typed subject lookup
reachable from its introduction. Activity shares the same analytics and interval
semantics, with a shorter plot and compact evidence rows. Use server aggregates,
not the currently loaded page, for every chart and total.

Count drilldowns preserve the counted scope and freeze the exact inclusive time
bounds. Refining a filter preserves every unrelated restriction; copied compound
scopes expose individual removal controls. Ambiguous, unsupported or conflicting
addresses stop before history requests and offer an explicit reset. Do not offer
a count link that replaces a conflicting filter. Unknown
categories without a supported selector remain descriptive. Keep dense charts
out of the mandatory keyboard path and provide exact values and links in a
semantic table disclosure. Time buckets use accepted time in UTC; readable
record times retain exact timestamps for inspection.

A relative interval remains stable while investigated; explicit refresh advances
both bounds and returns to its newest page. Absolute intervals and their page
remain fixed on refresh. Keep filters, scope and return navigation in the URL.
History is asynchronous, and each request observes it independently. Null retained
coverage is not zero traffic; queued records do not establish completeness or
queue age. Unknown outcomes, unknown-evidence reasons and currently awaiting
verification are different measures. Do not infer fraud, missing-evidence totals,
latency, prior-period improvement or policy-version impact from unsupported data.

An authenticated installation marker labels generated sample activity globally.
A coherent historical sample may be imported offline; live SDK traffic separately
proves the integration. A visual fixture is not evidence that real history works.

## Consequences

Overview and Activity are one bounded delivery unit. Its acceptance does not
complete the requested behavioral profiles. The next unit must supply direct
subject trends and a genuinely paginated, chronological event/decision history;
preserve the originating interval; group actual day/session context; place
relationships beside history; and avoid repeating the subject in every row.
Related clients provide context, not an expanded claim about a user's own actions.
Context and relationship navigation must work even when analytical history fails.
A separate Users destination needs a useful backed inventory, not an empty page.

Check-scoped trends cover all versions until a version selector is supported.
Version-specific observed impact remains required follow-up work. No synthetic
risk score, graph canvas, geographic map, extra infrastructure or chart dependency
is introduced. Security, evidence provenance and historical explanations retain
their existing contracts.
