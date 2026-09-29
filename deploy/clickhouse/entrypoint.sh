#!/bin/sh
set -eu
umask 077

# Upstream permits a named user with an empty password; fail closed instead.
password=$(cat /run/secrets/clickhouse_password)
if [ "${#password}" -lt 32 ]; then
    echo 'ClickHouse password must contain at least 32 characters.' >&2
    exit 1
fi
password_hash=$(printf '%s' "$password" | sha256sum | cut -d ' ' -f 1)
unset password

# Explicit grants replace the upstream image's unrestricted application user.
cat > /etc/clickhouse-server/users.d/krine.xml <<EOF
<clickhouse>
    <users>
        <default remove="remove" />
        <krine replace="replace">
            <password_sha256_hex>$password_hash</password_sha256_hex>
            <profile>default</profile>
            <quota>default</quota>
            <networks><ip>::/0</ip></networks>
            <grants>
                <query>GRANT SELECT, INSERT, CREATE TABLE, ALTER TABLE, DROP TABLE ON krine.*</query>
            </grants>
        </krine>
    </users>
</clickhouse>
EOF

# The image bootstraps on loopback, then stops that server before listening on
# the container network. Remove this identity before the public server starts.
cat > /etc/clickhouse-server/users.d/krine-bootstrap.xml <<EOF
<clickhouse>
    <users>
        <krine_bootstrap>
            <password_sha256_hex>$password_hash</password_sha256_hex>
            <profile>default</profile>
            <quota>default</quota>
            <networks><ip>127.0.0.1</ip></networks>
            <grants>
                <query>GRANT CREATE DATABASE ON krine.*</query>
                $(/bin/sh /opt/krine/clickhouse-diagnostics.sh --grants)
            </grants>
        </krine_bootstrap>
    </users>
</clickhouse>
EOF
unset password_hash
chown clickhouse:clickhouse /etc/clickhouse-server/users.d/krine*.xml
cat > /docker-entrypoint-initdb.d/90-krine-diagnostics.sh <<'EOF'
/bin/sh /opt/krine/clickhouse-diagnostics.sh --maintain
EOF
cat > /docker-entrypoint-initdb.d/99-remove-krine-bootstrap.sh <<'EOF'
rm /etc/clickhouse-server/users.d/krine-bootstrap.xml
EOF

export CLICKHOUSE_SKIP_USER_SETUP=1
export CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS=1
export CLICKHOUSE_USER=krine_bootstrap
exec /entrypoint.sh "$@"
