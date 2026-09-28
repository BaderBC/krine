#!/usr/bin/env python3
"""Audit the lockfile; the one exception must remain outside the build graph."""
import argparse
from pathlib import Path
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--db", help="Existing RustSec advisory database checkout")
parser.add_argument("--no-fetch", action="store_true", help="Use the existing advisory checkout without updating it")
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent

graph = subprocess.check_output(
    ["cargo", "tree", "--workspace", "--all-features", "--target", "all",
     "--prefix", "none", "--format", "{p}", "--locked"],
    cwd=root, text=True,
)
for package in graph.splitlines():
    if re.match(r"^(rsa|sqlx-mysql) v", package):
        raise SystemExit(
            f"Refusing RustSec exception: {package} is selected for compilation. "
            "Resolve RUSTSEC-2023-0071 before enabling this dependency."
        )

# SQLx records optional MySQL dependencies in Cargo.lock even though Krine's
# PostgreSQL-only build does not select them. Keep this exception graph-guarded.
command = ["cargo", "audit", "--ignore", "RUSTSEC-2023-0071"]
if args.db:
    command.extend(["--db", args.db])
if args.no_fetch:
    command.append("--no-fetch")
raise SystemExit(subprocess.call(command, cwd=root))
