#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

[ "$#" -le 1 ] || { echo 'Unexpected arguments.' >&2; exit 1; }
case "${1:-}" in
    --local)
        set -- --env-file deploy/local.env.example
        ;;
    '') set -- ;;
    *) echo 'Usage: ./scripts/up.sh [--local]' >&2; exit 1 ;;
esac
compose_environment=$(docker compose "$@" -f compose.yaml -f compose.app.yaml config --environment)
KRINE_SECRETS_DIR=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_SECRETS_DIR=//p')
public_url=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_PUBLIC_URL=//p')
unset compose_environment
export KRINE_SECRETS_DIR
./scripts/init-secrets.sh
docker compose "$@" -f compose.yaml -f compose.app.yaml build app
# A schema upgrade must never overlap old and new application writers.
docker compose "$@" -f compose.yaml -f compose.app.yaml stop app
docker compose "$@" -f compose.yaml -f compose.app.yaml up -d --wait --wait-timeout 180
printf 'Krine is ready at %s. Sign in with the admin_password secret.\n' "$public_url"
