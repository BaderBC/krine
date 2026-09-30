#!/usr/bin/env python3
"""Check the packaged dashboard/API boundary and operator login over HTTP."""
from operator_auth import authenticate
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import subprocess
import urllib.parse
import uuid
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
parsed = urllib.parse.urlsplit(base)
project = os.environ.get("COMPOSE_PROJECT_NAME", "")
if not (project == "krine-ci" or re.fullmatch(r"krine-test-[a-z0-9_-]+", project)):
    raise SystemExit("Packaged smoke checks require an owned krine-test-* or krine-ci project.")
if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username is not None
        or parsed.password is not None or parsed.path or parsed.query or parsed.fragment
        or parsed.port is None or base != f"http://127.0.0.1:{parsed.port}"):
    raise SystemExit("Packaged smoke checks require one exact IPv4 loopback origin and port.")
secrets = Path(os.environ.get("KRINE_SECRETS_DIR", "deploy/secrets")).resolve()
ids = subprocess.check_output(["docker", "ps", "-q", "--no-trunc", "--filter",
    "label=com.docker.compose.project=" + project, "--filter", "label=com.docker.compose.service=app"], text=True).split()
if len(ids) != 1:
    raise SystemExit("Require one running owned application container.")
container = json.loads(subprocess.check_output(["docker", "inspect", ids[0]], text=True))[0]
labels = container["Config"]["Labels"]
if (labels.get("com.docker.compose.project") != project or labels.get("com.docker.compose.service") != "app"
        or container["NetworkSettings"]["Ports"].get("8080/tcp") != [{"HostIp": "127.0.0.1", "HostPort": str(parsed.port)}]
        or not any(m["Destination"] == "/run/secrets/admin_password" and m["Type"] == "bind"
                   and Path(m["Source"]).resolve() == secrets / "admin_password" for m in container["Mounts"])):
    raise SystemExit("The URL or enrollment secret does not belong to this test application.")

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

jar = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPCookieProcessor(jar))

def request(path, *, accept=None, data=None, method=None, extra_headers=None):
    headers = {"Origin": base}
    headers.update(extra_headers or {})
    if accept:
        headers["Accept"] = accept
    if data is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(data).encode()
    try:
        response = http.open(urllib.request.Request(base + path, data=data, headers=headers, method=method), timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()

assert request("/health/ready")[0] == 200
status, headers, html = request("/checks/can_register", accept="text/html")
assert status == 200 and headers["Content-Type"].startswith("text/html")
assert "frame-ancestors 'none'" in headers["Content-Security-Policy"]
for path in ("/metrics/client.age_seconds", "/entities/ip/127.0.0.1", "/entities/user/alice%40example.com"):
    assert request(path, accept="text/html")[0] == 200, path
for path in (
    "/inspect/check?name=can_register",
    "/inspect/check?name=..&view=draft",
    "/inspect/event?id=..",
    "/inspect/event?id=%252e&return_to=%2Factivity%3Fkind%3Devents",
    "/inspect/entity?kind=user&id=%E9%9B%AA%2F%3F%23%26%25%20",
    "/inspect/entity?kind=ip&id=2001%3Adb8%3A%3A1",
):
    for method in ("GET", "HEAD"):
        status, headers, body = request(path, accept="text/html", method=method)
        assert status == 200 and headers["Content-Type"].startswith("text/html"), (method, path)
        assert int(headers["Content-Length"]) == len(html), (method, path)
        assert body == (html if method == "GET" else b""), (method, path)
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"], (method, path)
    assert request(path, accept="application/json")[0] == 404, path
    status, headers, _ = request(path, accept="text/html", method="POST")
    assert status == 405 and headers["Allow"] == "GET, HEAD", path
asset = re.search(rb'src="(/assets/[^" ]+\.js)"', html)
assert asset, "Dashboard entry script is missing"
assert request(asset[1].decode())[1]["Content-Type"].startswith("text/javascript")
for path in (
    "/assets/missing.js", "/.env", "/v1/missing", "/health/missing",
    "/inspect", "/inspect/unknown?id=..", "/inspect/check/extra?name=can_register",
    "/inspect/event/?id=..", "/inspect/entity.js?kind=user&id=alice",
):
    status, headers, body = request(path, accept="text/html")
    assert status == 404 and b'<!doctype' not in body.lower(), path
assert request("/checks", method="POST")[0] == 405
assert request("/v1/admin/checks")[0] == 401
def operator_request(path, data=None):
    status, _, body = request(path, data=data)
    assert status == 200, (path, status)
    return json.loads(body)
session = authenticate(operator_request, secrets)
csrf = session["csrf_token"]
actor_id = session["actor_id"]
assert request("/v1/admin/checks")[0] == 200
check_path = "/v1/admin/checks/deployment_smoke"
status, _, body = request(check_path)
if "--after-restart" in sys.argv[2:]:
    assert status == 200, "Check did not survive application restart"
elif status == 404:
    status, _, body = request("/v1/admin/checks", data={"name": "deployment_smoke", "description": "Deployment smoke fixture"},
                              extra_headers={"X-Krine-Operator-ID": actor_id, "X-CSRF-Token": csrf, "Idempotency-Key": str(uuid.uuid4())})
assert status == 200
assert json.loads(body)["name"] == "deployment_smoke"
print("Packaged dashboard, API boundary, operator login, and persistent check fixture passed.")
