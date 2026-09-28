#!/bin/sh
set -eu

# initdb scripts run as postgres, which cannot read owner-only host secrets.
if [ ! -s "${PGDATA:-/var/lib/postgresql/data}/PG_VERSION" ]; then
    KRINE_POSTGRES_PASSWORD=$(cat /run/secrets/postgres_password)
    test -n "$KRINE_POSTGRES_PASSWORD"
    export KRINE_POSTGRES_PASSWORD
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
