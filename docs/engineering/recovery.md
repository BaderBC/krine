# Backup and recovery

Use this procedure for the repository's single-host Compose deployment. It takes
an outage to capture one consistent application boundary. PostgreSQL holds
configuration, credential revocations, relationship corrections, accepted
operations and replay ownership. ClickHouse holds history that PostgreSQL can no
longer reconstruct after its 48-hour reliability envelopes expire. The optional
example also holds business grants and pending work in SQLite. Recover all three
from the same boundary.

Choose how much accepted work the business can afford to lose, schedule backups
accordingly, and rehearse restoration. A backup's timestamp is not a promise of
zero data loss. Before reopening protected traffic after restoring an older
backup, reconcile the application's durable business records against Krine's
restored operation records. Never erase proof ownership, revive a revoked key, or
retry a business action with a new operation ID to make recovery succeed.

## Capture a stopped boundary

Run these commands in Bash on the Docker host, from the exact deployed checkout.
The operator needs Docker administration and enough free space for the archive.
Use the same environment file, exported overrides and Compose files used to start
this deployment. The example commands include the optional example; omit
`compose.example.yaml`, `example-ingress`, `example` and its volume if absent.
Close any external ingress and pause every customer integration writer first.

```bash
set -euo pipefail
umask 077
source_project=krine
config=/etc/krine/deployment.env
secrets_dir=/etc/krine/secrets
backup=$(mktemp -d /var/backups/krine-XXXXXXXX)
compose=(docker compose --env-file "$config" -p "$source_project"
  -f compose.yaml -f compose.app.yaml -f compose.example.yaml)
"${compose[@]}" config --format json > "$backup/compose.json"
cp "$config" "$backup/deployment.env"
cp -a "$secrets_dir" "$backup/secrets"
tar --exclude=deploy/secrets -cpf "$backup/deployment-files.tar" \
  compose.yaml compose.app.yaml compose.example.yaml deploy

git rev-parse HEAD > "$backup/revision"
"${compose[@]}" stop example-ingress
"${compose[@]}" stop example
"${compose[@]}" stop app
```

Also capture any external configuration, overrides, database password rotations,
TLS configuration and managed example credential files referenced outside the
secret directory. Check `compose.json` against the running containers: image,
mount, network and secret paths must describe the deployment actually stopped.
The file may contain private configuration; do not publish it. Never continue if
another process can still write to these stores. `docker stop` exiting
successfully does not prove a graceful application drain: inspect each writer's
`State.ExitCode` and `State.OOMKilled`, and resolve nonzero exits or an interrupted
drain before taking the boundary. The application has 30 seconds to drain; the
example container allows 35 seconds for its 30-second drain deadline.

```bash
pg=$("${compose[@]}" ps -aq postgres)
ch=$("${compose[@]}" ps -aq clickhouse)
example=$("${compose[@]}" ps -aq example)
for service in app example example-ingress postgres clickhouse valkey; do
  id=$("${compose[@]}" ps -aq "$service")
  docker inspect "$id" > "$backup/service-$service.json"
  docker inspect --format '{{.Image}}' "$id" >> "$backup/image-ids"
done
sort -u "$backup/image-ids" -o "$backup/image-ids"
python3 - "$backup" <<'PYTHON'
import json, pathlib, sys
backup = pathlib.Path(sys.argv[1])
services = {}
for path in backup.glob("service-*.json"):
    service = path.stem.removeprefix("service-")
    services[service] = {"image": json.loads(path.read_text())[0]["Image"]}
(backup / "images.override.json").write_text(json.dumps({"services": services}))
PYTHON
# Retain locally built images too; a tag alone is not a recovery artifact.
docker image save -o "$backup/images.tar" $(cat "$backup/image-ids")

docker exec "$pg" sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
  exec pg_dump -h 127.0.0.1 -U krine -d krine -Fc' > "$backup/postgres.dump"
"${compose[@]}" stop clickhouse
```

Confirm ClickHouse stopped cleanly and its volume has no running writer. Take the
*whole* stopped volume, including metadata and symlinks. Do not copy a live data
directory or only `data/`. The archive helper uses the already deployed PostgreSQL
image for GNU tar and has no network. Its source mounts are read-only; it receives
no application or database credential. Verify each volume's Compose project and
volume labels, and inspect all attached containers before running the helper.
The following assumes the default generated names; use the inspected names when
a deployment deliberately configures different ones.

```bash
helper_image=$(docker inspect --format '{{.Image}}' "$pg")
ch_volume="${source_project}_clickhouse_data"
example_volume="${source_project}_example_data"
for volume in "$ch_volume" "$example_volume"; do
  docker volume inspect "$volume"
  docker ps -a --filter "volume=$volume"
done
archive_volume() {
  docker run --rm --pull=never --network none --read-only \
    --security-opt no-new-privileges:true --cap-drop ALL --cap-add DAC_READ_SEARCH \
    --mount "type=volume,source=$1,target=/data,readonly" \
    --entrypoint tar "$helper_image" --numeric-owner --acls --xattrs -cpf - -C /data .
}
archive_volume "$ch_volume" > "$backup/clickhouse.tar"
archive_volume "$example_volume" > "$backup/example.tar"
(cd "$backup" && sha256sum postgres.dump clickhouse.tar example.tar images.tar \
  deployment-files.tar deployment.env compose.json images.override.json service-*.json > SHA256SUMS)
chmod -R go-rwx "$backup"
```

