#!/usr/bin/env python3
"""Exercise the actual local ingress; creates policy only in a disposable test project."""
import concurrent.futures
import http.client
import http.cookiejar
import ipaddress
import json
import os
import re
import socket
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

if sys.argv[1:] != ["--provision-test-policy"]:
    raise SystemExit("Usage: scripts/smoke-example.py --provision-test-policy (disposable test project only)")
project = os.environ.get("COMPOSE_PROJECT_NAME", "")
if not (project.startswith("krine-test-") or project == "krine-ci"):
    raise SystemExit("Use a separate krine-test-* or krine-ci Compose project.")
compose = ["docker", "compose", "--env-file", "deploy/example/local.env.example", "-f", "compose.yaml",
           "-f", "compose.app.yaml", "-f", "compose.example.yaml"]
# Extra image-tag overrides are useful for offline local verification; CI uses the pinned defaults.
if os.environ.get("KRINE_SMOKE_COMPOSE_OVERRIDE"):
    compose += ["-f", os.environ["KRINE_SMOKE_COMPOSE_OVERRIDE"]]


def run(*args, **kwargs):
    return subprocess.run([*compose, *args], check=True, text=True, **kwargs)


config = json.loads(run("config", "--format", "json", capture_output=True).stdout)
assert config["name"] == project
services = config["services"]
krine = services["app"]["environment"]["KRINE_PUBLIC_URL"]
origin = services["example"]["environment"]["DEMO_ORIGIN"]
expected_bindings = {}
for url, target in ((krine, "8080/tcp"), (origin, "3000/tcp")):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != "http" or parsed.hostname not in ("localhost", "127.0.0.1")
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment):
        raise SystemExit("Smoke origins must be plain HTTP loopback origins without credentials or paths.")
    expected_bindings[target] = [{"HostIp": "127.0.0.1", "HostPort": str(parsed.port or 80)}]
assert not services["app"].get("ports") and not services["example"].get("ports")
assert set(services["example"]["networks"]) == {"example_ingress"}
proxy_ip = services["example-ingress"]["networks"]["example_ingress"]["ipv4_address"]
assert services["app"]["environment"]["KRINE_TRUSTED_PROXIES"] == proxy_ip + "/32"
assert services["example"]["environment"]["DEMO_TRUSTED_PROXIES"] == proxy_ip + "/32"
ids = {service: run("ps", "-q", service, capture_output=True).stdout.strip()
       for service in ("app", "example", "example-ingress")}
for service, container in ids.items():
    if len(container.split()) != 1:
        raise SystemExit(f"Require exactly one running {service} container in the disposable project.")
    state = json.loads(subprocess.check_output(["docker", "inspect", container], text=True))[0]
    labels = state["Config"]["Labels"]
    if (labels.get("com.docker.compose.project") != project
            or labels.get("com.docker.compose.service") != service or not state["State"]["Running"]):
        raise SystemExit("Refuse containers outside the running disposable Compose services.")
    assert set(state["NetworkSettings"]["Networks"]) == {
        config["networks"][name]["name"] for name in services[service]["networks"]}
    assert state["HostConfig"]["ReadonlyRootfs"]
    if service in ("app", "example"):
        assert not state["HostConfig"].get("PortBindings")
    else:
        assert state["NetworkSettings"]["Networks"][config["networks"]["example_ingress"]["name"]]["IPAddress"] == proxy_ip
        # Check configured AND effective publications before any credential read,
        # exec probe, or HTTP request. A stale origin must never target a native app.
        for mapping in (state["HostConfig"].get("PortBindings"), state["NetworkSettings"].get("Ports")):
            if any((mapping or {}).get(target) != binding for target, binding in expected_bindings.items()):
                raise SystemExit("Smoke HTTP origins do not match the owned ingress's exact loopback port bindings.")
status = run("exec", "-T", "example-ingress", "cat", "/proc/1/status", capture_output=True).stdout
assert re.search(r"Uid:\s+101\s+101\s+101\s+101", status)
assert re.search(r"CapEff:\s+0000000000000000", status)
assert re.search(r"NoNewPrivs:\s+1", status)
postgres_id = run("ps", "-q", "postgres", capture_output=True).stdout.strip()
postgres = json.loads(subprocess.check_output(["docker", "inspect", postgres_id], text=True))[0]
assert postgres["Config"]["Labels"]["com.docker.compose.project"] == project
storage_ip = postgres["NetworkSettings"]["Networks"][config["networks"]["storage"]["name"]]["IPAddress"]
run("exec", "-T", "--user", "10001:10001", "example", "node", "-e",
    "const s=require('node:net').connect({host:process.argv[1],port:5432});"
    "s.on('connect',()=>{s.destroy();process.exitCode=1});"
    "s.on('error',()=>{});s.setTimeout(1000,()=>s.destroy());", storage_ip)

