#!/usr/bin/env python3
"""Run the small representative dataset through a new normal-image deployment.

Inject transport acknowledgment loss from this external harness, never through a
runtime/importer bypass. Preserve all data volumes and private owner records.
"""
import argparse
import http.cookiejar
import importlib.util
import ipaddress
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("krine_demo", Path(__file__).with_name("demo.py"))
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class LostAcknowledgment(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def api(base, state, manifest, completed_at):
    for address in socket.getaddrinfo("localhost", state["port"], type=socket.SOCK_STREAM):
        demo.require(ipaddress.ip_address(address[4][0]).is_loopback, "localhost resolved outside loopback")
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {"Origin": base, "Accept": "application/json", "Content-Type": "application/json"}
        try:
            with client.open(urllib.request.Request(base + path, data=data, headers=headers), timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, None

    demo.require(request("/v1/admin/installation")[0] == 401, "Installation context leaked without authentication")
    secret = demo.read_file(Path(state["secrets"]) / "admin_password", 128).decode().strip()
    demo.require(request("/v1/admin/session", {"password": secret})[0] == 200, "Demo operator login failed")
    status, installation = request("/v1/admin/installation")
    marker = installation["sample_data"] if status == 200 else None
    demo.require(marker and marker["dataset_id"] == manifest["dataset_id"] and marker["generator_version"] == manifest["configuration"]["generator_version"]
                 and marker["seed"] == manifest["configuration"]["seed"] and marker["from"] == manifest["from"]
                 and marker["to"] == manifest["to"] and marker["completed_at"] == completed_at, "Completed installation metadata differs")
    expected = {"dataset_id": manifest["dataset_id"], "generator_version": manifest["configuration"]["generator_version"]}
    for scenario in manifest["scenarios"]:
        # Include the last example so policy publication and relationship
        # correction can be inspected on both sides of their boundary.
        for example in [scenario["examples"][0], scenario["examples"][-1]]:
            status, decision = request("/v1/admin/activity/decisions/" + urllib.parse.quote(example["decision_id"], safe=""))
            demo.require(status == 200 and decision["sample_data"] == expected and decision["outcome"] == example["outcome"]
                         and decision["reason"] == example["reason"] and decision["completed_at"] is not None, "Historical decision inspection differs")
            status, entity = request("/v1/admin/entities/user/" + urllib.parse.quote(example["user_id"], safe=""))
            demo.require(status == 200 and entity["id"] == example["user_id"], "User investigation does not resolve")
    for kind in ("events", "decisions"):
        cursor, total, seen = None, 0, set()
        while True:
            query = {"from": manifest["from"], "to": manifest["to"], "limit": 100}
            if cursor:
                query["cursor"] = cursor
            status, page = request("/v1/admin/activity/" + kind + "?" + urllib.parse.urlencode(query))
            demo.require(status == 200, "Historical page unavailable")
            key = "event_id" if kind == "events" else "decision_id"
            for row in page["items"]:
                demo.require(row[key] not in seen, "Duplicate logical record in API pagination")
                seen.add(row[key])
            total += len(page["items"])
            cursor = page["next_cursor"]
            if not cursor:
                break
        demo.require(total == manifest["counts"]["history/" + ("event" if kind == "events" else "decision")], "API count differs from exact ledger")
    status, setup = request("/v1/admin/setup?check=can_claim_trial")
    demo.require(status == 200 and all(setup["observations"][key] is None for key in ("client_evidence", "backend_event", "check_attempt")), "Synthetic history forged live connection receipts")


def run(image):
    root = Path(tempfile.mkdtemp(prefix="krine-demo-verification-"))
    dataset, directory = root / "dataset", root / "deployment"
    anchor = str(int(time.time() * 1000))
    demo.command(["cargo", "run", "--locked", "--offline", "-p", "krine-demo", "--", "generate", "--output", str(dataset), "--anchor-ms", anchor, "--profile", "ci"], timeout=900)
    manifest, manifest_hash = demo.verify_dataset(dataset)
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    demo.create(directory, dataset, manifest, manifest_hash, image, port)
    print("Demo verification owner state: " + str(directory), flush=True)
    try:
        original_ch = demo.Deployment.ch
        fired = False

        def lose_history_ack(deployment, query, body=b""):
            nonlocal fired
            result = original_ch(deployment, query, body)
            if query.startswith("INSERT INTO history_v2") and not fired:
                fired = True
                raise LostAcknowledgment("ClickHouse accepted the chunk; client did not receive its acknowledgment")
            return result

        try:
            with patch.object(demo.Deployment, "ch", lose_history_ack):
                demo.resume(directory)
            raise RuntimeError("ClickHouse interruption was not reached")
        except LostAcknowledgment:
            pass
        state = json.loads((directory / "owner.json").read_text())
        deployment = demo.Deployment(directory, state)
        deployment.owned(stopped=True)
        demo.require(deployment.sql("SELECT completed_at IS NULL FROM demo_import_state;") == "t", "Partial import was marked complete")
        # A normal server process must refuse the incomplete singleton. Compose
        # creates only this temporary owned app container, then removes it.
        result = subprocess.run([*deployment.compose, "run", "--rm", "--no-deps", "-T", "app"], cwd=demo.REPO, env=deployment.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        demo.require(result.returncode != 0 and b"Demonstration import is incomplete" in result.stderr + result.stdout, "Incomplete import did not fence a normal server startup")
        deployment.owned(stopped=True)
        original_sql = demo.Deployment.sql
        fired = False

        def lose_postgres_ack(deployment, query):
            nonlocal fired
            result = original_sql(deployment, query)
            if query.startswith("BEGIN; INSERT INTO checks(") and not fired:
                fired = True
                raise LostAcknowledgment("PostgreSQL committed rows and chunk journal; client did not receive its acknowledgment")
            return result

        try:
            with patch.object(demo.Deployment, "sql", lose_postgres_ack):
                demo.resume(directory)
            raise RuntimeError("PostgreSQL interruption was not reached")
        except LostAcknowledgment:
            pass
        demo.resume(directory)
        state = json.loads((directory / "owner.json").read_text())
        deployment = demo.Deployment(directory, state)
        deployment.owned()
        completed_at = int(deployment.sql("SELECT completed_at FROM demo_import_state WHERE singleton;"))
        database_now = int(deployment.sql("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint;"))
        demo.require(manifest["to"] <= completed_at <= database_now, "Import completion is outside the history range and database clock")
        state["secrets"] = str(directory / "secrets")
        api(f"http://localhost:{port}", state, manifest, completed_at)
        # Starting a completed importer never changes the dataset or resets its
        # operator edits, sessions or live receipts.
        demo.resume(directory)
        demo.docker("restart", "--time", "30", state["containers"]["app"])
        deployment.ready()
        api(f"http://localhost:{port}", state, manifest, completed_at)
        print("Representative demo normal-image import, lost acknowledgments, startup fence, inspection, exact API totals and restart passed.", flush=True)
    finally:
        state = json.loads((directory / "owner.json").read_text())
        deployment = demo.Deployment(directory, state)
        # Refuse cleanup if resource ownership changed. Stop only this fixture's
        # exact IDs; all volumes and the resume record remain intact.
        deployment.owned(partial=True, permit_new_app=state["phase"] == "publishing")
        for service in ("app", "postgres", "clickhouse", "valkey"):
            identifier = deployment.state["containers"].get(service)
            if identifier:
                demo.docker("stop", "--time", "60", identifier)
        print("Owned demo containers stopped; data preserved at " + str(directory), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="krine:local")
    run(parser.parse_args().image)
