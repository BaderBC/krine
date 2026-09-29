#!/usr/bin/env python3
"""Exercise actual image startup and secret isolation across Linux/mapped permissions."""
import json
import os
import subprocess
import uuid


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, text=True, **kwargs)


config = json.loads(docker("compose", "-f", "compose.yaml", "-f", "compose.app.yaml",
                           "config", "--format", "json", capture_output=True).stdout)
service = config["services"]["app"]
image = os.environ.get("KRINE_IMAGE", service["image"])
volume = "krine-secret-test-" + uuid.uuid4().hex
binaries = volume + "-bin"
names = "postgres_password valkey_password clickhouse_password browser_public_key server_secret admin_password"
# Substitute only the final executable. Startup must read the actual mounted
# files, then exec this probe with the production process identity/capabilities.
probe = r'''#!/bin/sh
set -eu
expected=$(printf '%064d' 0)
[ "$(id -u)" = 10001 ]
[ "$(id -g)" = 10001 ]
[ "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^CapPrm:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^CapAmb:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)" = 1 ]
[ "$(stat -c '%u:%g:%a' /run/secrets)" = 0:0:700 ]
[ "$KRINE_DATABASE_URL" = "postgres://krine:$expected@postgres:5432/krine" ]
[ "$KRINE_VALKEY_URL" = "redis://krine:$expected@valkey:6379/0" ]
[ "$KRINE_CLICKHOUSE_PASSWORD" = "$expected" ]
[ "$KRINE_PUBLIC_KEY" = "$expected" ]
[ "$KRINE_SERVER_SECRET" = "$expected" ]
[ "$KRINE_ADMIN_PASSWORD" = "$expected" ]
for name in postgres_password valkey_password clickhouse_password browser_public_key server_secret admin_password; do
    if cat /run/secrets/$name >/dev/null 2>&1; then exit 1; fi
done
if touch /should-be-read-only 2>/dev/null; then exit 1; fi
printf 'Entrypoint read mounted secrets; runtime UID/GID10001 has no capabilities or secret-file access.\n'
'''
created = []
try:
    # This assertion fails on the old image even if a test volume happens to
    # contain a restrictive root directory. Docker secrets mount below this path.
    docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
           "--entrypoint", "/bin/sh", image, "-ec", '[ "$(stat -c \'%u:%g:%a\' /run/secrets)" = 0:0:700 ]')
    for name in (volume, binaries):
        docker("volume", "create", name, capture_output=True)
        created.append(name)
    # Docker copies the image directory's 0700 metadata into the fresh volume.
    docker("run", "--rm", "-i", "--network", "none",
           "--mount", f"type=volume,src={volume},dst=/run/secrets",
           "--mount", f"type=volume,src={binaries},dst=/fixture",
           "--entrypoint", "/bin/sh", image, "-eu", "-c",
           f"for name in {names}; do printf '%064d' 0 > /run/secrets/$name; "
           "chown 1001:1001 /run/secrets/$name; chmod 0600 /run/secrets/$name; done; "
           "cp /usr/local/bin/krine-entrypoint /fixture/krine-entrypoint; "
           "cat > /fixture/krine-server; chmod 0555 /fixture/krine-entrypoint /fixture/krine-server",
           input=probe)
    common = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL",
              "--security-opt", "no-new-privileges:true",
              "--mount", f"type=volume,src={volume},dst=/run/secrets,readonly"]
    negative = subprocess.run(["docker", *common, "--cap-add", "SETUID", "--cap-add", "SETGID",
                               "--entrypoint", "/bin/sh", image, "-c", "cat /run/secrets/admin_password"],
                              text=True, capture_output=True)
    if negative.returncode != 1 or "Permission denied" not in negative.stderr:
        raise SystemExit("The Linux fixture did not reproduce the owner-only secret read failure.")
    assert service["read_only"] and "ALL" in service["cap_drop"]
    assert "no-new-privileges:true" in service["security_opt"]
    caps = [arg for capability in service["cap_add"] for arg in ["--cap-add", capability]]
    for mode in ("0600", "0644"):
        docker("run", "--rm", "--network", "none", "--mount", f"type=volume,src={volume},dst=/run/secrets",
               "--entrypoint", "/bin/sh", image, "-ec", f"chmod {mode} /run/secrets/*")
        docker(*common, *caps, "--mount", f"type=volume,src={binaries},dst=/usr/local/bin,readonly", image)
finally:
    for name in created:
        docker("volume", "rm", name, capture_output=True)