# Inspect PID 1, rather than a root docker-exec process, to verify the real runtime.
probe = r'''
const fs=require('node:fs'), assert=require('node:assert/strict');
const status=fs.readFileSync('/proc/1/status','utf8');
assert.match(status,/Uid:\s+10001\s+10001\s+10001\s+10001/);
for(const name of ['CapEff','CapPrm','CapAmb']) assert.match(status,new RegExp(name+':\\s+0000000000000000'));
assert.match(status,/NoNewPrivs:\s+1/);
for(const name of ['browser_public_key','server_secret']) assert.throws(()=>fs.readFileSync('/run/secrets/'+name),{code:'EACCES'});
assert.throws(()=>fs.writeFileSync('/opt/draftroom/should-not-write','x'),{code:'EROFS'});
const dir=fs.statSync('/var/lib/draftroom');assert.equal(dir.uid,10001);assert.equal(dir.mode&511,448);
'''
run("exec", "-T", "--user", "10001:10001", "example", "node", "-e", probe)
accounts = json.loads(run("exec", "-T", "--user", "10001:10001", "example", "cat",
                          "/var/lib/draftroom/accounts.json", capture_output=True).stdout)
secrets = Path(config["secrets"]["admin_password"]["file"]).parent


class LoopbackConnection(http.client.HTTPConnection):
    def connect(self):
        # Keep the URL's Host/Origin/cookie semantics, but use the exact IPv4
        # interface whose Docker publication was verified (never localhost DNS).
        self.sock = socket.create_connection(("127.0.0.1", self.port), self.timeout, self.source_address)


class LoopbackHandler(urllib.request.HTTPHandler):
    def http_open(self, request):
        return self.do_open(LoopbackConnection, request)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def client():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), LoopbackHandler(), NoRedirect(),
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))


