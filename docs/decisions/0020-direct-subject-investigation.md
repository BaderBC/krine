# ADR 0020: Direct subject investigation

**Status:** Accepted

## Context

Investigating a user requires seeing events and check attempts together in their
original context. Two recent lists obscure sequences and stop after 20 records.
Current entity detail also waits for analytical history before returning durable
metadata and live metrics, hiding useful context during a ClickHouse outage.

## Decision

Add one query-addressed, exact typed-subject timeline and one independent entity
context read. The [protocol](../engineering/protocol.md#subject-investigation)
defines their bounded inputs, summaries, coverage and cursor semantics. Keep all
existing successful entity and Activity responses compatible.

Read latest delivered `(kind,id)` records from the existing versioned history table
before applying subject or time predicates. Sort by accepted time and stable record
kind/ID ties. Preserve claimed event occurrence time separately. Reuse captured
decision summaries, scalar columns, retention floor, bounded analytical admission
and query budgets. Give summaries a 2 MiB result bound because captured explanations
are larger than aggregate counts. Failed or incomplete reads never become empty
history. Delivery metadata remains installation-wide and is not a watermark.

Use exact direct attribution. Relationships are explicit navigation paths and
reversible evidence, never an instruction to silently union another subject's
activity. The current session ID supports understandable visible grouping without
a new session store or claims that a page is a complete session. Missing legacy
provenance remains unknown rather than gaining backend authority.

Reuse the existing scope-digest cursor approach. A cursor binds requested subject
and interval but is not a signed capability; independent predicates enforce every
read's authorized scope. Avoid introducing a signing-key lifecycle for a read
position that cannot grant access. Pages are not snapshots across revisions,
late delivery, reused event IDs or advancing retention.

Extract the existing PostgreSQL/live-metric context read without changing its
successful legacy result. The additive context endpoint returns its actual metric
observation timestamp and performs no analytical query. Current context, direct
relationships, a trend and a timeline can therefore report failures independently.

Validate encoded admin queries at one authenticated boundary before Axum's form
extractors. Those extractors otherwise replace invalid UTF-8, allowing malformed
input to select a different valid U+FFFD subject. Reject invalid percent escapes
and UTF-8; preserve valid Unicode and existing selector validation.

Track submitted analytical reads independently of their caller, retaining local
permits through completion or the existing ten-second handler deadline, including
preparation. Each dependency HTTP request retains its five-second deadline. Reuse two
process-random slot query IDs with replacement explicitly disabled. Pinned
ClickHouse registers/checks IDs under its process-list mutex and removes them only
when the execution entry is destroyed. Thus an ambiguous timeout does not permit
a new overlapping read in the same slot. Do not infer server cancellation from a
dropped HTTP future. No query-kill grant or additional infrastructure is needed.
Close admission and drain tracked jobs during graceful shutdown. New processes
have new IDs; this deliberately remains a per-process bound, not a fleet-wide or
cross-restart admission controller. Existing ClickHouse execution limits still
apply to work whose completion could not be observed.

## Consequences

An operator can follow one subject across a bounded interval without losing record
provenance or captured decisions. The dashboard can retain context during history
outages and progressively disclose record detail. No database migration, identity
inference, session analytics service, new dependency or history copy is needed.
The identity-oriented history layout still limits pruning; query budgets are not
a large-installation latency guarantee.

Source: pinned ClickHouse [ProcessList.cpp](https://github.com/ClickHouse/ClickHouse/blob/v26.8.11.7-lts/src/Interpreters/ProcessList.cpp).
