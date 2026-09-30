# Self-hosted deployment

Krine runs as one Axum application serving both the API and dashboard, with PostgreSQL, ClickHouse and Valkey on a private Docker network. `compose.yaml` defines storage; `compose.app.yaml` adds the application and its ingress/outbound network. This is a persistent single-host deployment, not a high-availability cluster.

## Complete local application

Run `./scripts/up.sh --local` from the repository root. The helper builds the production image, generates missing secrets, stops the previous application before any migration, and starts the complete stack. The local preset in `deploy/local.env.example` serves `http://127.0.0.1:8080`, permits the browser application origin `http://localhost:3000`, and explicitly enables HTTP development cookies. Shell variables can override its port, origins and secret directory.

On first use, enroll a named Admin with `deploy/secrets/admin_password`, save its generated credential, then sign in by name. After enrollment, use the individual credential; restarting does not reopen enrollment. The independent `browser_public_key` is public browser configuration; `server_secret` belongs only on application backends. Never include the latter or an operator credential in a browser bundle.

Inspect or stop this local stack without removing data:

```sh
docker compose --env-file deploy/local.env.example -f compose.yaml -f compose.app.yaml ps
docker compose --env-file deploy/local.env.example -f compose.yaml -f compose.app.yaml down
```

Keep any shell overrides consistent across these commands. Do not use `down --volumes` unless intentionally deleting a disposable installation.

## Protected application example

