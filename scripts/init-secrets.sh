#!/bin/sh
set -eu
umask 077

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"
secrets_dir=${KRINE_SECRETS_DIR:-./deploy/secrets}
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"

for name in postgres_admin_password postgres_password valkey_password clickhouse_password; do
    path=$secrets_dir/$name
    if [ -L "$path" ]; then
        echo "Refusing symlink: $path" >&2
        exit 1
    fi
    if [ ! -e "$path" ]; then
        generated_secret=$(openssl rand -hex 32)
        # noclobber also prevents concurrent invocations replacing a secret.
        (set -C; printf '%s\n' "$generated_secret" > "$path")
        unset generated_secret
    fi
    if [ ! -f "$path" ]; then
        echo "Not a regular secret file: $path" >&2
        exit 1
    fi
    value=$(cat "$path")
    case "$value" in
        *[!a-fA-F0-9]*|'') echo "Invalid hexadecimal secret: $path" >&2; exit 1 ;;
    esac
    if [ "${#value}" -ne 64 ] || [ "$(wc -l < "$path" | tr -d ' ')" -ne 1 ]; then
        echo "Invalid secret: $path (expected one line of 64 hexadecimal characters)." >&2
        exit 1
    fi
    unset value
    chmod 600 "$path"
done
echo "Secrets ready in $secrets_dir; existing values were preserved."
