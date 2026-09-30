#!/usr/bin/env python3
"""Run a command against the loopback ports in compose.dev.yaml."""
import os
import json
from pathlib import Path
import re
import subprocess
import sys

isolated_stores = len(sys.argv) > 1 and sys.argv[1] == "--isolated-stores"
if isolated_stores:
    del sys.argv[1]
if len(sys.argv) < 2:
    raise SystemExit("Usage: scripts/with-dev-env.py [--isolated-stores] COMMAND [ARG ...]")
if not isolated_stores and any(arg in ("--ignored", "--include-ignored") for arg in sys.argv[1:]):
    raise SystemExit("Ignored integration tests require --isolated-stores and a dedicated Compose test project.")

root = Path(__file__).resolve().parent.parent
compose_environment = subprocess.check_output(
    ["docker", "compose", "-f", "compose.yaml", "-f", "compose.dev.yaml", "config", "--environment"],
    cwd=root, text=True,
)
for line in compose_environment.splitlines():
    name, separator, value = line.partition("=")
    if separator and name.startswith("KRINE_"):
        os.environ.setdefault(name, value)
secrets = Path(os.environ.get("KRINE_SECRETS_DIR", root / "deploy/secrets"))
if not secrets.is_absolute():
    secrets = root / secrets
values = {}
for name in ("postgres_password", "valkey_password", "clickhouse_password",
             "browser_public_key", "server_secret", "admin_password"):
    value = (secrets / name).read_text().rstrip("\r\n")
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value):
        raise SystemExit(f"Invalid secret file: {name}")
    values[name] = value

defaults = {
    "KRINE_DATABASE_URL": f"postgres://krine:{values['postgres_password']}@127.0.0.1:{os.environ.get('KRINE_POSTGRES_PORT', '15432')}/krine",
    "KRINE_VALKEY_URL": f"redis://krine:{values['valkey_password']}@127.0.0.1:{os.environ.get('KRINE_VALKEY_PORT', '16379')}/0",
    "KRINE_CLICKHOUSE_URL": f"http://127.0.0.1:{os.environ.get('KRINE_CLICKHOUSE_PORT', '18123')}",
    "KRINE_CLICKHOUSE_USER": "krine",
    "KRINE_CLICKHOUSE_PASSWORD": values["clickhouse_password"],
    "KRINE_PUBLIC_KEY": values["browser_public_key"],
    "KRINE_SERVER_SECRET": values["server_secret"],
    "KRINE_ADMIN_PASSWORD": values["admin_password"],
    "KRINE_PUBLIC_URL": "http://localhost:8080",
    "KRINE_ALLOWED_ORIGINS": "http://localhost:3000",
    "KRINE_DEVELOPMENT": "true",
}
if isolated_stores:
    project = os.environ.get("COMPOSE_PROJECT_NAME", "")
    if not (project.startswith("krine-test-") or project == "krine-ci"):
        raise SystemExit("Isolated tests require COMPOSE_PROJECT_NAME=krine-test-<name> (or krine-ci).")
    for name in ("KRINE_DATABASE_URL", "KRINE_VALKEY_URL", "KRINE_CLICKHOUSE_URL"):
        if f"{name}_FILE" in os.environ or os.environ.get(name, defaults[name]) != defaults[name]:
            raise SystemExit(f"Isolated tests refuse {name} overrides; use the dedicated Compose loopback endpoints.")
    if os.environ.get("KRINE_PROVIDER_TEST_VALKEY_URL", defaults["KRINE_VALKEY_URL"]) != defaults["KRINE_VALKEY_URL"]:
        raise SystemExit("Provider tests must use this dedicated test project's Valkey.")
    container_ids = subprocess.check_output(
        ["docker", "ps", "--filter", f"label=com.docker.compose.project={project}", "--format", "{{.ID}}"], text=True,
    ).split()
    if not container_ids:
        raise SystemExit("The dedicated Compose test stores are not running.")
    containers = json.loads(subprocess.check_output(["docker", "inspect", *container_ids], text=True))
    expected_ports = {"postgres": ("5432/tcp", os.environ.get("KRINE_POSTGRES_PORT", "15432")),
                      "valkey": ("6379/tcp", os.environ.get("KRINE_VALKEY_PORT", "16379")),
                      "clickhouse": ("8123/tcp", os.environ.get("KRINE_CLICKHOUSE_PORT", "18123"))}
    seen = set()
    for container in containers:
        service = container["Config"]["Labels"].get("com.docker.compose.service")
        if service not in expected_ports or service in seen:
            raise SystemExit("Isolated tests require exactly three stores and no running application in the test project.")
        internal, external = expected_ports[service]
        bindings = container["NetworkSettings"]["Ports"].get(internal) or []
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": external}]:
            raise SystemExit(f"The configured {service} endpoint is not the dedicated test container's loopback port.")
        seen.add(service)
    if seen != set(expected_ports):
        raise SystemExit("All three dedicated test stores must be running.")
for name, value in defaults.items():
    if name not in os.environ and f"{name}_FILE" not in os.environ:
        os.environ[name] = value
if isolated_stores:
    valkey_url = os.environ.get("KRINE_VALKEY_URL")
    if valkey_url is None:
        valkey_url = Path(os.environ["KRINE_VALKEY_URL_FILE"]).read_text().rstrip("\r\n")
    os.environ.setdefault("KRINE_PROVIDER_TEST_VALKEY_URL", valkey_url)
    os.environ["KRINE_TEST_OPERATOR_DIRECTORY"] = str(secrets)
os.execvp(sys.argv[1], sys.argv[1:])
