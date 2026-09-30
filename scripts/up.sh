#!/bin/sh
set -eu
repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

local=false
example=false
for argument in "$@"; do
    case "$argument" in
        --local) local=true ;;
        --example) example=true ;;
        *) echo 'Usage: ./scripts/up.sh [--local [--example]]' >&2; exit 1 ;;
    esac
done
if "$example"; then
    "$local" || { echo '--example requires --local; this ingress serves local HTTP only.' >&2; exit 1; }
    set -- --env-file deploy/example/local.env.example -f compose.yaml -f compose.app.yaml -f compose.example.yaml
elif "$local"; then
    set -- --env-file deploy/local.env.example -f compose.yaml -f compose.app.yaml
else
    set -- -f compose.yaml -f compose.app.yaml
fi
compose_environment=$(docker compose "$@" config --environment)
KRINE_SECRETS_DIR=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_SECRETS_DIR=//p')
public_url=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_PUBLIC_URL=//p')
example_port=$(printf '%s\n' "$compose_environment" | sed -n 's/^KRINE_EXAMPLE_PORT=//p')
unset compose_environment
export KRINE_SECRETS_DIR
./scripts/init-secrets.sh
docker compose "$@" build
# A schema upgrade must never overlap old and new application writers. Close
# example ingress first and let the business outbox drain before stopping Krine.
if "$example"; then docker compose "$@" stop example-ingress example; fi
docker compose "$@" stop app
docker compose "$@" up -d --wait --wait-timeout 180
printf 'Krine is ready at %s. For first use, enroll a named Admin with admin_password and save its generated credential; otherwise use your individual sign-in.\n' "$public_url"
if "$example"; then
    printf 'Draftroom is ready at http://localhost:%s. Review and publish can_claim_trial before requesting a trial.\n' "$example_port"
    printf 'Read examples/protected-app/README.md for account passwords and the policy walkthrough.\n'
fi
