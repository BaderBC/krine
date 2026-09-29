# ADR 0015: Query-addressed identifiers

**Status:** Accepted

## Context

Krine accepts `.` and `..` as check names, event IDs and backend association IDs.
User IDs also permit Unicode and reserved URL characters. Browsers and WHATWG
URL clients remove dot path segments, including percent-encoded dots, before a
request reaches the server. Path escaping alone cannot address every valid ID.
Rejecting those IDs would invalidate accepted requests and stored evidence.

## Decision

Add admin lookup routes whose identifiers are explicit query parameters. Keep
all existing path routes. `/v1/admin/lookup` is a separate namespace; it does not
reserve a previously valid check, event, entity or relationship identifier.
The [protocol](../engineering/protocol.md#query-addressed-identifiers) defines
selectors and matching resources.

Decode query values once using normal URL query decoding. Require each selector
exactly once, reject duplicate or unknown parameters, and apply the existing
logical identifier validators. Literal `%2e` is a literal user ID, distinct from
`.`. No prefix or double-decoding convention is introduced.

Lookup handlers delegate to the existing resource handlers. Their authentication,
CSRF, revision checks, payloads, responses and audit behavior stay identical.
Mutation identity is the logical action and target, not the route spelling:
replay through either alias returns the same receipt; reusing that key for another
target conflicts. Existing stored mutation digests need no migration.

Dashboard links use `/inspect/check?name=…`, `/inspect/event?id=…` and
`/inspect/entity?kind=…&id=…` consistently. Existing deep links remain readable.
View, pagination and investigation-return changes preserve the selectors and
unrelated navigation context. Newly reviewed mutations persist query addressing
before dispatch. Already persisted mutations replay their exact old path, body
and key; changing the route is never an implicit recovery migration.

## Consequences

Every accepted identifier remains inspectable without rewriting stored facts or
adding identifier-specific UI branches. The additive aliases reuse existing
business logic. A legacy dot-path request that never reached its target cannot
be repaired by silently changing its persisted intent; callers can explicitly
review a new query-addressed request after resolving the old attempt.