`./scripts/up.sh --local --example` adds the optional [trial application](../../examples/protected-app/README.md#run-with-docker). It requires Compose 2.24.4 or newer. `compose.example.yaml` removes the direct application port, publishes both loopback ports through a pinned Nginx ingress, and adds a separate `example_ingress` network. The original storage and application networks keep their configuration. Only Krine joins storage. The ingress also joins `application` for published-port access; the example stays on the internal network. Both ingress and example address Krine through its private-network-only `trust-backend` alias, so the proxy connection always comes from the trusted address. Only the ingress's exact `${KRINE_EXAMPLE_NETWORK_PREFIX}.2/32` is trusted by Krine and the example; the ingress overwrites forwarding headers with its socket peer. The local preset does not trust any preceding proxy.

The example image uses the same pinned Node 24 LTS base and pnpm version as the dashboard build. Its entrypoint reads only the browser/server credentials and initializes an empty named data volume as UID/GID 10001, mode 0700. Startup capabilities are `CHOWN`, `DAC_READ_SEARCH`, `SETUID` and `SETGID`; dropping UID clears all runtime capabilities. Node then owns PID 1 with a read-only root filesystem and `no-new-privileges`. Its root-only `/run/secrets` parent prevents further file access after dropping privileges, including with permissive host file-sharing mappings. Existing data directories with unexpected ownership or permissions fail startup. Private SQLite, account passwords, grants and the event outbox survive recreation in `example_data`. The example never receives database or operator secrets. Optional `KRINE_EXAMPLE_PUBLIC_KEY_FILE` and `KRINE_EXAMPLE_SERVER_SECRET_FILE` select its managed credentials independently of the core bootstrap files; their defaults preserve the initial setup. Docker/host administrators remain trusted and can read mounted secrets and process environments.

Stop ingress and the example gracefully before backing up the entire named data volume; preserve any SQLite WAL files alongside the database. Restore it together with compatible Krine state, and reconcile grants accepted after the backup before reopening traffic. The example supports one process per private local volume, enforced by SQLite's OS-backed exclusive lock. Its 35-second container stop period allows the application's 30-second drain deadline.

The ingress image pins `nginx:1.30.5-alpine-slim` to manifest `sha256:32463212baf0e7d91aded2e9b843a4f2b9e017804b8c9d5bae7b51dcef64389c` ([official image metadata](https://github.com/docker-library/repo-info/blob/master/repos/nginx/remote/1.30.5-alpine-slim.md)). It runs as UID/GID 101 without capabilities, uses a bounded temporary filesystem, resolves recreated upstream containers through Docker DNS, and never retries a proxied request automatically. [Nginx header replacement](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) supplies the observed client address; [Compose port reset](https://docs.docker.com/reference/compose-file/merge/#reset-value) prevents bypassing this boundary.

## HTTPS deployment

Install Docker Engine with Compose v2 and OpenSSL. Copy `deploy/.env.example` to `.env`, set `KRINE_PUBLIC_URL` to the exact HTTPS origin at which Krine will be served, and set `KRINE_ALLOWED_ORIGINS` to the exact browser application origins. Keep `KRINE_DEVELOPMENT=false`. Use an owner-only secrets directory outside the checkout by setting `KRINE_SECRETS_DIR` to its absolute path. Then run:

```sh
./scripts/up.sh
```

Only `127.0.0.1:8080` is published by default. Run a TLS reverse proxy on the same host and forward the entire origin to that port, preserving request paths, the `Host` header and browser `Origin`. The dashboard and `/v1/admin` must remain on the same origin; do not host the SPA under a URL path prefix. The image serves known assets directly and returns `index.html` for HTML dashboard navigation. Missing assets and API/health routes remain errors. Dashboard responses include a restrictive content security policy and prohibit framing.

For a single [Nginx ingress](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header), configure the HTTPS virtual host with your certificate and this location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 15s;
}
```

The ingress must overwrite client-supplied forwarding headers. Set `KRINE_TRUSTED_PROXIES` only to the proxy source address **as seen by the application**, which can be the Docker bridge gateway for a host proxy. Inspect the deployment's network routing to determine it; do not assume it is `127.0.0.1`. For a containerized proxy, attach only that proxy and Krine to a dedicated network, give the proxy a stable address, and trust that exact `/32` or `/128`. Never trust `0.0.0.0/0`, `::/0` or arbitrary browser networks. A proxy that is not trusted causes Krine to observe its IP; browser proofs then cannot bind correctly to the backend's independently derived client IP. If there are multiple trusted ingress hops, sanitize their chain and list only those hops. Krine walks the chain from the trusted TCP end to the first untrusted address.

Terminate HTTPS at the ingress, enable its certificate renewal, and redirect HTTP to HTTPS there. Restrict host/Docker administration and the loopback service to trusted operators. Database traffic stays within the single-host network; using remote stores requires authenticated TLS and private routing.

The image keeps `/run/secrets` root-owned with mode 0700. This parent directory prevents runtime access even when a host file-sharing layer maps individual secret permissions permissively. The entrypoint briefly uses root with `DAC_READ_SEARCH` to read owner-only mounted secrets even when Linux preserves a different host UID, plus `SETUID`/`SETGID` to replace itself with the application as UID/GID `10001`. That identity change clears the capabilities; the application has a read-only filesystem, no Linux capabilities and `no-new-privileges`. `SIGTERM` drains requests and stops its worker within Compose's 30-second grace period. The health check calls `/health/ready`; analytical export can lag while checks remain available. The image bundles CA certificates for provider HTTPS.

## Local development

Install Docker Engine with Compose v2 and OpenSSL. Allocate at least 4 GB of RAM to Docker for these services; allow additional memory for application builds. On macOS, start your Docker VM first.

From the repository root:

```sh
./scripts/dev-up.sh
docker compose -f compose.yaml -f compose.dev.yaml ps
```

The script creates seven independent random secrets in `deploy/secrets/`, preserves existing values, and waits for storage health checks. Secrets are excluded from Git and Docker build contexts. Keep the directory: recreating secrets does not rotate passwords in an existing PostgreSQL volume.

| Service | Host endpoint | Database / user | Secret file |
| --- | --- | --- | --- |
| PostgreSQL | `127.0.0.1:15432` | `krine` / `krine` | `postgres_password` |
| Valkey | `127.0.0.1:16379` | database `0` / `krine` | `valkey_password` |
| ClickHouse HTTP | `http://127.0.0.1:18123` | `krine` / `krine` | `clickhouse_password` |

PostgreSQL's separate `postgres_admin_password` is for administration, never for the application. The `krine` role owns its database and can run migrations; it has no superuser, role-creation, or database-creation privileges.

Valkey disables the default user. Authenticate as `krine` (for example, `redis://krine:<password>@127.0.0.1:16379/0`). Its ACL allows only the implemented key operations and Lua scripts against `krine:*`, connection setup, and `INFO server` for restart detection. Configuration, flush, key enumeration, and administrative commands are denied. Maintenance that needs broader access requires an operator to change the container configuration; the application credential cannot administer the server.

ClickHouse disables its anonymous default user. The application identity can select, insert, create, alter, and drop tables within `krine` only. It cannot create databases, manage users, control the server, or use external-source table functions. A loopback-only bootstrap identity creates the database and reconciles owned ClickHouse diagnostic tables during startup; it is removed before the network listener starts. The health check connects through the container network address, so the temporary bootstrap server cannot report ready.

These ports bind only to IPv4 loopback. If one is occupied, set `KRINE_POSTGRES_PORT`, `KRINE_VALKEY_PORT`, or `KRINE_CLICKHOUSE_PORT` before running the script. `deploy/.env.example` documents optional Compose settings; Compose loads a repository-root `.env` automatically, or accepts an explicit `--env-file deploy/.env`.

Stop containers while retaining data:

```sh
docker compose -f compose.yaml -f compose.dev.yaml down
```

Start them again with `./scripts/dev-up.sh`. Named volumes survive container replacement. `down --volumes` permanently deletes this stack's storage; use it only when intentionally resetting disposable development data. A different Compose project name creates separate containers, networks, and volumes.

## Secrets and service boundaries

`compose.yaml` exposes no host database ports. Its storage network is internal. `compose.dev.yaml` makes that network a regular Docker bridge and adds loopback database access for host development; omit it on a server. The application joins storage and a separate regular network for ingress and outbound provider requests. Within storage, it uses `postgres:5432`, `valkey:6379`, and `clickhouse:8123`.

Optional application examples can join the Compose network key `application` and call `http://app:8080` from their backend. Its [generated Docker network name](https://docs.docker.com/compose/how-tos/networking/) is `<compose-project>_application` (`krine_application` by default); use the Compose key when extending this project rather than hard-coding the generated name. Examples must not join `storage`. Browser SDK requests use the published public origin. For local proof binding, place both application HTTP services behind the same ingress path and verify that they observe the same browser IP. Mixing a host-native backend with Docker-published Krine can produce different loopback/gateway addresses; never substitute a fabricated IP to make a check pass.

[Compose mounts local secret files](https://docs.docker.com/compose/how-tos/use-secrets/); it does not encrypt them. Keep the host directory owner-only, protect host and Docker administrator access, and include secrets in your encrypted recovery plan. The initialization helper requires one line of 64 hexadecimal characters per secret and never replaces an existing value. It refuses symlinked secret files. Secret files must be readable by container root. Use Docker's normal rootful mapping or arrange equivalent access when using rootless/user-remapped engines.

The application receives only its own database passwords and three independent bootstrap credentials. PostgreSQL's administrative password is never mounted in the application. Changing files does not rotate passwords already stored in database volumes. Coordinate database password changes with service configuration and preserve valid credentials during the transition.

Browser and server application credentials are imported into PostgreSQL once.
Rotate them through the authenticated credential API; changing their bootstrap
files or restarting cannot restore revoked credentials. Preserve the credential
rows and permanent bootstrap marker in backups. When upgrading from
environment-only authentication, stop every old application process before
starting the upgraded service; old binaries cannot honor durable revocation.
The installation enrollment/recovery secret remains operator-provisioned environment/file input. Daily access uses named operators and their generated credentials; migration 0009 retires shared sessions and requires first named enrollment.

## Upgrade

Back up before an upgrade. Review new migrations and dependency notes, fetch the reviewed release, then run `./scripts/up.sh` with the same configuration and secret directory. The helper builds first, stops the old application, and only then starts the new image; stores remain running. Do not run old and new application writers together during a schema change. PostgreSQL migrations run before the new listener opens. Restarting a container uses the same image and does not rebuild it.

History migration from the initial runtime to provider-capable history adds monotonically revisioned records and backfills legacy history once. Old application writes are rejected by the PostgreSQL generation guard after that migration. Migration 0006 advances the writer guard to generation 4 so older processes cannot bypass relationship snapshot locking or delete corrected observation evidence. Migration 0007 requires generation 5 for observed receipt coverage and shared analytical retention. Stop all older writers before starting it; the database guard does not prevent an old process from attempting ClickHouse DDL. Reverting only the image is not a supported database downgrade; restore a tested compatible backup if a migration must be rolled back.

## Analytical retention

Set `KRINE_HISTORY_RETENTION_DAYS` in deployment configuration to retain analytical events and decisions for 2–3650 days; the default is 30. Use the same value on every application replica. Startup writes this target to PostgreSQL, and all running replicas read it there. Change the fleet configuration together and restart with the new value; differing startup values can replace each other's target.

Shortening retention immediately hides older records through the API. PostgreSQL supplies the clock and a durable expiry boundary, so a later increase cannot reveal expired records even when physical deletion or outbox delivery was delayed. On upgrade, an extension waits for existing rolling ClickHouse TTLs to be safely retired. Activity and Application connection report effective `days`, `requested_days`, `applying` and `available_since`; the latter may be more recent than the requested window after an increase. Once retirement completes, changes become effective at configuration commit, including during analytical outages. Increasing the target grows future coverage; it does not restore history.

Physical deletion is asynchronous, scheduled every four hours after the previous cleanup completes. It may lag during outages or large rewrites, without delaying decisions or history delivery. Keep disk headroom for retained data, delayed exports and cleanup rewrites. The ClickHouse service revision label makes normal `up.sh`/`dev-up.sh` upgrades recreate that service with its existing volume, applying the narrow mutation-status grant from the updated entrypoint. Do not edit the owned history tables or their retention settings directly.

This setting does not shorten operation/proof retry protection, delete unexported delivery records, change 30-day metric semantics, or remove durable relationship corrections. Receipt markers retain only record IDs, timestamps and coverage basis after the underlying history expires. See [ADR 0014](../decisions/0014-observed-connection-and-history.md).

## Durability and capacity

PostgreSQL stores durable relational state. Valkey uses append-only persistence with `appendfsync always`; its security state must not be discarded as though it were an ordinary cache. Its 256 MB memory ceiling uses `noeviction`, so exhausted capacity returns write errors instead of silently deleting proofs or counters. The container allows 512 MB for persistence overhead. The application must surface failed security-state writes as unavailable evaluation. Increasing capacity requires adjusting both limits in deployment configuration.

ClickHouse uses its own persistent volume for history. Its memory ceiling is 2 GB, PostgreSQL's is 1 GB, and container logs rotate at three 10 MB files. These defaults support a small installation, not an unmeasured throughput promise. Watch disk space, out-of-memory kills, Valkey rejected writes, database latency, and application errors. Health checks make authenticated queries as the application identities; they do not prove backups or application correctness.

The shipped configuration retains current query and crash diagnostics for seven days by event timestamp. Query logs flush every 60 seconds or at the bounded buffer threshold; a crash can lose unflushed query diagnostics. High-frequency metric, trace, part, text and unused integration log collectors are disabled. Warning/error console output still rotates through Docker. The application's `system.user_query_log` exposes its own query history without granting access to all diagnostic tables. Live ClickHouse metrics/errors remain available to separately authorized operators; the application credential receives no diagnostic maintenance grants. These operational logs are separate from Krine's application events and decision history.

Upgrading recreates the ClickHouse container because its diagnostic revision label changes, preserving `clickhouse_data`. During loopback-only initialization, ClickHouse prepares the canonical `system.query_log` and `system.crash_log` tables. It may first rename incompatible definitions, including operator-customized canonical tables, to numeric archives. Rotation preserves their rows and comments, but can mark non-replicated MergeTree archives without a TTL read-only. This upstream preparation happens before the helper's metadata filter.

The helper then gives recognized query/crash archives the seven-day TTL, preserving recent rows, and intentionally drops recognized disabled debug logs and their numeric archives. Recognition requires an exact upstream base name or numeric suffix, the MergeTree engine and its pinned identifying comment. The helper leaves unrecognized objects unchanged and never touches `krine` tables. Custom archives skipped by that filter retain their existing retention, including no TTL; they are not automatically bounded to seven days. Operators remain responsible for their retention and read-only settings. Export any debug diagnostics needed for an investigation before this upgrade; keep the normal backup as well.

Archive TTL changes persist once, including their materialization mutation. The normal server restart starts workers for previously read-only archives; physical expiry is asynchronous. Interrupted initialization remains unavailable and retries on restart without repeating completed mutations. The bootstrap's temporary, log-family-scoped maintenance privileges are removed before network readiness. See [ADR 0016](../decisions/0016-bounded-clickhouse-diagnostics.md) for the retention and upgrade boundary. CI exercises fresh and retained-volume startup, exact expiry boundaries, interrupted upgrades, application privilege denial and unrelated-table preservation with `python3 scripts/check-clickhouse-diagnostics.py` in its own disposable ClickHouse container.

On a production Linux host, set `vm.overcommit_memory=1` for Valkey's persistence forks and review its startup warnings. This is a host-wide setting; the stack deliberately does not modify it. Docker VMs may also report ClickHouse thread or delay-accounting limitations. Size and tune a production host using measured workload and upstream operating guidance.

Volume persistence does not protect against host or disk loss. Follow the
[backup and recovery procedure](recovery.md) to capture PostgreSQL, stopped
ClickHouse history, private configuration and, when used, the example's complete
SQLite volume at one stopped application boundary. It includes concrete restore
commands and a disposable end-to-end recovery rehearsal. Choose a recovery point
objective that accounts for accepted operations and reconcile business records
before reopening an older backup. Restore into a new deployment with empty
Valkey; preserve durable replay ownership and credential revocations.

The backend owns application schema migrations. Container initialization creates storage identities and maintains the explicitly owned ClickHouse diagnostic logs; it never migrates or deletes application history.

## Dependency updates

Images are pinned by version and multi-platform manifest digest in `compose.yaml`:

| Dependency | Version | Manifest digest |
| --- | --- | --- |
| PostgreSQL | `17.11-bookworm` | `sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652` |
| Valkey | `8.1.10-alpine` | `sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507` |
| ClickHouse | `26.8.11.7` LTS | `sha256:741c97b58cc8fef0f4958ba302c4a3c2d66ffa2f0bfe35b57dff31700d62cf11` |

These were selected from the supported [PostgreSQL releases](https://www.postgresql.org/support/versioning/), [Valkey releases](https://valkey.io/download/), and [ClickHouse packages](https://packages.clickhouse.com/) on 2026-09-28. The [ClickHouse Docker guide](https://clickhouse.com/docs/get-started/setup/self-managed/docker) documents supported CPU architectures and storage mounts.

Review upstream security advisories regularly. Update the version and digest together, back up first, and test migrations, retries, and restore behavior before replacing production containers. PostgreSQL major upgrades require a data migration; changing an image tag alone is insufficient.

The application build pins [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases), Rust 1.98.0, pnpm 11.28.2 and base-image manifest digests in `Dockerfile`. Debian runtime packages are installed from its signed security repositories at build time; rebuild to receive their updates. GitHub Actions are pinned to exact release commits. CI runs strict Rust checks, TypeScript tests/builds, real-store failure/recovery tests, and a built-image smoke test before and after application restart.

CI also audits production JavaScript dependencies and runs `scripts/audit-rust.py` with cargo-audit 0.22.2. The Rust lockfile retains SQLx's optional MySQL/RSA chain, which has the unpatched [RUSTSEC-2023-0071 advisory](https://rustsec.org/advisories/RUSTSEC-2023-0071.html). Krine's PostgreSQL-only build does not select it. Before applying this single advisory exception, the script checks the complete workspace/all-features/all-targets dependency graph and fails if either `rsa` or `sqlx-mysql` becomes selected. Do not broaden the exception or remove that guard. An advisory audit complements review and tests; it does not establish that a system is secure.
