#!/bin/sh
set -eu

# Compose file secrets preserve host permissions. Read owner-only mounts before
# dropping root; secret values never become command arguments or image layers.
for name in postgres_password valkey_password clickhouse_password browser_public_key server_secret admin_password; do
    path=/run/secrets/$name
    value=$(cat "$path")
    case "$value" in
        *[!a-fA-F0-9]*|'') echo "Invalid secret file: $name" >&2; exit 1 ;;
    esac
    [ "${#value}" -eq 64 ] || { echo "Invalid secret length: $name" >&2; exit 1; }
    case "$name" in
        postgres_password) export KRINE_DATABASE_URL="postgres://krine:$value@postgres:5432/krine" ;;
        valkey_password) export KRINE_VALKEY_URL="redis://krine:$value@valkey:6379/0" ;;
        clickhouse_password) export KRINE_CLICKHOUSE_PASSWORD="$value" ;;
        browser_public_key) export KRINE_PUBLIC_KEY="$value" ;;
        server_secret) export KRINE_SERVER_SECRET="$value" ;;
        admin_password) export KRINE_ADMIN_PASSWORD="$value" ;;
    esac
done
unset value path name
exec gosu krine:krine /usr/local/bin/krine-server
