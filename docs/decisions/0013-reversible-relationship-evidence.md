# ADR 0013: Reversible relationship evidence

**Status:** Accepted

## Context

Investigation must distinguish authoritative backend assertions from observed
browser context. A correction must change future applicable metrics without
rewriting old decisions, manufacturing identity, or being undone by a retry.

## Decision

Keep each backend client–user assertion under its existing immutable application
association ID. Record its authenticating server credential ID and optional
matching Krine session. Its first and last observation time are its original
acceptance time: retries are delivery recovery, not new observations. A new
assertion ID records a new backend fact, even for previously corrected endpoints.
Omitted and null session both mean no session and keep the preexisting canonical
request digest. Migration leaves unknown credential/session provenance null.

Aggregate observed IP evidence by client, session and normalized IP while that
observation segment is active. Record first/last times, authenticating browser
credential IDs, observation source and context event IDs where available. Proof
observations retain no proof bearer. Every observation advances the segment's
revision. These rows say that Krine observed a browser context at an IP; they do
not assert ownership of that IP or common identity with other users/clients.
Legacy observation provenance remains explicitly `legacy`.

An administrator corrects or restores one identified relationship with its
reviewed revision, a short reason and a stable mutation key. The existing admin
cookie/CSRF and 24-hour idempotency contract apply. Correction invalidates the
reviewed assertion or observation segment and writes a durable audit snapshot.
Restore clears invalidation while retaining the original times and evidence.
The audit records both actions and their reasons. Retrying a correction returns
its original receipt without reapplying it after a later restoration; reload the
relationship for its current state.

Correcting observed evidence closes only the observations through the reviewed
segment revision and last-observed time. A new actual observation creates a new
active segment. Restore of an older segment conflicts if another active segment
already exists for the same client/session/IP; it never overwrites new evidence.
This is evidence correction, not an IP block or a promise to suppress observations.

`client.user_count_30d@1` counts distinct users having at least one active backend
assertion accepted within the previous 30 days, including the boundary. Correction
removes only that assertion; another active assertion for the same user can keep
the count unchanged. Restoration uses the original acceptance time, so an old
assertion outside the window does not count. The derived multi-account metric
uses that exact count. IP-observation correction does not change authoritative
event counts, session/client age, proof binding, or past event facts. No asynchronous
recalculation is required: after commit, subsequent snapshots read current state.
Mutation responses therefore report `recalculation: "complete"`.

Serialize assertions, observations, corrections and relationship snapshots by a
PostgreSQL transaction advisory lock per client. The acquisition order is
operation/proof, projection coordination, client relationships, then provider
configuration. Writers of relationships acquire no projection/provider locks
after their client lock. Both exact metric count and sampled relationship context
are captured under that lock and committed with the attempt. A concurrent change
is wholly before or after this snapshot. A decision stores at most 100 immutable
backend relationship summaries, their exact total and an explicit truncation flag,
plus its current matching IP observation summary. Metadata is excluded from these
samples. Sampling never truncates the metric calculation. Historical envelopes
and analytical decision records are never updated by correction.

Relationship and correction-history reads are cursor-paginated (default 50,
maximum 100). Entity relationship lists contain only direct endpoints: a user's
assertions, a client's assertions/observations, the session's attached assertions/
observations, or the IP's observations. Shared IPs do not infer user associations.
Existing entity `associations` remains available for compatibility.

Uncorrected IP segments retain the existing 30-day last-observation expiry.
Segments ever corrected/restored and their audit are durable, including after
that window; a permanent row marker makes retention safe against concurrent
correction. Assertions and their correction audit are durable as before. Repeated
browser requests update one active row, not one new row per request. Only an
explicit administrative correction allows another segment for those endpoints.

## Consequences

One inspectable relationship model covers source evidence and correction without
a graph, destructive merges, inferred people, or permanent observation suppression.
Metric semantics remain version 1 because active/revoked and original-time restore
semantics were already documented in its catalog entry.

Migration 0006 requires writer generation 4. Stop every old server before upgrade.
The database rejects old association/observation writers and old decision/export
writers, which cannot provide this snapshot/retention contract. The migration
connection preserves the earlier generation-3 coalescing migration's upgrade path;
ordinary runtime connections always use generation 4.
