# ADR 0019: Isolated representative history

**Status:** Accepted

## Context

Operators need substantial, coherent history to investigate trends and follow a
user's behavior. Sending backdated timestamps through live APIs would not create
historical acceptance times and would misrepresent current counters, provider
observations and proof verification. Importing directly into an existing
installation risks overwriting customer data and manufacturing connection health.

## Decision

Provide an offline Rust generator and a separate, guarded importer. The generator
uses `krine-core` policy evaluation and shared captured-reason construction. It
creates fictional history, related entities, immutable policy versions and a
relationship correction from a deterministic timeline. It does not create
runtime proofs, credentials, pending operations, receipt markers or hot counters.
Historical provider and verification results are explicitly synthetic evidence;
no production adapter or trust boundary gains a demonstration bypass.

The public seed, explicit UTC anchor, generator version and workload dimensions
identify the dataset. Canonical chunks are bounded by both 500 rows and 2 MiB.
The manifest records hashes, exact counts, byte use and investigation examples.
Verification regenerates the dataset and compares every artifact byte for byte.
A changed historical generation contract requires a new generator version.

Each event and decision carries top-level `sample_data` identity separately from
its original browser/backend provenance. The importer creates its own random
Compose project with private secrets, immutable local image IDs and labeled,
newly owned volumes and networks. It never accepts database URLs, existing
projects, replacement imports, a force flag or a deletion option. It pins the
Docker daemon, container, volume, network and file identities for resume and
rejects extra writers, mounts, store ports or network attachments.

The application first starts without a published port to run normal migrations,
then stops gracefully. The importer claims a durable singleton only after proving
the application tables and historical stores are empty. PostgreSQL chunk rows and
their acknowledgments commit together. A ClickHouse acknowledgment can be lost;
resume reads exact revision/payload content before replaying an identical chunk.
The fixture stores final decision revisions with their captured verification
transitions, since ReplacingMergeTree may compact older revisions at any time.

Only a complete read-back of both stores and the logical ledger sets the durable
completion timestamp. An incomplete singleton prevents normal server startup.
The importer then publishes the dashboard on loopback using `localhost`, separate
from the ordinary `127.0.0.1` development cookie namespace. Authenticated read-only
`GET /v1/admin/installation` exposes public sample metadata; normal installations
return null. There is no HTTP setter.

## Consequences

An interrupted import remains resumable with its unchanged bundle, owner record
and original generator source. Unexpected content or resource identity changes
stop the workflow and preserve evidence rather than attempting repair. There is
no cross-store transaction: stopped writers, exact read-back and the startup
fence provide the publication boundary.

History ends at least ten minutes before the anchor and uses ordinary retention.
Imports require an anchor from the previous 24 hours so all 28 days fit the default
30-day window. Current entity metrics and connection receipts describe actual
runtime state; they are not fabricated to match historical snapshots. Providers
remain unconfigured. A copied demo does not demonstrate application integration,
current protection, throughput, latency, detection accuracy or fraud ground truth.
Real SDK load and capacity tests remain separate workflows.
