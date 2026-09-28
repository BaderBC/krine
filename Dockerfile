ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG RUST_IMAGE=rust:1.98.0-bookworm@sha256:82150a52ec202c1b14d7817e14516c392bb7f5cfebd88f1ed531cb37ebd39922
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251

FROM ${NODE_IMAGE} AS dashboard
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/dashboard ./apps/dashboard
RUN pnpm install --frozen-lockfile && pnpm --filter @krine/dashboard build

FROM ${RUST_IMAGE} AS backend
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY migrations ./migrations
RUN cargo build --locked --release -p krine-server

FROM ${RUNTIME_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gosu \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 krine && useradd --uid 10001 --gid krine --no-create-home --shell /usr/sbin/nologin krine
COPY --from=backend /build/target/release/krine-server /usr/local/bin/krine-server
COPY --from=dashboard /build/apps/dashboard/dist /opt/krine/dashboard
COPY --chmod=0555 deploy/app/entrypoint.sh /usr/local/bin/krine-entrypoint
ENV KRINE_BIND=0.0.0.0:8080 KRINE_DASHBOARD_DIR=/opt/krine/dashboard KRINE_CLICKHOUSE_URL=http://clickhouse:8123 KRINE_CLICKHOUSE_USER=krine
EXPOSE 8080
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=8s --start-period=30s --retries=3 CMD curl --fail --silent --max-time 7 http://127.0.0.1:8080/health/ready >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/krine-entrypoint"]