def request(http, base, path, data=None, headers=None, method=None, expected=200):
    headers = {"Origin": origin if base == origin else krine, **(headers or {})}
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        response = http.open(urllib.request.Request(base + path,
            data=None if data is None else json.dumps(data).encode(), headers=headers, method=method), timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        if "X-Krine-Public-Key" in headers:
            assert response.headers.get("Access-Control-Allow-Origin") == origin
        assert response.status == expected, (path, response.status, body)
        return json.loads(body) if body else None


operator = client()
csrf = request(operator, krine, "/v1/admin/session", {"password": (secrets / "admin_password").read_text().strip()})["csrf_token"]


def mutation(path, data, method=None):
    return request(operator, krine, path, data, {"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid.uuid4())}, method)


# Refuse to change an existing check: this harness is for a new disposable installation.
request(operator, krine, "/v1/admin/checks/can_claim_trial", expected=404)
check = mutation("/v1/admin/checks", {"name": "can_claim_trial", "description": "Disposable ingress smoke fixture"})
policy = {"schema_version": 1, "inputs": {}, "rules": [{"id": "shared_client",
          "condition": {"op": "compare", "left": {"source": "metric", "name": "client.user_count_30d", "version": 1},
                        "comparison": "gte", "value": 2}, "then": "DENY", "on_unknown": "DENY"}], "otherwise": "ALLOW"}
check = mutation("/v1/admin/checks/can_claim_trial/draft",
                 {"revision": check["draft_revision"], "description": check["description"], "policy": policy}, "PUT")
reviewed = request(operator, krine, "/v1/admin/checks/can_claim_trial")
assert reviewed["draft"] == policy
mutation("/v1/admin/checks/can_claim_trial/publications", {"revision": reviewed["draft_revision"], "expected_active_version": None})
public_key = Path(config["secrets"]["example_browser_public_key"]["file"]).read_text().strip()
# Each surface receives a different forged IP. Successful proof binding must use
# the ingress's socket peer, not either caller-supplied forwarding chain.
participation = {"Origin": origin, "X-Krine-Public-Key": public_key,
                 "X-Forwarded-For": "203.0.113.66", "Forwarded": 'for="203.0.113.66"'}
browser = client()
context = request(browser, krine, "/v1/browser/context", {"signals": {}}, participation)


def proof():
    return request(browser, krine, "/v1/browser/proofs", {"client_token": context["client_token"],
        "session_token": context["session_token"], "check": "can_claim_trial"}, participation)["proof"]


def account(name):
    http = client()
    login = request(http, origin, "/api/login", next(a for a in accounts if a["name"] == name))
    headers = {"X-CSRF-Token": login["csrf"], "X-Forwarded-For": "198.51.100.77",
               "Forwarded": 'for="198.51.100.77"'}
    return http, headers


ada, headers = account("ada")
intent = {"intent_id": str(uuid.uuid4()), "proof": proof()}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    results = list(pool.map(lambda _: request(ada, origin, "/api/trials", intent, headers), range(3)))
assert results[0] == results[1] == results[2]
allowed = results[0]
assert allowed["result"]["outcome"] == "ALLOW" and allowed["result"]["source"] == "evaluation"
assert allowed["result"]["decision_id"] and allowed["result"]["trial_until"]
ben, ben_headers = account("ben")
denied = request(ben, origin, "/api/trials", {"intent_id": str(uuid.uuid4()), "proof": proof()}, ben_headers)
assert denied["result"]["outcome"] == "DENY" and denied["result"]["source"] == "evaluation"
assert denied["result"]["trial_until"] is None
# Rotate only this disposable example to prefixed managed credentials. File
# overrides must not replace the core's immutable bootstrap configuration.
initial = request(operator, krine, "/v1/admin/credentials")["items"]
managed_browser = mutation("/v1/admin/credentials", {"kind": "browser", "label": "Ingress smoke browser"})
managed_server = mutation("/v1/admin/credentials", {"kind": "server", "label": "Ingress smoke server"})
public_key = managed_browser["credential"]["public_key"]
server_secret = managed_server["secret"]
assert public_key.startswith("pk_") and server_secret.startswith("sk_")
for variable, filename, value in (
    ("KRINE_EXAMPLE_PUBLIC_KEY_FILE", "smoke-example-browser-key", public_key),
    ("KRINE_EXAMPLE_SERVER_SECRET_FILE", "smoke-example-server-secret", server_secret),
):
    path = secrets / filename
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        file.write(value + "\n")
    os.environ[variable] = str(path)
for credential in initial:
    assert credential["source"] == "bootstrap", "Use a fresh disposable credential set"
    mutation("/v1/admin/credentials/" + credential["id"] + "/revocations", {})
participation["X-Krine-Public-Key"] = public_key
# Recreate both backend containers; Nginx must discover their new addresses.
run("up", "-d", "--force-recreate", "--no-deps", "--wait", "--wait-timeout", "120", "app", "example")
assert request(ada, origin, "/api/trials", intent, headers) == allowed
assert request(ada, origin, "/api/session")["trial_until"] == allowed["result"]["trial_until"]
public = request(client(), origin, "/api/config")
assert set(public) == {"url", "publicKey", "allowInsecureHttp"} and public["publicKey"] == public_key
assert server_secret not in json.dumps(public)
rotated = request(ben, origin, "/api/trials", {"intent_id": str(uuid.uuid4()), "proof": proof()}, ben_headers)
assert rotated["result"]["outcome"] == "DENY" and rotated["result"]["source"] == "evaluation"
assert rotated["result"]["decision_id"] != denied["result"]["decision_id"]
# SQLite's lifetime lock requires a stopped writer for this durable-state inspection.
run("stop", "example")
try:
    stored = json.loads(run("run", "--rm", "--no-deps", "--user", "10001:10001", "--entrypoint", "node", "example", "-e", r'''
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/var/lib/draftroom/application.sqlite',{readOnly:true});
console.log(JSON.stringify({grants:db.prepare('SELECT count(*) n FROM trials').get().n,
attempts:db.prepare('SELECT request,progress FROM attempts').all().map(a=>({request:JSON.parse(a.request),progress:JSON.parse(a.progress)}))}));
''', capture_output=True).stdout)
    assert stored["grants"] == 1 and len(stored["attempts"]) == 3
    observed = {a["request"]["ip"] for a in stored["attempts"]}
    assert len(observed) == 1
    observed_ip = observed.pop()
    ipaddress.ip_address(observed_ip)
    assert observed_ip not in ("203.0.113.66", "198.51.100.77", proxy_ip)
    logs = run("logs", "--no-color", "--no-log-prefix", "example-ingress", capture_output=True).stdout
    for path in ("/api/trials", "/v1/browser/proofs"):
        peers = {match[1] for match in re.finditer(r'(?m)^(\S+) \[.*?\] "POST ' + re.escape(path) + r'" 200$', logs)}
        assert peers == {observed_ip}, (path, peers, observed_ip)
    assert all(a["progress"]["associated"] and a["progress"]["event_sent"] for a in stored["attempts"])
finally:
    run("up", "-d", "--no-deps", "--wait", "--wait-timeout", "120", "example")
print(f"Ingress smoke passed: authentic peer {observed_ip}; evaluated Allow/Deny, one durable grant, retries/recreation/managed-key rotation, isolated network, zero-capability runtime.")
