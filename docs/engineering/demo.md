# Representative demonstration

Create a separate Krine installation with fictional users and 28 days of related
events, decisions and policy history. The default has 2,000 users, 10,000 decisions
and roughly 50,000 events. Repeated visits include several actions in a session,
variable event sequences, shared networks and multiple devices.

This is historical sample data. It does not demonstrate live application
protection, successful provider calls, detection accuracy or system capacity.
Every historical record retains its synthetic marker. Current counters and
connection receipts remain truthful; providers remain unconfigured.

## Create the demo

Use the repository's Rust toolchain, Python 3, OpenSSL, Docker and Compose v2.
Reserve Docker's normal runtime memory and at least four times the dataset's byte
size plus 4 GiB of host disk. The importer also checks free storage inside the
owned PostgreSQL and ClickHouse containers. The importer uses local images;
prepare the app and the three pinned store images before creating the deployment.

Keep deployment state in a private directory that Docker can bind-mount. The
example uses a home-directory path shared with Colima; `/tmp` and macOS's default
temporary directory may not be shared. State includes secrets and copied bind
assets. The dataset is read by the host and can remain in `/tmp`.

From the repository root:

```sh
export KRINE_DEMO_ROOT="$HOME/.local/share/krine-demo"
install -d -m 700 "$KRINE_DEMO_ROOT"
docker build -t krine:demo .
docker compose -f compose.yaml pull postgres clickhouse valkey
export KRINE_DEMO_ANCHOR_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
cargo run --locked -p krine-demo -- generate \
  --output /tmp/krine-demo-history --anchor-ms "$KRINE_DEMO_ANCHOR_MS"
python3 scripts/demo.py plan --dataset /tmp/krine-demo-history
python3 scripts/demo.py create --dataset /tmp/krine-demo-history \
  --state "$KRINE_DEMO_ROOT/deployment" --image krine:demo --port 18080
```

Choose fresh output and state paths. The importer refuses existing deployments;
it never accepts a database URL or a force flag. Both the plan and the import
regenerate and verify the bundle. `create` makes an independently named project,
secrets, volumes and networks, initializes the unpublished application, stops its
writer, imports bounded chunks and verifies every row before opening the port.

Open `http://localhost:18080`. Sign in with the password from
`$KRINE_DEMO_ROOT/deployment/secrets/admin_password`. Keep this host spelling:
cookies are not port-scoped, so `localhost` separates this demo from the normal
`127.0.0.1` development installation. Use a different port if 18080 is occupied.
Only the application port is published, on loopback.

The command prints decision links for eight investigations. The dataset's
`manifest.json` includes both earlier and later examples, user links, captured
outcomes and exact counts:

| Scenario | Investigation |
| --- | --- |
| Account burst | Forty accounts share a client and IP within four minutes; follow rising backend counts. |
| Provider timeout | Distinguish unknown IP evidence from a known high-risk value. |
| Verification results | Inspect passed, failed, expired and unavailable results and their final reasoning. |
| Missing browser signal | Follow the explicit unknown route when automation evidence is absent. |
| Policy change | Compare version 1 allowing a two-user client with version 2 denying it. |
| Relationship correction | Compare old captured three-user evidence with the corrected current two-user relationship. |
| Late event | Compare occurrence time with acceptance-based five-minute counters. |
| Returning use | Follow repeated visits, related decisions, events and devices across users. |

The default seed is `krine-demo-v1`. An explicit `--seed` changes the repeatable
population and timing. `--profile ci` creates a small 40-user, 200-decision bundle
with the same scenarios and varied sessions. `--scale 1` through `--scale 10`
scales users and attempts. `--max-bytes` bounds generation (default 512 MiB,
maximum 2 GiB); larger scales may need a larger explicit budget. Chunks remain
at most 500 rows and 2 MiB regardless of scale. Generation fails rather than
exceeding its budget. The manifest distinguishes logical history, physical rows,
checks, outcomes, reasons, provenance, entities and UTC days.

New bundles use generator version 2 and include every policy default. The current
verifier also accepts untouched version 1 bundles, which can be imported into a
new owned deployment. It does not rewrite their chunks or manifests. Existing
owner records remain pinned to their original generator source; keep that checkout
for resume, including already completed imports.

## Resume or verify

A failed command preserves its private owner record, data and completed chunks.
Resume with the same source checkout, dataset and owner directory:

```sh
python3 scripts/demo.py resume --state "$KRINE_DEMO_ROOT/deployment"
cargo run --locked -p krine-demo -- verify --output /tmp/krine-demo-history
```

Identical chunks are reconciled after lost acknowledgments. Changed content,
replaced stores, new network attachments or a running import writer cause a
refusal. Investigate that condition; do not edit the owner record to bypass it.
An incomplete import cannot start the normal server. Finish the import within
24 hours of the anchor; after that window, create a fresh separate dataset and
deployment. Existing failed data is preserved.

Once complete, `resume` confirms ownership and returns the existing URL without
resetting operator edits or live activity. Stop and restart the completed demo
with its exact saved configuration; these commands preserve its container and
volume identities:

```sh
docker compose -f "$KRINE_DEMO_ROOT/deployment/compose.json" \
  -f "$KRINE_DEMO_ROOT/deployment/published.json" stop
docker compose -f "$KRINE_DEMO_ROOT/deployment/compose.json" \
  -f "$KRINE_DEMO_ROOT/deployment/published.json" start
```

The workflow never deletes volumes. Preserve the owner directory with any data
you intend to keep. Historical records expire under normal retention; generating
old history does not backdate the running server's clock.

## Verification

Use the private parent created above for the verification run's temporary state:

```sh
cargo test --locked -p krine-demo
python3 -B -m unittest discover -s scripts/demo -p 'test_*.py'
TMPDIR="$KRINE_DEMO_ROOT" python3 -B scripts/verify-demo.py --image krine:demo
```

The last command creates its own small deployment, injects lost acknowledgments
from outside the importer, checks the normal server's incomplete-import fence,
resumes, verifies exact history through authenticated HTTP, and repeats inspection
after restart. It stops only its owned containers and preserves their volumes.
This is an import/recovery check, not a throughput benchmark.
