# Self-hosted deployment

The repository currently supplies Krine's three storage services. Application deployment will join this stack when the backend and dashboard are available. This guide does not yet describe a complete running product.

## Local development

Install Docker Engine with Compose v2 and OpenSSL. Allocate at least 4 GB of RAM to Docker for these services; allow additional memory for application builds. On macOS, start your Docker VM first.

From the repository root:

```sh
./scripts/dev-up.sh
docker compose -f compose.yaml -f compose.dev.yaml ps
```

The script creates four independent random secrets in `deploy/secrets/`, preserves existing values, and waits for storage health checks. Secrets are excluded from Git and Docker build contexts. Keep the directory: recreating secrets does not rotate passwords in an existing PostgreSQL volume.

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

## Deployment boundary

`compose.yaml` exposes no host database ports. Its storage network is internal. `compose.dev.yaml` makes that network a regular Docker bridge and adds local development access; omit it on a server. The future application container must join the storage network and a separate network for incoming HTTP and outbound provider requests. Use the service names `postgres:5432`, `valkey:6379`, and `clickhouse:8123` inside that network.

Create secrets on the deployment host before starting dependencies:

```sh
export KRINE_SECRETS_DIR=/absolute/private/path/krine-secrets
./scripts/init-secrets.sh
docker compose up -d --wait --wait-timeout 180
```

Compose mounts local secret files; it does not encrypt them. Keep the host directory owner-only, protect host and Docker administrator access, and include the secrets in your encrypted recovery plan. The initialization helper requires one line of 64 hexadecimal characters per secret and never replaces an existing value. Secret files must be readable by container root. Use Docker's normal rootful mapping or arrange equivalent access when using rootless/user-remapped engines.

This is a single-host deployment. It provides persistent storage and restart handling, not high availability. Publish only the application's HTTPS endpoint through a trusted reverse proxy when application deployment is added. Database connections within this single-host Docker network are unencrypted; remote databases require private routing, authenticated TLS, and application TLS configuration.

## Durability and capacity

PostgreSQL stores durable relational state. Valkey uses append-only persistence with `appendfsync always`; its security state must not be discarded as though it were an ordinary cache. Its 256 MB memory ceiling uses `noeviction`, so exhausted capacity returns write errors instead of silently deleting proofs or counters. The container allows 512 MB for persistence overhead. The application must surface failed security-state writes as unavailable evaluation. Increasing capacity requires adjusting both limits in deployment configuration.

ClickHouse uses its own persistent volume for history. Its memory ceiling is 2 GB, PostgreSQL's is 1 GB, and container logs rotate at three 10 MB files. These defaults support a small installation, not an unmeasured throughput promise. Watch disk space, out-of-memory kills, Valkey rejected writes, database latency, and application errors. Health checks make authenticated queries as the application identities; they do not prove backups or application correctness.

On a production Linux host, set `vm.overcommit_memory=1` for Valkey's persistence forks and review its startup warnings. This is a host-wide setting; the stack deliberately does not modify it. Docker VMs may also report ClickHouse thread or delay-accounting limitations. Size and tune a production host using measured workload and upstream operating guidance.

Volume persistence does not protect against host or disk loss. Back up PostgreSQL with `pg_dump` or a WAL-based system and ClickHouse with its supported backup mechanism. Test restoration to a separate deployment before relying on those backups. Do not restore an older Valkey snapshot while continuing to serve checks against newer durable state: that can resurrect consumed proofs. Recovery must invalidate outstanding proofs and preserve durable operation records before accepting new checks; the backend recovery procedure must establish this before production launch.

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
