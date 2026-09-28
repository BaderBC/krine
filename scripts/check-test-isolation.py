#!/usr/bin/env python3
"""Exercise the test guard against the running disposable Compose stores."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
helper = str(root / "scripts/with-dev-env.py")
command = [sys.executable, helper, "--isolated-stores", sys.executable, "-c", "print('command executed')"]
accepted = subprocess.run(command, cwd=root, capture_output=True, text=True, check=True)
assert "command executed" in accepted.stdout

cases = [({"COMPOSE_PROJECT_NAME": "krine"}, "require COMPOSE_PROJECT_NAME")]
for name in ("KRINE_DATABASE_URL", "KRINE_VALKEY_URL", "KRINE_CLICKHOUSE_URL"):
    cases.append(({name: "https://not-the-test-store.invalid"}, f"refuse {name}"))
cases.append(({"KRINE_PROVIDER_TEST_VALKEY_URL": "redis://not-the-test-store.invalid"}, "Provider tests must use"))
for changed, message in cases:
    result = subprocess.run(command, cwd=root, env={**os.environ, **changed}, capture_output=True, text=True)
    assert result.returncode != 0 and message in result.stderr, result.stderr
    assert "command executed" not in result.stdout

result = subprocess.run([sys.executable, helper, "cargo", "test", "--", "--include-ignored"],
                        cwd=root, capture_output=True, text=True)
assert result.returncode != 0 and "require --isolated-stores" in result.stderr
print("Test isolation guard accepted the owned stores and rejected unsafe invocations.")
