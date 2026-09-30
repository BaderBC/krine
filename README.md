# Krine

**Krine (`krine.dev`) is an open-source, self-hosted trust decision engine.**

It helps an application answer questions such as:

- can this visitor register?
- can this account claim another trial?
- can this user create an API key?
- can this session perform a sensitive action?

The application sends Krine events and client-side trust signals over time. Krine turns them into reusable metrics, evaluates no-code policies, and returns an explainable decision when the backend performs a check.

The mental model is intentionally small:

**Events → Entities → Metrics → Checks → Decisions**

Krine is not an auth provider, CAPTCHA product, WAF or generic analytics platform. Those can be inputs or integrations. Krine's job is to decide whether a subject should be trusted to perform a specific application action now.

## Run locally

Install Docker with Compose v2 and OpenSSL. Give Docker at least 4 GB of memory for the running stack and additional memory for the initial Rust build.

```sh
git clone https://github.com/baderbc/krine.git
cd krine
./scripts/up.sh --local
```

Open [127.0.0.1:8080](http://127.0.0.1:8080). On first use, enroll a named Admin using `deploy/secrets/admin_password`, save the generated credential, then sign in with that operator. The installation secret is for enrollment and host recovery, not daily sign-in. The command builds the dashboard and Axum service in one image, generates independent credentials, starts PostgreSQL, ClickHouse and Valkey, and waits for readiness. Existing secrets and data survive subsequent runs. Set `KRINE_HTTP_PORT` to choose another loopback port.

Create a named check in **Checks**, edit its policy, and review it before publishing. The local preset permits browser participation from `http://localhost:3000`; set `KRINE_ALLOWED_ORIGINS` to your application's exact origin.

On a fresh installation, use the browser key in `deploy/secrets/browser_public_key` and keep `deploy/secrets/server_secret` exclusively on your application's backend. Krine imports this pair once. Manage replacements and revocation in **Settings → Application connection**; editing the bootstrap files or restarting cannot rotate or restore revoked keys.

To try a complete protected application, run `./scripts/up.sh --local --example`, then open [localhost:3000](http://localhost:3000). Follow the [trial example](examples/protected-app/README.md#run-with-docker) to read its generated account passwords and explicitly publish its trial policy. The opt-in ingress gives both services the same observed browser IP; no policy is seeded at startup.

Local HTTP enables development cookies and is intended for your machine. Follow the [deployment guide](docs/engineering/deployment.md) for HTTPS, proxy trust, backups and upgrades.

For a separate installation with 28 days of fictional investigations, use the [representative demo](docs/engineering/demo.md). It includes policy changes, provider outages, shared clients and verification outcomes; it never imports into an existing deployment.

## Integrate an application

The [SDK guide](docs/engineering/sdks.md) covers browser proofs, authoritative events, checks, durable retries and verification continuation. Your application must deduplicate its own protected business action, including after availability fallback.

SDK releases have not yet been published to a package registry. Follow the [local package installation instructions](docs/engineering/sdks.md#install-the-sdk-packages) to build and consume the tarballs with pnpm. Applications inside this repository can use pnpm workspace dependencies.

## Develop and verify

Use Node.js 24.21 LTS (`.node-version`); Node.js 26 also satisfies the workspace's development requirements. Rust is pinned in `rust-toolchain.toml`; pnpm is pinned in `package.json`. Development helpers also require Python 3.

```sh
export COMPOSE_PROJECT_NAME=krine-test-local
export KRINE_SECRETS_DIR=./deploy/secrets/test-local
export KRINE_POSTGRES_PORT=25432 KRINE_VALKEY_PORT=26379 KRINE_CLICKHOUSE_PORT=28123
./scripts/dev-up.sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
./scripts/with-dev-env.py --isolated-stores cargo test -p krine-server --locked -- --ignored --test-threads=1
```

The last command exercises real stores and HTTP listeners. Recovery fixtures require all three disposable stores, with no application running. The helper verifies the named test project and actual loopback port ownership, and rejects connection overrides outside it. Keep the test environment variables set for these commands. For separate Vite/Axum development, see [dashboard](docs/engineering/dashboard.md) and [backend](docs/engineering/backend.md) configuration.

## Product and architecture

Start with:

- `docs/product/vision.md`
- `docs/product/mvp.md`
- `ARCHITECTURE.md`
- `docs/open-questions.md`

For coding agents, see `AGENTS.md`.