Validate the archive catalog and checksums before restarting the source:

```bash
docker run --rm -i --pull=never --network none --read-only --cap-drop ALL \
  --entrypoint pg_restore "$helper_image" --list < "$backup/postgres.dump" \
  > "$backup/postgres-catalog.txt"
tar -tf "$backup/clickhouse.tar" > "$backup/clickhouse-catalog.txt"
tar -tf "$backup/example.tar" > "$backup/example-catalog.txt"
(cd "$backup" && sha256sum -c SHA256SUMS)
```

Encrypt the complete backup, including secrets,
before copying it to separately protected off-host storage. Store the encryption
key separately and test its recovery. Hashes detect corruption; they do not
authenticate an untrusted backup. Restore only backups from a trusted operator:
PostgreSQL dumps can execute source-defined SQL and volume archives contain
filesystem objects. Once the backup has completed and been checked, restart the
source stores and writers with the original configuration, then reopen ingress.
A local archive on the same disk is not protection against host or disk loss.

## Restore into a new deployment

Keep the old deployment and volumes intact. Reserve a new project name, separate
host ports and an unused example subnet. Restore behind closed ingress. Never
point a restore command at an existing deployment, and never use `--clean` or
remove a volume to force it through. Start with the recorded image IDs, matching
CPU architecture, deployment files and private secrets; upgrade separately after
a successful recovery.

1. Decrypt into an owner-only directory and verify `SHA256SUMS`. Load
   `images.tar` with `docker image load`. Recreate the deployment configuration
   from `compose.json`, including exact image IDs for **all** services. Use the
   restored secret files and bind-mounted deployment files. Preserve the public
   origins for production; the closed recovery environment must route those
   origins only to the target. Check the generated configuration before starting
   anything.
2. Require that the target project has no containers, networks or volumes, and
   that every named target volume is absent. Check both resource names and
   `com.docker.compose.project` labels; reject external volumes. Compose's project
   name alone does not make a custom/external volume safe. Run
   the following explicit target command from the restored deployment directory.
   Prepare `target.env` with the reviewed target secret paths, ports, origins and
   subnet; use all required deployment overrides, with `images.override.json`
   last. `create` creates stopped containers and new empty volumes.

   ```bash
   target_project=krine-recovered
   target=(docker compose --env-file target.env -p "$target_project"
     -f compose.yaml -f compose.app.yaml -f compose.example.yaml
     -f "$backup/images.override.json")
   "${target[@]}" config --format json > "$backup/target-config.json"
   "${target[@]}" create --no-build --pull never
   ```
3. Verify all target containers remain stopped. Verify each mounted data volume
   has the expected project/volume labels and no additional attached container.
   Restore ClickHouse and, when present, the entire example volume using the
   helper below. It refuses a nonempty destination. Preserve SQLite WAL/SHM files
   with the database, private accounts and operation outbox. Do not initialize or
   launch the example first.

```bash
# Set these from the reviewed target configuration, never the source.
target_project=krine-recovered
restore_volume() {
  docker run --rm -i --pull=never --network none --read-only \
    --security-opt no-new-privileges:true --cap-drop ALL \
    --cap-add DAC_OVERRIDE --cap-add CHOWN --cap-add FOWNER \
    --mount "type=volume,source=$1,target=/data" \
    --entrypoint sh "$helper_image" -c 'test -z "$(ls -A /data)" && \
      exec tar --numeric-owner --same-owner --same-permissions --acls --xattrs \
      --delay-directory-restore -xpf - -C /data'
}
restore_volume "${target_project}_clickhouse_data" < "$backup/clickhouse.tar"
restore_volume "${target_project}_example_data" < "$backup/example.tar"
```

4. Start **only** PostgreSQL and wait for its authenticated health check. Its
   initialization creates the restricted `krine` owner and an empty database from
   the restored passwords. Confirm there are no application tables. Restore the
   whole custom dump as that owner; fail the transaction on any error. Do not run
   the application before this succeeds: its migrations and bootstrap import
   belong after restoration, not before it.

