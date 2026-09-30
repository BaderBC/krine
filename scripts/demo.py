#!/usr/bin/env python3
"""Create one isolated, explicitly synthetic Krine demonstration deployment.

There is deliberately no database URL, existing project, force, or volume-delete
option. The durable owner record is required to resume an interrupted import.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import time

REPO = Path(__file__).resolve().parent.parent
SERVICES = ("postgres", "clickhouse", "valkey", "app")
VOLUMES = {"postgres": ("postgres_data", "/var/lib/postgresql/data"),
           "clickhouse": ("clickhouse_data", "/var/lib/clickhouse"),
           "valkey": ("valkey_data", "/data")}
TABLES = {
    "checks": ("name", "description draft draft_revision active_version restored_from_version created_at updated_at"),
    "policy_versions": ("check_name version", "policy published_at restored_from_version"),
    "entities": ("kind id", "client_id first_seen metadata"),
    "associations": ("id", "digest client_id user_id metadata created_at revoked_at revocation_reason revoked_by session_id credential_id revision"),
    "observed_ips": ("id", "client_id session_id ip first_seen last_seen credential_id last_credential_id first_source last_source first_event_id last_event_id has_corrections revision revoked_at revocation_reason revoked_by"),
    "relationship_audit": ("id", "kind relationship_id at action reason actor revision relationship"),
}
EMPTY_TABLES = tuple(TABLES) + ("events", "operations", "delivery_outbox", "admin_sessions", "admin_mutations",
    "provider_revisions", "provider_tests", "challenge_steps", "verification_transitions", "application_observations")
MAX_CHUNK = 2 * 1024 * 1024
CH_SETTINGS = " SETTINGS max_execution_time=20,max_memory_usage=268435456,max_result_bytes=8388608,result_overflow_mode='throw'"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_file(path, maximum):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= maximum, "Unsafe or oversized file: " + path.name)
    return path.read_bytes()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def save_json(path, value):
    temporary = path.with_name(path.name + ".partial")
    if temporary.exists():
        require(stat.S_ISREG(temporary.lstat().st_mode), "Unsafe state temporary file")
        temporary.unlink()
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(canonical(value) + "\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def command(args, *, data=None, env=None, timeout=120):
    # Do not echo arguments, SQL, secrets or subprocess diagnostics. A failure
    # retains the owned state for exact read-back and resume, including lost acks.
    result = subprocess.run(args, cwd=REPO, env=env, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout)
    require(result.returncode == 0, "Command failed: " + args[0] + "; owned state is preserved for resume")
    return result.stdout


def docker(*args, **kwargs):
    return command(["docker", *args], **kwargs)


def inspect(kind, name):
    return json.loads(docker(kind, "inspect", name))[0]


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def ch_literal(value):
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def generator_digest():
    paths = [REPO / "Cargo.lock", *sorted((REPO / "crates/krine-demo").rglob("*.rs")),
             REPO / "crates/krine-demo/Cargo.toml", *sorted((REPO / "crates/krine-core/src").glob("*.rs"))]
    return digest(b"".join(str(path.relative_to(REPO)).encode() + b"\0" + path.read_bytes() for path in paths))


def verify_dataset(path):
    require(path.is_dir() and not path.is_symlink(), "Dataset must be an ordinary directory")
    command(["cargo", "run", "--locked", "--offline", "-p", "krine-demo", "--", "verify", "--output", str(path)], timeout=900)
    raw = read_file(path / "manifest.json", 4 * 1024 * 1024)
    manifest = json.loads(raw)
    require(manifest["schema_version"] == 1 and manifest["configuration"]["generator_version"] in ("1", "2"), "Unsupported dataset version")
    require(re.fullmatch(r"demo_[a-f0-9]{24}", manifest["dataset_id"]), "Invalid dataset identity")
    total = 0
    for index, chunk in enumerate(manifest["chunks"]):
        require(chunk["name"] == f"chunk-{index:06}.jsonl", "Unexpected chunk path")
        require(0 < chunk["rows"] <= 500 and 0 < chunk["bytes"] <= MAX_CHUNK, "Chunk exceeds bounds")
        require((chunk["store"] == "postgres" and chunk["table"] in TABLES) or
                (chunk["store"] == "clickhouse" and chunk["table"] == "history_v2"), "Unsupported import table")
        content = read_file(path / chunk["name"], MAX_CHUNK)
        require(len(content) == chunk["bytes"] and digest(content) == chunk["sha256"], "Chunk differs from manifest")
        require(len(content.splitlines()) == chunk["rows"], "Chunk row count differs")
        total += chunk["bytes"]
    require(total == manifest["bytes"] <= manifest["configuration"]["max_bytes"], "Dataset byte ledger differs")
    return manifest, digest(raw)


def freshness(manifest, now=None):
    now = int(time.time() * 1000) if now is None else now
    anchor = manifest["configuration"]["anchor_ms"]
    require(now - 86_400_000 <= anchor <= now, "Generate a dataset with an anchor in the previous 24 hours")
    require(manifest["from"] == anchor - 28 * 86_400_000 and manifest["to"] <= now - 600_000,
            "Dataset must fit retention and remain outside the hot window")


def disk_budget(path, manifest):
    required = manifest["bytes"] * 4 + 4 * 1024 ** 3
    require(shutil.disk_usage(path).free >= required, "Insufficient disk: preserve at least 4 GiB beyond four times the dataset size")
    return required


def port_available(port):
    require(1024 <= port <= 65535, "Use an unprivileged loopback port")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))


class Deployment:
    def __init__(self, directory, state):
        self.directory, self.state = directory, state
        self.config = json.loads(read_file(directory / "compose.json", 1024 * 1024))
        require(digest(canonical(self.config).encode()) == state["config_hash"], "Owned Compose configuration changed")
        require(re.fullmatch(r"krine-demo-[a-f0-9]{24}", state["project"]), "Invalid owned project")
        require(state["project"] == "krine-demo-" + state["owner_id"] and self.config["name"] == state["project"] and set(self.config["services"]) == set(SERVICES), "Unexpected project services")
        require(state["phase"] in ("planned", "provisioning", "stopping", "importing", "publishing", "complete"), "Unknown import phase")
        self.env = {**os.environ, "COMPOSE_PROJECT_NAME": state["project"]}
        self.compose = ["docker", "compose", "-f", str(directory / "compose.json"), "--project-name", state["project"]]

    def save(self):
        save_json(self.directory / "owner.json", self.state)

    def compose_run(self, *args):
        return command([*self.compose, *args], env=self.env, timeout=180)

    def assert_files(self):
        require(docker("info", "--format", "{{.ID}}").decode().strip() == self.state["daemon_id"], "Docker daemon changed")
        for name, expected in self.state["files"].items():
            path = self.directory / name
            require(digest(read_file(path, 1024 * 1024)) == expected, "Owned deployment file changed: " + name)

    def absent(self):
        for args in [("ps", "-aq"), ("volume", "ls", "-q"), ("network", "ls", "-q")]:
            require(not docker(*args, "--filter", "label=com.docker.compose.project=" + self.state["project"]).strip(), "Refuse existing project resources")
        for kind in ("volumes", "networks"):
            for value in self.config[kind].values():
                require(not value.get("external") and value["name"].startswith(self.state["project"] + "_"), "Foreign resource name")
                existing = subprocess.run(["docker", kind[:-1], "inspect", value["name"]], capture_output=True)
                require(existing.returncode != 0, "Refuse preexisting named resource")

    def owned(self, *, stopped=False, permit_new_app=False, partial=False):
        self.assert_files()
        found = docker("ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + self.state["project"]).decode().split()
        require(len(found) <= len(SERVICES) if partial else len(found) == len(SERVICES), "Unexpected owned container count")
        ids = {}
        for identifier in found:
            actual = inspect("container", identifier)
            labels = actual["Config"].get("Labels") or {}
            service = labels.get("com.docker.compose.service")
            require(service in SERVICES and service not in ids and labels.get("com.docker.compose.project") == self.state["project"]
                    and labels.get("io.krine.demo.owner") == self.state["owner_id"]
                    and labels.get("io.krine.demo.dataset") == self.state["dataset_id"], "Foreign container or ownership mismatch")
            expected = self.state["containers"].get(service)
            require(not expected or expected == identifier or (permit_new_app and service == "app"), "Container identity changed")
            config = self.config["services"][service]
            require(actual["Image"] == config["image"], "Container image changed")
            require(not actual["HostConfig"].get("Privileged") and actual["HostConfig"].get("NetworkMode") != "host", "Unsafe container configuration")
            ports = actual["HostConfig"].get("PortBindings") or {}
            if service != "app" or self.state["phase"] not in ("publishing", "complete"):
                require(not ports, "Unpublished demo or store has a host port")
            else:
                published = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(self.state["port"])}]}
                require(ports == published or (self.state["phase"] == "publishing" and not ports), "Unexpected application ingress")
            expected_networks = {self.config["networks"][key]["name"] for key in config["networks"]}
            actual_networks = set(actual["NetworkSettings"]["Networks"])
            # Docker detaches stopped containers from network membership, while
            # preserving their configured NetworkSettings names.
            require(actual_networks == expected_networks, "Container has foreign or missing networks")
            mounts = {}
            for mount in config.get("volumes", []):
                source = self.config["volumes"][mount["source"]]["name"] if mount["type"] == "volume" else mount["source"]
                mounts[mount["target"]] = (mount["type"], source, not mount.get("read_only", False))
            for secret in config.get("secrets", []):
                key = secret["source"] if isinstance(secret, dict) else secret
                target = secret.get("target", key) if isinstance(secret, dict) else key
                if not target.startswith("/"):
                    target = "/run/secrets/" + target
                mounts[target] = ("bind", self.config["secrets"][key]["file"], False)
            actual_mounts = {mount["Destination"]: (mount["Type"], mount["Name"] if mount["Type"] == "volume" else mount["Source"], mount["RW"]) for mount in actual["Mounts"]}
            require(actual_mounts == mounts, "Container mounts differ from the owned configuration")
            if stopped and service == "app":
                status = actual["State"]
                require(not status["Running"] and not status["Restarting"] and not status["OOMKilled"] and status["ExitCode"] == 0,
                        "Application writer must be gracefully stopped")
            if service != "app" and not partial:
                require(actual["State"]["Running"] and not actual["State"]["OOMKilled"], "Owned store is unavailable")
            ids[service] = identifier
        require(set(self.state["containers"]) <= set(ids), "A pinned container is missing")
        volume_names = set(docker("volume", "ls", "--format", "{{.Name}}").decode().splitlines())
        for key, expected in self.config["volumes"].items():
            name = expected["name"]
            if name not in volume_names:
                require(partial and key not in self.state["volumes"], "A pinned volume is missing")
                continue
            volume = inspect("volume", name)
            labels = volume.get("Labels") or {}
            require(labels.get("io.krine.demo.owner") == self.state["owner_id"] and labels.get("com.docker.compose.project") == self.state["project"]
                    and labels.get("io.krine.demo.dataset") == self.state["dataset_id"], "Volume ownership differs")
            identity = {"name": name, "created_at": volume["CreatedAt"], "mountpoint": volume["Mountpoint"]}
            pinned = self.state["volumes"].get(key)
            require(not pinned or pinned == identity, "Volume identity changed")
            permitted = {ids[service] for service, config in self.config["services"].items() if service in ids
                         and any(mount["type"] == "volume" and mount["source"] == key for mount in config.get("volumes", []))}
            attached = set(docker("ps", "-aq", "--no-trunc", "--filter", "volume=" + name).decode().split())
            require(attached == permitted, "Foreign or missing container attachment to demo data")
            self.state["volumes"][key] = identity
        network_names = set(docker("network", "ls", "--format", "{{.Name}}").decode().splitlines())
        for key, expected in self.config["networks"].items():
            if expected["name"] not in network_names:
                require(partial and key not in self.state["networks"], "A pinned network is missing")
                continue
            network = inspect("network", expected["name"])
            require(network["Labels"].get("io.krine.demo.owner") == self.state["owner_id"]
                    and network["Labels"].get("com.docker.compose.project") == self.state["project"]
                    and set(network.get("Containers") or {}) <= set(ids.values()), "Foreign container attached to demo network")
            require(not self.state["networks"].get(key) or self.state["networks"][key] == network["Id"], "Network identity changed")
            self.state["networks"][key] = network["Id"]
        self.state["containers"] = ids
        self.save()

    def store_disk_budget(self, manifest):
        for service in ("postgres", "clickhouse"):
            path = VOLUMES[service][1]
            output = docker("exec", self.state["containers"][service], "df", "-Pk", path).decode().splitlines()
            available = int(output[-1].split()[3]) * 1024
            require(available >= manifest["bytes"] * 4 + 2 * 1024 ** 3, "Insufficient space inside owned " + service + " storage")

    def sql(self, query):
        return docker("exec", "-i", self.state["containers"]["postgres"], "sh", "-c",
            'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql -X -h 127.0.0.1 -U krine -d krine -Atq -v ON_ERROR_STOP=1',
            data=("SET standard_conforming_strings=on; SET krine.writer_generation='5'; SET statement_timeout='30s'; SET lock_timeout='3s';\n" + query).encode()).decode().strip()

    def ch(self, query, body=b""):
        return docker("exec", "-i", self.state["containers"]["clickhouse"], "sh", "-c",
            'CLICKHOUSE_PASSWORD="$(cat /run/secrets/clickhouse_password)" exec clickhouse-client --host "$(hostname)" --user krine --database krine --query "$1"',
            "demo-query", query, data=body).decode().strip()

    def ready(self):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            actual = inspect("container", self.state["containers"]["app"])
            if actual["State"].get("Health", {}).get("Status") == "healthy":
                if self.sql("SELECT completed FROM analytical_migrations WHERE name='history_v2';") == "t":
                    return
            require(not actual["State"]["OOMKilled"], "Application exhausted its memory")
            time.sleep(1)
        raise RuntimeError("Application did not become ready; owned deployment is preserved")

    def claim(self, manifest):
        existing = self.sql("SELECT row_to_json(s) FROM demo_import_state s;")
        expected = {"dataset_id": manifest["dataset_id"], "generator_version": manifest["configuration"]["generator_version"], "seed": manifest["configuration"]["seed"],
                    "range_from": manifest["from"], "range_to": manifest["to"], "manifest_hash": self.state["manifest_hash"], "owner_id": self.state["owner_id"]}
        if existing:
            actual = json.loads(existing)
            require(all(actual[key] == value for key, value in expected.items()), "Import ownership or dataset changed")
            return actual["completed_at"] is not None
        for table in EMPTY_TABLES:
            require(self.sql(f"SELECT count(*) FROM {table};") == "0", "Refuse nonempty application data: " + table)
        require(self.sql("SELECT count(*) FROM demo_import_chunks;") == "0", "Import ledger exists without ownership")
        require(self.sql("SELECT count(*) FROM application_credentials WHERE source<>'bootstrap';") == "0", "Non-bootstrap credentials exist")
        require(self.ch("SELECT count() FROM history_v2" + CH_SETTINGS) == "0" and self.ch("SELECT count() FROM history" + CH_SETTINGS) == "0", "Refuse existing historical records")
        columns = ",".join(expected)
        values = ",".join(sql_literal(value) for value in expected.values())
        self.sql(f"INSERT INTO demo_import_state({columns}) VALUES({values});")
        return False

    def journal(self, chunk):
        value = self.sql("SELECT row_to_json(c) FROM demo_import_chunks c WHERE name=" + sql_literal(chunk["name"]) + ";")
        expected = {key: chunk[key] for key in ("name", "sha256", "store", "rows")}
        if value:
            require(json.loads(value) == expected, "Existing chunk ledger differs")
            return True
        return False

    def journal_sql(self, chunk):
        return "INSERT INTO demo_import_chunks(name,sha256,store,rows) VALUES(" + ",".join(sql_literal(chunk[key]) for key in ("name", "sha256", "store", "rows")) + ");"

    def pg_rows(self, table, rows):
        keys, other = TABLES[table]
        columns = (keys + " " + other).split()
        require(all(set(row) == set(columns) for row in rows), "Unexpected PostgreSQL columns")
        condition = " OR ".join("(" + " AND ".join(key + "=" + sql_literal(row[key]) for key in keys.split()) + ")" for row in rows)
        result = self.sql("SELECT row_to_json(t) FROM (SELECT " + ",".join(columns) + " FROM " + table + " WHERE " + condition + ") t;")
        return [json.loads(line) for line in result.splitlines()]

    def import_pg(self, chunk, rows):
        table = chunk["table"]
        existing = self.pg_rows(table, rows)
        if self.journal(chunk):
            require(sorted(map(canonical, existing)) == sorted(map(canonical, rows)), "Committed PostgreSQL chunk changed")
            return
        require(not existing, "Unjournaled PostgreSQL rows exist; refusing to overwrite")
        columns = ",".join((" ".join(TABLES[table])).split())
        sql = f"BEGIN; INSERT INTO {table}({columns}) SELECT {columns} FROM jsonb_populate_recordset(NULL::{table}," + sql_literal(canonical(rows)) + "::jsonb); " + self.journal_sql(chunk) + " COMMIT;"
        self.sql(sql)
        require(sorted(map(canonical, self.pg_rows(table, rows))) == sorted(map(canonical, rows)), "PostgreSQL read-back differs")

    def ch_rows(self, rows, final=False):
        keys = ",".join("(" + ch_literal(row["kind"]) + "," + ch_literal(row["id"]) + ")" for row in rows)
        suffix = " FINAL" if final else ""
        query = "SELECT kind,id,at,revision,payload FROM history_v2" + suffix + " WHERE (kind,id) IN (" + keys + ")"
        query += " GROUP BY kind,id,at,revision,payload LIMIT 1001" + CH_SETTINGS + " FORMAT JSONEachRow"
        return [json.loads(line) for line in self.ch(query).splitlines()]

    def import_ch(self, chunk, rows, content):
        expected = {canonical(row) for row in rows}
        # The fixture contains only final revisions. Exact replays may create
        # physical duplicates until ClickHouse merges them; logical rows agree.
        keys = {(row["kind"], row["id"], int(row["revision"])) for row in rows}
        actual = [row for row in self.ch_rows(rows) if (row["kind"], row["id"], int(row["revision"])) in keys]
        actual = {canonical(normalize_ch(row)) for row in actual}
        require(actual <= expected, "ClickHouse contains conflicting payloads for a seeded revision")
        logged = self.journal(chunk)
        if actual != expected:
            require(not logged, "A committed ClickHouse chunk is missing data")
            self.ch("INSERT INTO history_v2(kind,id,at,revision,payload) FORMAT JSONEachRow", content)
            actual = {canonical(normalize_ch(row)) for row in self.ch_rows(rows) if (row["kind"], row["id"], int(row["revision"])) in keys}
            require(actual == expected, "ClickHouse read-back differs; resume will reconcile the exact chunk")
        if not logged:
            self.sql(self.journal_sql(chunk))

    def verify_all(self, manifest, dataset):
        latest = {}
        chunks = len(manifest["chunks"])
        print(f"Checking stored configuration and chunk journals: 0/{chunks} chunks", flush=True)
        for checked_chunks, chunk in enumerate(manifest["chunks"], 1):
            self.owned(stopped=True)
            require(self.journal(chunk), "Chunk lacks durable acknowledgment")
            rows = [json.loads(line) for line in read_file(dataset / chunk["name"], MAX_CHUNK).splitlines()]
            if chunk["store"] == "postgres":
                require(sorted(map(canonical, self.pg_rows(chunk["table"], rows))) == sorted(map(canonical, rows)), "Final PostgreSQL evidence differs")
            else:
                for row in rows:
                    key = (row["kind"], row["id"])
                    if key not in latest or row["revision"] > latest[key]["revision"]:
                        latest[key] = {"kind": row["kind"], "id": row["id"], "at": row["at"], "revision": row["revision"], "payload_hash": digest(row["payload"].encode()), "bytes": len(row["payload"].encode())}
            if checked_chunks % 25 == 0 or checked_chunks == chunks:
                print(f"Checked stored configuration and chunk journals: {checked_chunks}/{chunks} chunks", flush=True)
        print(f"Reading back latest historical records: 0/{len(latest)} records", flush=True)
        checked_records, next_progress = 0, 5000
        batch, size = [], 0
        for expected in latest.values():
            if batch and (len(batch) == 500 or size + expected["bytes"] > MAX_CHUNK):
                self.verify_latest(batch)
                checked_records += len(batch)
                if checked_records >= next_progress:
                    print(f"Read back latest historical records: {checked_records}/{len(latest)} records", flush=True)
                    next_progress = checked_records + 5000
                batch, size = [], 0
            batch.append(expected)
            size += expected["bytes"]
        if batch:
            self.verify_latest(batch)
            checked_records += len(batch)
        print(f"Read back latest historical records: {checked_records}/{len(latest)} records", flush=True)
        for table in TABLES:
            expected = manifest["counts"]["rows/postgres/" + table]
            require(int(self.sql(f"SELECT count(*) FROM {table};")) == expected, "Extra PostgreSQL rows exist")
        actual = {row["kind"]: int(row["rows"]) for row in (json.loads(line) for line in self.ch("SELECT kind,count() AS rows FROM history_v2 FINAL GROUP BY kind" + CH_SETTINGS + " FORMAT JSONEachRow").splitlines())}
        require(actual == {"event": manifest["counts"]["history/event"], "decision": manifest["counts"]["history/decision"]}, "Logical historical totals differ")
        unique_rows = int(self.ch("SELECT count() FROM (SELECT kind,id,revision,at,SHA256(payload) FROM history_v2 GROUP BY kind,id,revision,at,SHA256(payload))" + CH_SETTINGS))
        require(unique_rows == manifest["counts"]["rows/clickhouse/history_v2"], "Unexpected historical revisions or payloads exist")
        require(int(self.sql("SELECT count(*) FROM demo_import_chunks;")) == len(manifest["chunks"]), "Extra import journal rows exist")
        for table in set(EMPTY_TABLES) - set(TABLES):
            require(self.sql(f"SELECT count(*) FROM {table};") == "0", "Runtime traffic appeared during import")
        print("Exact stored totals verified; no live traffic was imported.", flush=True)

    def verify_latest(self, expected):
        self.owned(stopped=True)
        actual = [normalize_ch(row) for row in self.ch_rows(expected, final=True)]
        expected_map = {(row["kind"], row["id"]): row for row in expected}
        require(len(actual) == len(expected_map), "Latest logical records are missing or duplicated")
        for row in actual:
            key = (row["kind"], row["id"])
            require(key in expected_map, "Unexpected logical record")
            want = expected_map[key]
            require(row["at"] == want["at"] and row["revision"] == want["revision"] and digest(row["payload"].encode()) == want["payload_hash"], "Latest logical record differs")


def normalize_ch(row):
    return {**row, "at": int(row["at"]), "revision": int(row["revision"])}


def create(directory, dataset, manifest, manifest_hash, image, port):
    require(not directory.exists(), "State directory must be newly created; use resume for an owned import")
    disk_budget(directory.parent, manifest)
    port_available(port)
    directory.mkdir(mode=0o700)
    (directory / "assets").mkdir(mode=0o700)
    owner = secrets.token_hex(12)
    project = "krine-demo-" + owner
    env = {**{key:value for key,value in os.environ.items() if not key.startswith("KRINE_")}, "COMPOSE_PROJECT_NAME": project, "KRINE_SECRETS_DIR": str(directory / "secrets"),
        "KRINE_PUBLIC_URL": f"http://localhost:{port}", "KRINE_ALLOWED_ORIGINS": f"http://localhost:{port}",
        "KRINE_HTTP_PORT": str(port), "KRINE_DEVELOPMENT": "true", "KRINE_IMAGE": image,
        "KRINE_HISTORY_RETENTION_DAYS": "30"}
    command(["./scripts/init-secrets.sh"], env=env)
    config = json.loads(command(["docker", "compose", "--env-file", "/dev/null", "-f", "compose.yaml", "-f", "compose.app.yaml", "config", "--format", "json"], env=env))
    labels = {"io.krine.demo.owner": owner, "io.krine.demo.dataset": manifest["dataset_id"]}
    files = {}
    for service_name, service in config["services"].items():
        image_info = inspect("image", service["image"])
        service["image"] = image_info["Id"]
        # Give image-declared storage an owned name too; otherwise Docker would
        # silently create anonymous volumes outside the ownership ledger.
        destinations = {mount["target"] for mount in service.get("volumes", [])}
        for index, target in enumerate(sorted(image_info["Config"].get("Volumes") or {})):
            if target not in destinations:
                key = service_name + "_aux_" + str(index)
                config["volumes"][key] = {}
                service.setdefault("volumes", []).append({"type":"volume", "source":key, "target":target})
        service.pop("build", None)
        service["labels"] = {**service.get("labels", {}), **labels}
        service["restart"] = "no"
        service.pop("ports", None)
        for mount in service.get("volumes", []):
            if mount["type"] == "bind":
                original = Path(mount["source"])
                destination = directory / "assets" / (digest(str(original).encode())[:12] + "-" + original.name)
                data = read_file(original, 1024 * 1024)
                destination.write_bytes(data)
                destination.chmod(0o644)
                mount["source"] = str(destination)
    for kind in ("volumes", "networks"):
        for key, value in config[kind].items():
            require(not value.get("external"), "External resources are not allowed")
            value["name"] = project + "_" + key
            value["labels"] = {**value.get("labels", {}), **labels}
    save_json(directory / "compose.json", config)
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            files[str(path.relative_to(directory))] = digest(read_file(path, 1024 * 1024))
    state = {"version": 1, "project": project, "owner_id": owner, "dataset_id": manifest["dataset_id"],
        "dataset": str(dataset), "manifest_hash": manifest_hash, "generator_hash": generator_digest(), "config_hash": digest(canonical(config).encode()),
        "files": files, "port": port, "phase": "planned", "daemon_id": docker("info", "--format", "{{.ID}}").decode().strip(),
        "containers": {}, "volumes": {}, "networks": {}}
    save_json(directory / "owner.json", state)


def resume(directory):
    require(stat.S_ISDIR(directory.lstat().st_mode) and directory.stat().st_uid == os.getuid() and directory.stat().st_mode & 0o077 == 0,
            "State must be an ordinary owner-only directory")
    lock_path = directory / ".lock"
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(read_file(directory / "owner.json", 1024 * 1024))
        require(state["version"] == 1 and state["generator_hash"] == generator_digest(), "Importer generator version changed; preserve the original checkout")
        deployment = Deployment(directory, state)
        if state["phase"] == "complete":
            deployment.owned()
            print(f"Synthetic demo is already complete: http://localhost:{state['port']}")
            return
        dataset = Path(state["dataset"])
        manifest, manifest_hash = verify_dataset(dataset)
        require(manifest_hash == state["manifest_hash"] and manifest["dataset_id"] == state["dataset_id"], "Owned dataset changed")
        freshness(manifest)
        disk_budget(directory, manifest)
        deployment.assert_files()
        if state["phase"] == "planned":
            deployment.absent()
            state["phase"] = "provisioning"
            deployment.save()
        if state["phase"] == "provisioning":
            deployment.owned(partial=True)
            deployment.compose_run("up", "-d", "--no-build", "--pull", "never")
            deployment.owned()
            deployment.ready()
            state["phase"] = "stopping"
            deployment.save()
        if state["phase"] == "stopping":
            deployment.owned()
            docker("stop", "--time", "30", state["containers"]["app"])
            deployment.owned(stopped=True)
            state["phase"] = "importing"
            deployment.save()
        if state["phase"] == "importing":
            deployment.owned(stopped=True)
            deployment.store_disk_budget(manifest)
            if not deployment.claim(manifest):
                for chunk in manifest["chunks"]:
                    deployment.owned(stopped=True)
                    disk_budget(directory, manifest)
                    content = read_file(dataset / chunk["name"], MAX_CHUNK)
                    require(digest(content) == chunk["sha256"], "Chunk changed after validation")
                    rows = [json.loads(line) for line in content.splitlines()]
                    if chunk["store"] == "postgres":
                        deployment.import_pg(chunk, rows)
                    else:
                        deployment.import_ch(chunk, rows, content)
                    print(f"Verified {chunk['name']} ({chunk['rows']} rows)", flush=True)
            deployment.verify_all(manifest, dataset)
            deployment.owned(stopped=True)
            freshness(manifest)
            deployment.sql("UPDATE demo_import_state SET completed_at=(extract(epoch FROM clock_timestamp())*1000)::bigint WHERE singleton AND completed_at IS NULL;")
            state["phase"] = "publishing"
            deployment.save()
        if state["phase"] == "publishing":
            print("Publishing the verified demonstration and waiting for application readiness.", flush=True)
            # Keep the immutable bootstrap config and use one narrow, pinned
            # publication override; the application's container ID may change.
            override = {"services": {"app": {"ports": [{"target": 8080, "published": str(state["port"]), "host_ip": "127.0.0.1", "protocol": "tcp"}]}}}
            path = directory / "published.json"
            if path.exists():
                require(json.loads(read_file(path, 4096)) == override, "Publication override changed")
            else:
                save_json(path, override)
            deployment.owned(permit_new_app=True)
            command([*deployment.compose, "-f", str(path), "up", "-d", "--no-build", "--pull", "never", "--no-deps", "app"], env=deployment.env, timeout=180)
            deployment.owned(permit_new_app=True)
            deployment.ready()
            state["phase"] = "complete"
            deployment.save()
        require(state["phase"] == "complete", "Unknown import phase")
        print(f"Synthetic demo ready: http://localhost:{state['port']}\nPassword file: {directory / 'secrets/admin_password'}\nScenario ledger: {dataset / 'manifest.json'}\nVolumes are preserved; this workflow never deletes data.")
        for scenario in manifest["scenarios"]:
            print(scenario["name"] + ": http://localhost:" + str(state["port"]) + scenario["examples"][-1]["decision_path"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    plan = actions.add_parser("plan", help="Verify and describe a dataset without Docker")
    plan.add_argument("--dataset", type=Path, required=True)
    new = actions.add_parser("create", help="Provision a new owned deployment and import")
    new.add_argument("--dataset", type=Path, required=True)
    new.add_argument("--state", type=Path, required=True)
    new.add_argument("--image", default="krine:local", help="An already-built local image containing this migration")
    new.add_argument("--port", type=int, default=18080)
    continuation = actions.add_parser("resume", help="Resume an import using its private owner record")
    continuation.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    if args.action in ("plan", "create"):
        dataset = args.dataset.absolute()
        manifest, manifest_hash = verify_dataset(dataset)
        if args.action == "plan":
            print(canonical({"dataset_id": manifest["dataset_id"], "bytes": manifest["bytes"], "chunks": len(manifest["chunks"]),
                "events": manifest["counts"]["history/event"], "decisions": manifest["counts"]["history/decision"],
                "required_free_bytes": manifest["bytes"] * 4 + 4 * 1024 ** 3,
                "scenarios": [scenario["name"] for scenario in manifest["scenarios"]]}))
            return
        freshness(manifest)
        create(args.state.absolute(), dataset, manifest, manifest_hash, args.image, args.port)
    resume(args.state.absolute())


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print("Demo stopped: " + str(error) + ". Existing data and owned resources were preserved.", file=sys.stderr)
        sys.exit(1)
