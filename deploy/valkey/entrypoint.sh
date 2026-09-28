#!/bin/sh
set -eu
umask 077

password=$(cat /run/secrets/valkey_password)
case "$password" in
    *[!a-fA-F0-9]*|'') echo 'Valkey password must be 64 hexadecimal characters.' >&2; exit 1 ;;
esac
if [ "${#password}" -ne 64 ]; then
    echo 'Valkey password must be 64 hexadecimal characters.' >&2
    exit 1
fi

# Keep the password out of process arguments and Docker's environment metadata.
# A root-owned, non-sticky directory supports restart after privilege dropping.
mkdir -p /run/krine-valkey
chown root:valkey /run/krine-valkey
chmod 0750 /run/krine-valkey
cat > /run/krine-valkey/valkey.conf <<EOF
bind 0.0.0.0
protected-mode yes
user default off
user krine on >$password ~krine:* -@all +get +set +del +incr +expire +pttl +ping +hello +client|setinfo +client|setname +eval +evalsha +script|load +zadd +zcount +zremrangebyscore +zcard +info|server
dir /data
appendonly yes
appendfsync always
save ""
maxmemory 256mb
maxmemory-policy noeviction
tcp-keepalive 60
EOF
unset password
chown root:valkey /run/krine-valkey/valkey.conf
chmod 0640 /run/krine-valkey/valkey.conf
exec /usr/local/bin/docker-entrypoint.sh valkey-server /run/krine-valkey/valkey.conf