```bash
"${target[@]}" up -d --no-deps --no-build --pull never --wait postgres
target_pg=$("${target[@]}" ps -aq postgres)
tables=$(docker exec "$target_pg" sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
  exec psql -h 127.0.0.1 -U krine -d krine -Atqc \
  "SELECT count(*) FROM pg_tables WHERE schemaname=current_schema()"')
[ "$tables" = 0 ]
docker exec -i "$target_pg" sh -c 'PGPASSWORD="$(cat /run/secrets/postgres_password)" \
  exec pg_restore -h 127.0.0.1 -U krine -d krine --no-owner --no-acl \
  --single-transaction --exit-on-error' < "$backup/postgres.dump"
```

   `--no-owner --no-acl` uses the repository's freshly initialized `krine`
   owner; installations with additional roles or custom grants must restore those
   separately under operator review. Keep all credential tables, permanent
   bootstrap markers, migration checksums, operation/proof ownership and
   relationship audit records intact.
5. Start **new empty Valkey**, restored ClickHouse and then the matching Krine
   application. Never restore Valkey's old AOF/RDB into this target. Krine creates
   a new projection generation and rebuilds current counters from retained
   durable envelopes before readiness. Old browser/session credentials cease to
   work; applications obtain new context. This is independent of the passage of
   a proof's normal 60-second expiry. Recorded operations and their unique proof
   ownership remain recoverable from PostgreSQL, even after the initial proof
   expires. A pending challenge keeps its original five-minute deadline.
6. Check readiness and error logs. Through private ingress, verify the saved
   configuration, active and revoked credentials, a historical record older than
   the PG outbox, an immutable decision, relationship correction history, an
   exact recorded-operation retry and rejection of that proof under another
   operation. Exercise a new authoritative event and check, and confirm missing
   data is not reported as safe. If the example is included, restart it from its
   restored volume and verify one saved business grant remains one grant across
   retry. Complete business reconciliation for any records accepted after the
   backup boundary, then deliberately reopen traffic.

If any restore step fails, leave ingress closed and retain the failed target for
inspection. A partially restored target is not an empty target. Use another new
project for the next attempt; do not layer another restore over it.

## Repeatable release verification

Run the repository's disposable rehearsal with reviewed, already-built images:

```sh
python3 scripts/verify-recovery.py \
  --image krine:reviewed \
  --example-image krine-protected-app:reviewed \
  --ingress-image krine-example-ingress:reviewed
```

It needs Docker, Compose 2.24.4+, Python 3.11+, the pinned store images already
available locally, unused ports 39080/34000 and subnet `10.203.85.0/24` (all three
are configurable). On Docker VMs that do not share the system temporary
directory, pass `--artifacts-parent` pointing to an existing private, Docker-shared
directory. Explicit `--postgres-image`, `--valkey-image` and `--clickhouse-image`
can select reviewed local copies when a disconnected daemon lacks the pinned
manifest aliases. Every service is resolved to its immutable image ID before
resource creation; ordinary CI uses the pinned Compose defaults. It runs source and target sequentially, uses the same browser
origins, and makes no provider verification request. It exports all six exact
service images, checks their archive manifest/config hashes and architecture,
and records an archive checksum. The image export is roughly 1–2 GB; the runner
reserves room for Docker’s temporary copy and maintains a 4 GiB free-space floor
in addition to the image estimate. The local rehearsal uses those images already
present in Docker. It does not delete/reload them or claim to test import on a
clean host. The synthetic provider configuration only proves that a pending attempt and its original deadline
survive. The complete snapshot/restore must finish within five minutes to verify
that pending state and current counter window without changing any clock.

The fixture creates fresh managed credentials, revokes bootstrap keys, records
an authoritative decision, corrects/restores relationships, and grants one trial
through the actual ingress. It ages one exported test event to 72 hours and
removes only that acknowledged test envelope from PostgreSQL; it does not claim
to have waited three days. Restoration must recover that event from the whole
ClickHouse archive. Exact retries, proof ownership, fresh context, current
exact counter rebuilding, saved audit and business idempotency are checked through
the running API. The counter oracle uses retained PostgreSQL event identities and
acceptance timestamps at the metric’s own observation time, including both ends
of its five-minute window; it does not copy the source Valkey counter. Both the
restored counter and the new decision’s counter must match exactly. If the restored ingress observes a different peer address, new
actions use that actual observation; recorded operations keep their original IP. The source is reopened briefly for read-only comparison, proving
target-only writes did not affect it.

Output names an owner-only evidence directory. The private transcript and
`expected.json` can contain credentials/proofs; never publish them. `result.json`
contains the non-secret outcome, timing evidence and archive hashes. Both projects
stop at exit and their owned containers/networks are removed;
source and target volumes and the evidence directory remain for independent
review. Delete only the named disposable resources after that review. An
interrupted Docker daemon or failed stop can leave owned containers running; the
script reports failure and never broadens cleanup to other projects. No success
record is written until cleanup has completed.

The storage choices follow PostgreSQL's [custom-format dump](https://www.postgresql.org/docs/17/app-pgdump.html)
and [transactional restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
contracts and ClickHouse's [filesystem backup alternatives](https://clickhouse.com/docs/concepts/features/backup-restore/alternative-methods).
The stopped whole-volume procedure is Krine's operational choice for this
single-host layout; it requires no new application privileges or backup service.
