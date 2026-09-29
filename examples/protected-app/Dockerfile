ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
FROM ${NODE_IMAGE} AS build
WORKDIR /build
RUN corepack enable && corepack prepare pnpm@11.28.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/dashboard/package.json ./apps/dashboard/package.json
COPY examples/protected-app ./examples/protected-app
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @krine/protected-app... build \
    && pnpm --filter @krine/protected-app deploy --prod --legacy --config.hoist=false /out

FROM ${NODE_IMAGE}
WORKDIR /opt/draftroom
RUN mkdir -p /run/secrets && chmod 0700 /run/secrets
COPY --from=build /out ./
COPY examples/protected-app/container-entrypoint.mjs ./container-entrypoint.mjs
ENV DEMO_HOST=0.0.0.0 DEMO_PORT=3000 DEMO_DATA_DIR=/var/lib/draftroom
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 CMD node -e 'require("node:http").get({hostname:"127.0.0.1",port:3000,path:"/health",headers:{Host:new URL(process.env.DEMO_ORIGIN).host}},r=>{r.resume();process.exitCode=r.statusCode===200?0:1}).on("error",()=>process.exitCode=1)'
ENTRYPOINT ["node", "container-entrypoint.mjs"]
