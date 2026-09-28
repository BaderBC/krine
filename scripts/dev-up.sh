#!/bin/sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
compose_environment=$(docker compose -f compose.yaml -f compose.dev.yaml config --environment)
KRINE_SECRETS_DIR=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_SECRETS_DIR=//p')
unset compose_environment
export KRINE_SECRETS_DIR
./scripts/init-secrets.sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait --wait-timeout 180
echo 'Krine storage is ready. See docs/engineering/deployment.md for connection settings.'
