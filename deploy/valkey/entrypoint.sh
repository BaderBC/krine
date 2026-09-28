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
cat > /tmp/krine-valkey.conf <<EOF
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
chown valkey:valkey /tmp/krine-valkey.conf
exec /usr/local/bin/docker-entrypoint.sh valkey-server /tmp/krine-valkey.conf
