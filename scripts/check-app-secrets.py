#!/usr/bin/env python3
"""Exercise the image entrypoint against Linux-owned, 0600 dummy secret files."""
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
names = "postgres_password valkey_password clickhouse_password browser_public_key server_secret admin_password"
# The probe substitutes only the final executable. The image's actual entrypoint
# must read all six files and drop privileges before this executable can pass.
probe = r'''#!/bin/sh
set -eu
expected=$(printf '%064d' 0)
[ "$(id -u)" = 10001 ]
[ "$(id -g)" = 10001 ]
[ "$(awk '/^CapEff:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^CapPrm:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^CapAmb:/ {print $2}' /proc/self/status)" = 0000000000000000 ]
[ "$(awk '/^NoNewPrivs:/ {print $2}' /proc/self/status)" = 1 ]
[ "$KRINE_DATABASE_URL" = "postgres://krine:$expected@postgres:5432/krine" ]
[ "$KRINE_VALKEY_URL" = "redis://krine:$expected@valkey:6379/0" ]
[ "$KRINE_CLICKHOUSE_PASSWORD" = "$expected" ]
[ "$KRINE_PUBLIC_KEY" = "$expected" ]
[ "$KRINE_SERVER_SECRET" = "$expected" ]
[ "$KRINE_ADMIN_PASSWORD" = "$expected" ]
if cat /run/secrets/admin_password >/dev/null 2>&1; then exit 1; fi
if touch /should-be-read-only 2>/dev/null; then exit 1; fi
printf 'Entrypoint read Linux owner-only secrets; runtime UID/GID10001 has no capabilities.\n'
'''
try:
    docker("volume", "create", volume, capture_output=True)
    docker("run", "--rm", "-i", "--network", "none", "--mount", f"type=volume,src={volume},dst=/fixture",
           "--entrypoint", "/bin/sh", image, "-eu", "-c",
           f"for name in {names}; do printf '%064d' 0 > /fixture/$name; "
           "chown 1001:1001 /fixture/$name; chmod 0600 /fixture/$name; done; "
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
    docker(*common, *caps, "--mount", f"type=volume,src={volume},dst=/usr/local/bin,readonly", image)
finally:
    docker("volume", "rm", volume, capture_output=True)
