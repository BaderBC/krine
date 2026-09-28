#!/usr/bin/env python3
"""Check the packaged dashboard/API boundary and operator login over HTTP."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import sys
import uuid
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
jar = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

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
asset = re.search(rb'src="(/assets/[^" ]+\.js)"', html)
assert asset, "Dashboard entry script is missing"
assert request(asset[1].decode())[1]["Content-Type"].startswith("text/javascript")
for path in ("/assets/missing.js", "/.env", "/v1/missing", "/health/missing"):
    status, headers, body = request(path, accept="text/html")
    assert status >= 400 and b'<!doctype' not in body.lower(), path
assert request("/checks", method="POST")[0] == 405
assert request("/v1/admin/checks")[0] == 401
secrets = Path(os.environ.get("KRINE_SECRETS_DIR", "deploy/secrets"))
status, _, body = request("/v1/admin/session", data={"password": (secrets / "admin_password").read_text().strip()})
assert status == 200
csrf = json.loads(body)["csrf_token"]
assert request("/v1/admin/checks")[0] == 200
check_path = "/v1/admin/checks/deployment_smoke"
status, _, body = request(check_path)
if "--after-restart" in sys.argv[2:]:
    assert status == 200, "Check did not survive application restart"
elif status == 404:
    status, _, body = request("/v1/admin/checks", data={"name": "deployment_smoke", "description": "Deployment smoke fixture"},
                              extra_headers={"X-CSRF-Token": csrf, "Idempotency-Key": str(uuid.uuid4())})
assert status == 200
assert json.loads(body)["name"] == "deployment_smoke"
print("Packaged dashboard, API boundary, operator login, and persistent check fixture passed.")
