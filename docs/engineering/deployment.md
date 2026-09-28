# Self-hosted deployment

Krine runs as one Axum application serving both the API and dashboard, with PostgreSQL, ClickHouse and Valkey on a private Docker network. `compose.yaml` defines storage; `compose.app.yaml` adds the application and its ingress/outbound network. This is a persistent single-host deployment, not a high-availability cluster.

## Complete local application

Run `./scripts/up.sh --local` from the repository root. The helper builds the production image, generates missing secrets, stops the previous application before any migration, and starts the complete stack. The local preset in `deploy/local.env.example` serves `http://127.0.0.1:8080`, permits the browser application origin `http://localhost:3000`, and explicitly enables HTTP development cookies. Shell variables can override its port, origins and secret directory.

Sign in with `deploy/secrets/admin_password`. The independent `browser_public_key` is public browser configuration; `server_secret` belongs only on application backends. Never include the latter or the operator password in a browser bundle.

Inspect or stop this local stack without removing data:

```sh
docker compose --env-file deploy/local.env.example -f compose.yaml -f compose.app.yaml ps
docker compose --env-file deploy/local.env.example -f compose.yaml -f compose.app.yaml down
```

Keep any shell overrides consistent across these commands. Do not use `down --volumes` unless intentionally deleting a disposable installation.

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

The entrypoint reads owner-only mounted secrets as root, then replaces itself with the application as UID/GID `10001`. The application has a read-only filesystem and no Linux capabilities. `SIGTERM` drains requests and stops its worker within Compose's 30-second grace period. The health check calls `/health/ready`; analytical export can lag while checks remain available. The image bundles CA certificates for provider HTTPS.

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

ClickHouse disables its anonymous default user. The application identity can select, insert, create, alter, and drop tables within `krine` only. It cannot create databases, manage users, control the server, or use external-source table functions. A loopback-only bootstrap identity creates the database during startup and is removed before the network listener starts. The health check connects through the container network address, so the temporary bootstrap server cannot report ready.

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

## Upgrade

Back up before an upgrade. Review new migrations and dependency notes, fetch the reviewed release, then run `./scripts/up.sh` with the same configuration and secret directory. The helper builds first, stops the old application, and only then starts the new image; stores remain running. Do not run old and new application writers together during a schema change. PostgreSQL migrations run before the new listener opens. Restarting a container uses the same image and does not rebuild it.

History migration from the initial runtime to provider-capable history adds monotonically revisioned records and backfills legacy history once. Old application writes are rejected by the PostgreSQL generation guard after that migration. Reverting only the image is not a supported database downgrade; restore a tested compatible backup if a migration must be rolled back.

## Durability and capacity

PostgreSQL stores durable relational state. Valkey uses append-only persistence with `appendfsync always`; its security state must not be discarded as though it were an ordinary cache. Its 256 MB memory ceiling uses `noeviction`, so exhausted capacity returns write errors instead of silently deleting proofs or counters. The container allows 512 MB for persistence overhead. The application must surface failed security-state writes as unavailable evaluation. Increasing capacity requires adjusting both limits in deployment configuration.

ClickHouse uses its own persistent volume for history. Its memory ceiling is 2 GB, PostgreSQL's is 1 GB, and container logs rotate at three 10 MB files. These defaults support a small installation, not an unmeasured throughput promise. Watch disk space, out-of-memory kills, Valkey rejected writes, database latency, and application errors. Health checks make authenticated queries as the application identities; they do not prove backups or application correctness.

On a production Linux host, set `vm.overcommit_memory=1` for Valkey's persistence forks and review its startup warnings. This is a host-wide setting; the stack deliberately does not modify it. Docker VMs may also report ClickHouse thread or delay-accounting limitations. Size and tune a production host using measured workload and upstream operating guidance.

Volume persistence does not protect against host or disk loss. Back up PostgreSQL with `pg_dump` or a WAL-based system and ClickHouse with its supported backup mechanism. Include configuration, the exact image/revision and encrypted secrets. PostgreSQL contains operation ownership and replay protection as well as configuration: losing accepted records is a security-relevant data loss, not merely a history gap. Choose a recovery point objective accordingly.

Test restoration to a separate deployment before relying on backups. For a coordinated backup, stop the application writer, finish any acknowledged requests, and take database backups at that stopped boundary. Preserve ClickHouse history: exported PostgreSQL reliability envelopes expire after 48 hours and cannot recreate older analytical history. A newer PostgreSQL outbox can re-export recent records safely; duplicate export does not create duplicate activity.

During recovery, keep ingress closed. Restore durable PostgreSQL state and ClickHouse history from the intended recovery boundary. Start Valkey with a new empty data volume rather than restoring old short-lived credentials or proofs. The backend rebuilds current event counters from retained durable envelopes and establishes a fresh generation before readiness. Existing browser credentials are invalidated, so subsequent participation receives new client/session context; historical entities and backend-known account history remain stored. Unclaimed proofs must be obtained again. Recorded operations remain retryable from PostgreSQL and retain their unique proof ownership. Never delete operation records merely to make recovery pass.

Verify readiness, an authoritative event/check flow, same-operation retry, history availability and expected configuration before reopening ingress. If the PostgreSQL backup loses accepted operations, reconcile the application's durable business-operation records before restoring protected traffic; Krine cannot infer lost authorizations from an older database. Application business-action idempotency remains mandatory. An older Valkey snapshot is detected by incarnation/watermark checks for counter recovery, but it is not a substitute for this controlled disaster-recovery procedure.

The backend owns schema migrations. Container initialization only creates the database and service identities; it must not become a second schema migration system.

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
