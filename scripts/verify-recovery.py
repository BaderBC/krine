#!/usr/bin/env python3
"""Exercise the documented stopped-volume recovery in two new disposable projects.

This is a release verification fixture, not a production backup command. It never
removes volumes or accepts an existing project as its source or target.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import runpy
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import urllib.parse

REPO = Path(__file__).resolve().parent.parent
SERVICES = ("postgres", "valkey", "clickhouse", "app", "example", "example-ingress")
VOLUMES = {"postgres": ("postgres_data", "/var/lib/postgresql/data"),
           "valkey": ("valkey_data", "/data"),
           "clickhouse": ("clickhouse_data", "/var/lib/clickhouse"),
           "example": ("example_data", "/var/lib/draftroom")}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, **kwargs):
    # Caller records diagnostics in the private transcript. Never print request
    # bodies, subprocess arguments, captured stderr, or the effective config.
    result = subprocess.run(args, check=False, **kwargs)
    if result.returncode != 0 and kwargs.get("capture_output"):
        for value in (result.stdout, result.stderr):
            if value:
                print(value if isinstance(value, str) else value.decode(errors="replace"), file=sys.stderr)
    require(result.returncode == 0, "Recovery command failed; inspect the private transcript.")
    return result


def docker(*args, **kwargs):
    return command(["docker", *args], **kwargs)


def inspect(kind, name):
    return json.loads(docker(kind, "inspect", name, capture_output=True, text=True).stdout)[0]


def private_json(path, value):
    with path.open("x") as file:
        json.dump(value, file, indent=2)
        file.write("\n")


class Fixture:
    def __init__(self, project, env, override, token, root=REPO):
        require(re.fullmatch(r"krine-test-recovery-[a-f0-9]{12}-(source|target)", project),
                "Unexpected recovery project name.")
        self.project, self.token, self.root = project, token, root
        self.env = {**env, "COMPOSE_PROJECT_NAME": project}
        self.compose = ["docker", "compose", "--env-file", "deploy/example/local.env.example",
                        "-f", "compose.yaml", "-f", "compose.app.yaml", "-f", "compose.example.yaml",
                        "-f", str(override)]
        self.config = json.loads(self.run("config", "--format", "json", capture_output=True).stdout)
        require(self.config["name"] == project, "Compose project mismatch.")
        self.ids = {}

    def run(self, *args, **kwargs):
        return command([*self.compose, *args], env=self.env, cwd=self.root, text=True, **kwargs)

    def absent(self):
        for kind, listing in (("container", ["ps", "-aq"]), ("volume", ["volume", "ls", "-q"]),
                              ("network", ["network", "ls", "-q"])):
            found = docker(*listing, "--filter", "label=com.docker.compose.project=" + self.project,
                           capture_output=True, text=True).stdout.strip()
            require(not found, f"Refuse existing {kind} resources for recovery project.")
        for config in (self.config["volumes"], self.config["networks"]):
            for value in config.values():
                require(not value.get("external"), "Recovery requires owned resources.")
                # Names are generated solely from this run's random project.
                require(value["name"].startswith(self.project + "_"), "Foreign resource name.")
                kind = "volume" if config is self.config["volumes"] else "network"
                exists = subprocess.run(["docker", kind, "inspect", value["name"]], capture_output=True)
                require(exists.returncode != 0, "Refuse preexisting named recovery resource.")

    def cleanup(self):
        ids = docker("ps", "-aq", "--no-trunc", "--filter", "label=com.docker.compose.project=" + self.project,
                     capture_output=True, text=True).stdout.split()
        for container in ids:
            labels = inspect("container", container)["Config"]["Labels"]
            require(labels.get("com.docker.compose.project") == self.project
                    and labels.get("com.docker.compose.service") in SERVICES,
                    "Refuse cleanup of a foreign recovery container.")
        networks = docker("network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + self.project,
                          capture_output=True, text=True).stdout.split()
        expected = {network["name"] for network in self.config["networks"].values()}
        for network in networks:
            actual = inspect("network", network)
            require(actual["Labels"].get("com.docker.compose.project") == self.project
                    and actual["Name"] in expected and set(actual.get("Containers") or {}) <= set(ids),
                    "Refuse cleanup of a foreign or externally attached recovery network.")
        self.run("down")

    def refresh(self):
        for service in SERVICES:
            ids = self.run("ps", "-aq", service, capture_output=True).stdout.split()
            require(len(ids) == 1, "Require exactly one owned container per service.")
            info = inspect("container", ids[0])
            labels = info["Config"]["Labels"]
            require(labels.get("com.docker.compose.project") == self.project
                    and labels.get("com.docker.compose.service") == service,
                    "Recovery container ownership mismatch.")
            require(info["Image"] == self.config["services"][service]["image"],
                    "Actual service image differs from the resolved immutable image.")
            self.ids[service] = ids[0]

    def volume(self, service):
        key, destination = VOLUMES[service]
        info = inspect("container", self.ids[service])
        mounts = [m for m in info["Mounts"] if m["Destination"] == destination]
        require(len(mounts) == 1 and mounts[0]["Type"] == "volume", "Expected named data volume.")
        name = mounts[0]["Name"]
        require(name == self.config["volumes"][key]["name"], "Data volume/config mismatch.")
        labels = inspect("volume", name).get("Labels") or {}
        require(labels.get("com.docker.compose.project") == self.project
                and labels.get("com.docker.compose.volume") == key, "Data volume ownership mismatch.")
        attached = docker("ps", "-aq", "--no-trunc", "--filter", "volume=" + name,
                          capture_output=True, text=True).stdout.split()
        require(set(attached) == {self.ids[service]}, "Additional container attached to recovery data.")
        return name

    def stopped(self, service):
        state = inspect("container", self.ids[service])["State"]
        require(not state["Running"] and not state["Restarting"] and not state["OOMKilled"],
                "Service is still writing or was killed by memory exhaustion.")
        require(state["ExitCode"] == 0, "Require a successful graceful stop before copying data.")

    def sql(self, query):
        return self.run("exec", "-T", "postgres", "sh", "-c",
                        'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec psql '
                        '-h 127.0.0.1 -U krine -d krine -Atq -v ON_ERROR_STOP=1',
                        input=query, capture_output=True).stdout.strip()

    def ch(self, query, body=""):
        return self.run("exec", "-T", "clickhouse", "sh", "-c",
                        'CLICKHOUSE_PASSWORD="$(cat /run/secrets/clickhouse_password)" '
                        'exec clickhouse-client --host "$(hostname)" --user krine --database krine --query "$1"',
                        "recovery-query", query, input=body, capture_output=True).stdout.strip()

    def empty(self, service, image):
        name = self.volume(service)
        docker("run", "--rm", "--pull=never", "--network", "none", "--read-only",
               "--label", "krine.recovery=" + self.token, "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
               "--security-opt", "no-new-privileges:true", "--mount", "type=volume,source=" + name + ",target=/data,readonly",
               "--entrypoint", "/bin/sh", image, "-c", 'test -z "$(ls -A /data)"')

    def helper(self, service, image, restore=False, **kwargs):
        name = self.volume(service)
        mount = "type=volume,source=" + name + ",target=/data" + ("" if restore else ",readonly")
        caps = ["--cap-add", "DAC_OVERRIDE", "--cap-add", "CHOWN", "--cap-add", "FOWNER"] if restore else ["--cap-add", "DAC_READ_SEARCH"]
        return docker("run", "--rm", "-i", "--pull=never", "--network", "none", "--read-only",
                      "--label", "krine.recovery=" + self.token, "--security-opt", "no-new-privileges:true",
                      "--cap-drop", "ALL", *caps, "--mount", mount, "--entrypoint", "/bin/sh", image,
                      "-c", ('test -z "$(ls -A /data)" && exec tar --numeric-owner --same-owner '
                             '--same-permissions --acls --xattrs --delay-directory-restore -xpf - -C /data'
                             if restore else 'exec tar --numeric-owner --acls --xattrs -cpf - -C /data .'),
                      **kwargs)


def save_images(source, workspace):
    images = {service: inspect("container", source.ids[service])["Image"] for service in SERVICES}
    metadata = {image: inspect("image", image) for image in set(images.values())}
    estimate = sum(item["Size"] for item in metadata.values())
    archive_path = workspace / "images.tar"
    require(shutil.disk_usage(workspace).free > estimate * 2.2 + 4 * 1024**3,
            "Insufficient free space for image export, Docker temporary copy and the 4 GiB floor.")
    docker("image", "save", "-o", str(archive_path), *sorted(metadata))
    archive_path.chmod(0o600)
    expected = {image.removeprefix("sha256:") for image in metadata}
    configs, manifest = set(), None
    with tarfile.open(archive_path, "r|") as archive:
        for index, member in enumerate(archive):
            require(index < 100_000, "Unexpectedly large image archive catalog.")
            identifier = member.name.rsplit("/", 1)[-1].removesuffix(".json")
            if member.name == "manifest.json" or identifier in expected:
                require(member.isfile() and member.size <= 1_048_576, "Invalid image manifest/config entry.")
                payload = archive.extractfile(member).read(1_048_577)
                if member.name == "manifest.json":
                    require(manifest is None, "Duplicate image manifest.")
                    manifest = json.loads(payload)
                else:
                    require(hashlib.sha256(payload).hexdigest() == identifier, "Image config hash mismatch.")
                    config = json.loads(payload)
                    image = metadata["sha256:" + identifier]
                    require(config["architecture"] == image["Architecture"] and config["os"] == image["Os"],
                            "Image architecture mismatch.")
                    configs.add(identifier)
    require(manifest is not None and {entry["Config"].rsplit("/", 1)[-1].removesuffix(".json") for entry in manifest} == expected
            and configs == expected, "Archive does not contain every exact service image.")
    private_json(workspace / "image-platforms.json", {image: {"architecture": info["Architecture"], "os": info["Os"]}
                                                   for image, info in metadata.items()})
    return images


def publish(g, name, policy):
    check = g["mutation"]("/v1/admin/checks", {"name": name, "description": "Disposable recovery verification"})
    edited = g["mutation"](f"/v1/admin/checks/{name}/draft", {"revision": check["draft_revision"],
                          "description": check["description"], "policy": policy}, "PUT")
    return g["mutation"](f"/v1/admin/checks/{name}/publications", {
        "revision": edited["draft_revision"], "expected_active_version": None})


def fixture_state(g, source):
    request, http, base = g["request"], g["client"](), g["krine"]
    auth = {"Authorization": "Bearer " + g["server_secret"]}
    context = g["context"]
    event = {"event_id": "recovery-recent", "name": "recovery_probe", "user_id": "recovery-user",
             "client_id": context["client_id"], "session_id": context["session_id"], "ip": g["observed_ip"]}
    request(http, base, "/v1/events", event, auth)
    policy = {"schema_version": 1, "inputs": {}, "rules": [{"id": "has_event", "condition": {
        "op": "compare", "left": {"source": "metric", "name": "ip.event_count_5m", "version": 1},
        "comparison": "gte", "value": 1}, "then": "ALLOW", "on_unknown": "DENY"}], "otherwise": "DENY"}
    publish(g, "recovery_check", policy)
    proof = request(http, base, "/v1/browser/proofs", {"client_token": context["client_token"],
        "session_token": context["session_token"], "check": "recovery_check"}, g["participation"])["proof"]
    operation = {"operation_id": "recovery-recorded", "check": "recovery_check", "proof": proof,
                 "ip": g["observed_ip"], "user_id": "recovery-user"}
    decision = request(http, base, "/v1/checks/evaluate", operation, auth)
    require(decision["outcome"] == "ALLOW", "Authoritative source event/check failed.")
    histories = {}
    for name, restored in (("recovery-corrected", False), ("recovery-restored", True)):
        association = request(http, base, "/v1/associations", {"association_id": name,
            "client_id": context["client_id"], "session_id": context["session_id"],
            "user_id": name}, auth)
        path = "/v1/admin/relationships/backend/" + name
        corrected = g["mutation"](path + "/corrections", {"revision": association["revision"],
                                                            "reason": "Recovery correction fixture"})
        if restored:
            g["mutation"](path + "/restorations", {"revision": corrected["relationship"]["revision"],
                                                      "reason": "Recovery restoration fixture"})
        histories[name] = request(g["operator"], base, path)
    # This record is deliberately older than the PG reliability horizon. Only
    # its fixture timestamp/retention state is changed, never the host clock.
    old = {"event_id": "recovery-old-history", "name": "recovery_archived", "user_id": "recovery-history-user"}
    request(http, base, "/v1/events", old, auth)
    for _ in range(100):
        if source.sql("SELECT count(*) FROM delivery_outbox WHERE logical_id='event:recovery-old-history' AND exported_at IS NOT NULL;") == "1":
            break
        time.sleep(.1)
    else:
        raise RuntimeError("Old history fixture did not export.")
    row = json.loads(source.ch("SELECT * FROM history_v2 FINAL WHERE id='event:recovery-old-history' FORMAT JSONEachRow"))
    row["at"] = int(row["at"]) - 72 * 60 * 60 * 1000
    payload = json.loads(row["payload"])
    payload["accepted_at"] = row["at"]
    row["payload"] = json.dumps(payload)
    row["revision"] = int(row["revision"]) + 1
    source.ch("INSERT INTO history_v2 FORMAT JSONEachRow", json.dumps(row) + "\n")
    # DELETE triggers do not depend on the writer generation. Simulate normal
    # acknowledged-envelope expiry; require evidence before removing fixture rows.
    source.sql("BEGIN; DELETE FROM events WHERE id='recovery-old-history'; DELETE FROM delivery_outbox WHERE logical_id='event:recovery-old-history' AND exported_at IS NOT NULL; COMMIT;")
    require(source.sql("SELECT (SELECT count(*) FROM events WHERE id='recovery-old-history') + (SELECT count(*) FROM delivery_outbox WHERE logical_id='event:recovery-old-history');") == "0", "Old record remains rebuildable from PostgreSQL.")
    old_detail = request(g["operator"], base, "/v1/admin/activity/events/recovery-old-history")
    decision_detail = request(g["operator"], base, "/v1/admin/activity/decisions/" + decision["decision_id"])
    candidate = {"revision": 0, "provider": "turnstile", "enabled": True,
                 "config": {"site_key": "recovery-format-only", "secret": secrets.token_hex(32)}}
    tested = g["mutation"]("/v1/admin/providers/verification/tests", candidate)
    require(tested["status"] == "configuration_checked", "Expected format-only provider check.")
    g["mutation"]("/v1/admin/providers/verification", {**candidate, "test_token": tested["test_token"]}, "PUT")
    publish(g, "recovery_pending", {"schema_version": 1, "inputs": {"verify": "boolean"},
            "rules": [{"id": "verify", "condition": {"op": "compare", "left": {"source": "input", "name": "verify"},
                       "comparison": "eq", "value": True}, "then": "CHALLENGE", "on_unknown": "DENY"}], "otherwise": "DENY"})
    pending_proof = request(http, base, "/v1/browser/proofs", {"client_token": context["client_token"],
        "session_token": context["session_token"], "check": "recovery_pending"}, g["participation"])["proof"]
    pending_operation = {"operation_id": "recovery-pending", "check": "recovery_pending", "proof": pending_proof,
                         "ip": g["observed_ip"], "inputs": {"verify": True}}
    pending = request(http, base, "/v1/checks/evaluate", pending_operation, auth)
    require(pending["outcome"] == "CHALLENGE_REQUIRED", "Source pending attempt did not persist.")
    pending_received = time.monotonic()
    return {"pending_received_monotonic": pending_received, "pending_operation": pending_operation, "pending": pending, "event": event, "operation": operation, "decision": decision, "relationships": histories,
            "old_history": old_detail, "decision_detail": decision_detail,
            "credentials": request(g["operator"], base, "/v1/admin/credentials"),
            "source_generation": source.sql("SELECT generation FROM projection_state;")}



def retained_events(fixture):
    # Only durable authoritative envelopes define the rebuild oracle. Source
    # hot state is not the backup’s authoritative record set.
    return json.loads(fixture.sql("SELECT COALESCE(json_agg(json_build_object('id',id,'ip',envelope->>'ip',"
                                  "'accepted_at',accepted_at) ORDER BY id),'[]'::json) FROM events;"))


def assert_event_count(metric, events, ip):
    require(metric["version"] == 1, "Unexpected event-count metric version.")
    at = metric["provenance"]["observed_at"]
    require(type(at) is int, "Metric observation time must be integer milliseconds.")
    expected = len({event["id"] for event in events
                    if event["ip"] == ip and at - 300_000 <= event["accepted_at"] <= at})
    state = metric["state"]
    require(state.get("status") == "known" and type(state.get("value")) in (int, float)
            and state["value"] == expected,
            f"Authoritative counter mismatch: expected exactly {expected} retained events.")
    return expected


def verify_restored(g, target, expected):
    request, base, auth = g["request"], g["krine"], {"Authorization": "Bearer " + g["server_secret"]}
    operator = g["client"]()
    request(operator, base, "/v1/admin/session", {"password": (g["secrets"] / "admin_password").read_text().strip()})
    require(request(operator, base, "/v1/admin/credentials") == expected["credentials"], "Credential metadata changed on restore.")
    # No provider token is submitted: this proves durable pending recovery, not
    # live provider pairing or successful challenge verification.
    recovered_pending = request(g["client"](), base, "/v1/checks/evaluate", expected["pending_operation"], auth)
    pending_recovery_ms = round((time.monotonic() - expected["pending_received_monotonic"]) * 1000)
    require(recovered_pending == expected["pending"], "Pending attempt expired or changed before recovery; rerun within five minutes.")
    require(request(g["client"](), base, "/v1/checks/evaluate", expected["operation"], auth) == expected["decision"], "Recorded operation did not recover exactly.")
    request(g["client"](), base, "/v1/checks/evaluate", {**expected["operation"], "operation_id": "recovery-stolen-proof"}, auth, expected=409)
    require(request(operator, base, "/v1/admin/activity/decisions/" + expected["decision"]["decision_id"]) == expected["decision_detail"], "Historical decision changed on restore.")
    require(request(operator, base, "/v1/admin/activity/events/recovery-old-history") == expected["old_history"], "Historical event was not restored from ClickHouse.")
    require(target.sql("SELECT count(*) FROM delivery_outbox WHERE logical_id='event:recovery-old-history';") == "0", "Old history unexpectedly came from an outbox.")
    for name, relationship in expected["relationships"].items():
        require(request(operator, base, "/v1/admin/relationships/backend/" + name) == relationship, "Relationship audit/current state changed.")
    for kind, path, body, headers in (
        ("server", "/v1/contexts/resolve", {"client_token": g["context"]["client_token"], "session_token": g["context"]["session_token"]},
         {"Authorization": "Bearer " + (g["secrets"] / "server_secret").read_text().strip()}),
        ("browser", "/v1/browser/context", {"signals": {}}, {**g["participation"], "X-Krine-Public-Key": (g["secrets"] / "browser_public_key").read_text().strip()}),
    ):
        request(g["client"](), base, path, body, headers, expected=401)
    target_now = int(target.sql("SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint;"))
    remaining_context_ms = g["context"]["expires_at"] - target_now
    require(remaining_context_ms > 0, "Context expired naturally; cannot attribute its invalidation to recovery.")
    request(g["client"](), base, "/v1/contexts/resolve", {"client_token": g["context"]["client_token"],
            "session_token": g["context"]["session_token"]}, auth, expected=422)
    fresh = request(g["client"](), base, "/v1/browser/context", {"client_token": g["context"]["client_token"],
                    "session_token": g["context"]["session_token"], "signals": {}}, g["participation"])
    require(fresh["client_id"] != g["context"]["client_id"] and fresh["session_id"] != g["context"]["session_id"],
            "Old browser credentials survived the empty-Valkey restore.")
    require(target.sql("SELECT generation FROM projection_state;") != expected["source_generation"], "Projection generation was reused.")
    # The restored host/network may expose a different actual peer. Inspect the
    # retained IP counter independently, then bind each new action to the new
    # ingress observation; never rewrite the old operation's immutable IP.
    require(retained_events(target) == expected["retained_events"], "Restored authoritative event envelopes changed.")
    entity = request(operator, base, "/v1/admin/entities/ip/" + urllib.parse.quote(g["observed_ip"], safe=""))
    retained_count = assert_event_count(entity["metrics"]["ip.event_count_5m"], expected["retained_events"], g["observed_ip"])
    require(retained_count > 0, "Recovery fixture no longer has current authoritative events.")
    proof = request(g["client"](), base, "/v1/browser/proofs", {"client_token": fresh["client_token"],
                    "session_token": fresh["session_token"], "check": "recovery_check"}, g["participation"])["proof"]
    log = target.run("logs", "--no-color", "--no-log-prefix", "example-ingress", capture_output=True).stdout
    peers = re.findall(r'(?m)^(\S+) \[.*?\] "POST /v1/browser/proofs" 200$', log)
    require(bool(peers), "Missing restored ingress observation for the fresh proof.")
    target_ip = str(ipaddress.ip_address(peers[-1]))
    event_ack = request(g["client"](), base, "/v1/events", {"event_id": "recovery-after-restore", "name": "recovered",
            "client_id": fresh["client_id"], "session_id": fresh["session_id"], "ip": target_ip}, auth)
    checked = request(g["client"](), base, "/v1/checks/evaluate", {"operation_id": "recovery-new",
                      "check": "recovery_check", "proof": proof, "ip": target_ip}, auth)
    require(checked["outcome"] == "ALLOW", "Fresh authoritative event/check did not recover.")
    fresh_events = [*expected["retained_events"], {"id": "recovery-after-restore", "ip": target_ip,
                                                "accepted_at": event_ack["accepted_at"]}]
    fresh_detail = request(operator, base, "/v1/admin/activity/decisions/" + checked["decision_id"])
    fresh_count = assert_event_count(fresh_detail["snapshot"]["metrics"]["ip.event_count_5m"], fresh_events, target_ip)
    ada, headers = g["account"]("ada")
    require(request(ada, g["origin"], "/api/trials", g["intent"], headers) == g["allowed"], "Durable business grant retry changed.")
    require(request(ada, g["origin"], "/api/session")["trial_until"] == g["allowed"]["result"]["trial_until"], "Business grant lost.")
    target.run("stop", "example")
    target.stopped("example")
    stored = target.run("run", "--rm", "--no-deps", "--user", "10001:10001", "--entrypoint", "node", "example", "-e",
        "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/var/lib/draftroom/application.sqlite',{readOnly:true});console.log(d.prepare('SELECT count(*) n FROM trials').get().n)", capture_output=True).stdout.strip()
    require(stored == "1", "Business grant executed more than once.")
    return fresh["client_id"], {"pending_recovery_ms": pending_recovery_ms, "old_context_remaining_ms": remaining_context_ms,
                                "retained_ip_count": retained_count, "fresh_ip_count": fresh_count,
                                "source_ip": g["observed_ip"], "target_ip": target_ip}


def execute(args, workspace):
    staged = workspace / "config"
    shutil.copytree(REPO / "deploy", staged / "deploy", ignore=shutil.ignore_patterns("secrets"))
    for name in ("compose.yaml", "compose.app.yaml", "compose.example.yaml"):
        shutil.copy2(REPO / name, staged / name)
    token = secrets.token_hex(6)
    env = {key: value for key, value in os.environ.items() if not key.startswith(("KRINE_", "COMPOSE_"))}
    env.update({"KRINE_HTTP_PORT": str(args.api_port), "KRINE_EXAMPLE_PORT": str(args.example_port),
                "KRINE_EXAMPLE_NETWORK_PREFIX": args.network_prefix,
                "KRINE_PUBLIC_URL": f"http://127.0.0.1:{args.api_port}",
                "KRINE_ALLOWED_ORIGINS": f"http://localhost:{args.example_port}", "KRINE_DEVELOPMENT": "true",
                "KRINE_SECRETS_DIR": str(workspace / "source-secrets")})
    images = {"app": args.image, "example": args.example_image, "example-ingress": args.ingress_image}
    pinned = {service: inspect("image", image)["Id"] for service, image in images.items()}
    override = workspace / "images.json"
    private_json(override, {"services": {service: {"image": image, "labels": {"krine.recovery": token}}
                                        for service, image in pinned.items()}})
    source = Fixture(f"krine-test-recovery-{token}-source", env, override, token, root=staged)
    for service in ("postgres", "valkey", "clickhouse"):
        reference = getattr(args, service + "_image") or source.config["services"][service]["image"]
        pinned[service] = inspect("image", reference)["Id"]
    override.write_text(json.dumps({"services": {service: {"image": image, "labels": {"krine.recovery": token}}
                                               for service, image in pinned.items()}}))
    source = Fixture(f"krine-test-recovery-{token}-source", env, override, token, root=staged)
    source.absent()
    source.env["KRINE_SMOKE_COMPOSE_OVERRIDE"] = str(override)
    command(["./scripts/init-secrets.sh"], env=source.env, cwd=REPO)
    fixtures = [source]
    try:
        source.run("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
        source.refresh()
        saved_images = save_images(source, workspace)
        old_env = os.environ.copy()
        old_cwd = Path.cwd()
        try:
            os.chdir(staged)
            os.environ.clear()
            os.environ.update(source.env)
            original_argv = sys.argv
            sys.argv = ["scripts/smoke-example.py", "--provision-test-policy"]
            g = runpy.run_path(str(REPO / "scripts/smoke-example.py"), run_name="__recovery_fixture__")
            source.env.update({key: value for key, value in os.environ.items() if key.startswith("KRINE_")})
        finally:
            os.chdir(old_cwd)
            os.environ.clear()
            os.environ.update(old_env)
            sys.argv = original_argv
        source.refresh()
        state = fixture_state(g, source)
        source.run("stop", "example-ingress")
        source.run("stop", "example")
        source.run("stop", "app")
        for service in ("example-ingress", "example", "app"):
            source.stopped(service)
        source.refresh()
        state["retained_events"] = retained_events(source)
        private_json(workspace / "expected.json", state)
        # Capture a full custom-format dump while every application writer is
        # stopped. No exclusion can silently omit future durable tables.
        with (workspace / "postgres.dump").open("xb") as out:
            docker("exec", source.ids["postgres"], "sh", "-c",
                   'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec pg_dump -h 127.0.0.1 -U krine -d krine -Fc', stdout=out)
        source.run("stop", "clickhouse")
        source.stopped("clickhouse")
        helper_image = inspect("container", source.ids["postgres"])["Image"]
        for service in ("clickhouse", "example"):
            require(shutil.disk_usage(workspace).free > 4 * 1024**3, "Recovery reached the 4 GiB free-space floor.")
            with (workspace / (service + ".tar")).open("xb") as out:
                source.helper(service, helper_image, stdout=out)
        config = json.loads(source.run("config", "--format", "json", capture_output=True).stdout)
        private_json(workspace / "source-config.json", config)
        actual_images = {service: inspect("container", source.ids[service])["Image"] for service in SERVICES}
        require(actual_images == saved_images, "Service images changed after image archive creation.")
        private_json(workspace / "images.json.manifest", actual_images)
        source.cleanup()  # Preserve all source volumes; free the shared origins/subnet.
        target_env = dict(source.env)
        shutil.copytree(workspace / "source-secrets", workspace / "target-secrets")
        target_env["KRINE_SECRETS_DIR"] = str(workspace / "target-secrets")
        for variable in ("KRINE_EXAMPLE_PUBLIC_KEY_FILE", "KRINE_EXAMPLE_SERVER_SECRET_FILE"):
            target_env[variable] = str(workspace / "target-secrets" / Path(target_env[variable]).name)
        restore_images = workspace / "restore-images.json"
        private_json(restore_images, {"services": {service: {"image": image}
                                                for service, image in actual_images.items()}})
        target = Fixture(f"krine-test-recovery-{token}-target", target_env, restore_images, token,
                         root=workspace / "config")
        target.absent()
        fixtures.append(target)
        target.run("create", "--no-build", "--pull", "never")
        target.refresh()
        for service in VOLUMES:
            target.empty(service, helper_image)
        for service in ("clickhouse", "example"):
            with (workspace / (service + ".tar")).open("rb") as archive:
                target.helper(service, helper_image, restore=True, stdin=archive)
            # A second restore must fail before overwriting an initialized
            # volume. This probe uses the same valid archive, never foreign data.
            try:
                with (workspace / (service + ".tar")).open("rb") as archive:
                    target.helper(service, helper_image, restore=True, stdin=archive, capture_output=True)
            except RuntimeError:
                pass
            else:
                raise RuntimeError("Restore overwrote an already populated target volume.")
        target.run("up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "postgres")
        require(target.sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';") == "0", "Refuse nonempty target database.")
        with (workspace / "postgres.dump").open("rb") as archive:
            docker("exec", "-i", target.ids["postgres"], "sh", "-c",
                   'PGPASSWORD="$(cat /run/secrets/postgres_password)" exec pg_restore -h 127.0.0.1 -U krine -d krine '
                   '--no-owner --no-acl --single-transaction --exit-on-error', stdin=archive)
        target.run("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
        target.refresh()
        require({service: inspect("container", target.ids[service])["Image"] for service in SERVICES} == actual_images,
                "Restored service image differs from the captured exact image.")
        # The smoke helpers capture source URLs but all source containers are now
        # gone; verify those exact ports belong to the new target ingress first.
        ingress = inspect("container", target.ids["example-ingress"])
        expected_ports = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(args.api_port)}],
                          "3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(args.example_port)}]}
        for key, bindings in expected_ports.items():
            require(ingress["NetworkSettings"]["Ports"].get(key) == bindings, "Restored endpoint does not belong to target.")
        target_client, timings = verify_restored(g, target, state)
        target.cleanup()
        source.run("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180")
        source.refresh()
        # Read the preserved source again. Target-only writes must not appear in
        # it, and neither its identities nor its captured decisions may change.
        require(source.sql("SELECT count(*) FROM operations WHERE id='recovery-new';") == "0", "Target write reached source.")
        require(g["request"](g["operator"], g["krine"], "/v1/admin/credentials") == state["credentials"], "Source credentials changed.")
        for name, relationship in state["relationships"].items():
            require(g["request"](g["operator"], g["krine"], "/v1/admin/relationships/backend/" + name) == relationship,
                    "Source relationship history changed.")
        require(source.sql("SELECT count(*) FROM entities WHERE id='" + target_client.replace("'", "''") + "';") == "0", "Target identity reached source.")
        require(g["request"](g["operator"], g["krine"], "/v1/admin/activity/decisions/" + state["decision"]["decision_id"]) == state["decision_detail"], "Source historical decision changed.")
        require(g["request"](g["operator"], g["krine"], "/v1/admin/activity/events/recovery-old-history") == state["old_history"], "Source historical event changed.")
        hashes = {}
        for name in ("postgres.dump", "clickhouse.tar", "example.tar", "images.tar"):
            digest = hashlib.sha256()
            with (workspace / name).open("rb") as file:
                for chunk in iter(lambda: file.read(1024 * 1024), b""):
                    digest.update(chunk)
            hashes[name] = digest.hexdigest()
        result = {"passed": True, "source": source.project, "target": target.project,
                     "revision": command(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True, text=True).stdout.strip(),
                     "images": actual_images, "sha256": hashes, "timings": timings,
                     "image_archive": "created_and_validated",
                     "evidence": ["old history absent from PG outbox", "recorded decision and proof ownership",
                                  "corrected/restored relationship audit", "revocation and permanent bootstrap",
                                  "fresh context and counter generation", "one durable business grant",
                                  "pending challenge without provider call", "source preserved independently"]}
    finally:
        # Retain every volume and private artifact for independent review. Failed
        # cleanup is an error, not permission to remove resources more broadly.
        errors = []
        for fixture in reversed(fixtures):
            try:
                fixture.cleanup()
            except (RuntimeError, OSError) as error:
                errors.append(str(error))
        if errors:
            failure = sys.exception()
            message = "Could not cleanly stop/remove owned recovery containers and networks; inspect its private transcript."
            if failure is not None:
                failure.add_note(message)
            else:
                raise RuntimeError(message)

    private_json(workspace / "result.json", result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="already-built reviewed Krine image")
    parser.add_argument("--example-image", required=True)
    parser.add_argument("--ingress-image", required=True)
    for service in ("postgres", "valkey", "clickhouse"):
        parser.add_argument("--" + service + "-image", help="reviewed local store image override; defaults to pinned Compose reference")
    parser.add_argument("--artifacts-parent", help="existing private directory shared with Docker; defaults to the system temporary directory")
    parser.add_argument("--api-port", type=int, default=39080)
    parser.add_argument("--example-port", type=int, default=34000)
    parser.add_argument("--network-prefix", default="10.203.85")
    args = parser.parse_args()
    require(1024 <= args.api_port <= 65535 and 1024 <= args.example_port <= 65535 and args.api_port != args.example_port,
            "Use two distinct unprivileged loopback ports.")
    require(re.fullmatch(r"10\.(?:\d{1,3})\.(?:\d{1,3})", args.network_prefix)
            and all(int(part) <= 255 for part in args.network_prefix.split(".")), "Use an unused private 10.x.y subnet.")
    os.umask(0o077)
    workspace = Path(tempfile.mkdtemp(prefix="krine-recovery-", dir=args.artifacts_parent))
    print(f"Recovery evidence directory: {workspace}", flush=True)
    # Include tracebacks/subprocess output only in owner-readable local evidence.
    with (workspace / "transcript.log").open("x") as log:
        saved_out, saved_err = os.dup(1), os.dup(2)
        try:
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
            execute(args, workspace)
        except BaseException:
            import traceback
            traceback.print_exc()
            success = False
        else:
            success = True
        finally:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(saved_out, 1)
            os.dup2(saved_err, 2)
            os.close(saved_out)
            os.close(saved_err)
    print("Recovery verification passed." if success else "Recovery verification failed; inspect the private transcript.")
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
