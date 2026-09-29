#!/usr/bin/env python3
"""Prove the smoke harness rejects foreign HTTP endpoints before secrets or I/O."""
import ast
import copy
import http.client
import http.cookiejar
import json
import os
from pathlib import Path
import runpy
import socket
import subprocess
import sys
import urllib.request
from unittest.mock import patch

helper = Path(__file__).with_name("smoke-example.py")
project = "krine-test-isolation"
config = {
    "name": project,
    "services": {
        "app": {"environment": {"KRINE_PUBLIC_URL": "http://127.0.0.1:38080",
                                "KRINE_TRUSTED_PROXIES": "10.203.80.2/32"},
                "networks": {"storage": {}, "application": {}, "example_ingress": {}}},
        "example": {"environment": {"DEMO_ORIGIN": "http://localhost:33000",
                                    "DEMO_TRUSTED_PROXIES": "10.203.80.2/32"},
                    "networks": {"example_ingress": {}}},
        "example-ingress": {"networks": {"application": {}, "example_ingress": {"ipv4_address": "10.203.80.2"}}},
    },
    "networks": {name: {"name": f"{project}_{name}"} for name in ("application", "storage", "example_ingress")},
}
containers = {
    service: {
        "State": {"Running": True},
        "Config": {"Labels": {"com.docker.compose.project": project, "com.docker.compose.service": service}},
        "HostConfig": {"ReadonlyRootfs": True, "PortBindings": {}},
        "NetworkSettings": {"Networks": {f"{project}_{name}": {"IPAddress": "10.203.80.2"}
                                        for name in values["networks"]}, "Ports": {}},
    }
    for service, values in config["services"].items()
}
bindings = {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "38080"}],
            "3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "33000"}]}
containers["example-ingress"]["HostConfig"]["PortBindings"] = copy.deepcopy(bindings)
containers["example-ingress"]["NetworkSettings"]["Ports"] = copy.deepcopy(bindings)


class GuardPassed(Exception):
    pass


def check(changed_config, changed_containers, accepted=False):
    def compose(command, **kwargs):
        if command[-3:] == ["config", "--format", "json"]:
            return subprocess.CompletedProcess(command, 0, json.dumps(changed_config))
        if command[-3:-1] == ["ps", "-q"]:
            return subprocess.CompletedProcess(command, 0, command[-1])
        # The first permitted action after ownership validation is the runtime
        # probe. No probe, credential file access or HTTP is allowed on failure.
        if accepted and command[-5:] == ["exec", "-T", "example-ingress", "cat", "/proc/1/status"]:
            raise GuardPassed()
        raise AssertionError(f"Unsafe action before rejecting endpoint ownership: {command}")

    def inspect(command, **kwargs):
        assert command[:2] == ["docker", "inspect"]
        return json.dumps([changed_containers[command[2]]])

    with patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": project}, clear=True), \
            patch.object(sys, "argv", [str(helper), "--provision-test-policy"]), \
            patch("subprocess.run", side_effect=compose), \
            patch("subprocess.check_output", side_effect=inspect), \
            patch("pathlib.Path.read_text", side_effect=AssertionError("Credential read before guard")), \
            patch("urllib.request.build_opener", side_effect=AssertionError("HTTP before guard")):
        try:
            runpy.run_path(str(helper), run_name="__main__")
        except GuardPassed:
            assert accepted
        except SystemExit as error:
            assert not accepted and error.code, error
            assert any(fragment in str(error) for fragment in ("port bindings", "plain HTTP", "disposable Compose")), error
        else:
            raise AssertionError("Harness did not terminate at the isolation boundary")


check(config, containers, accepted=True)
cases = 0
for service, variable, bad_url in (
    ("app", "KRINE_PUBLIC_URL", "http://127.0.0.1:8080"),
    ("example", "DEMO_ORIGIN", "http://localhost:3000"),
    ("app", "KRINE_PUBLIC_URL", "http://user:password@127.0.0.1:38080"),
    ("example", "DEMO_ORIGIN", "http://localhost:33000/path"),
    ("app", "KRINE_PUBLIC_URL", "http://example.com:38080"),
):
    changed = copy.deepcopy(config)
    changed["services"][service]["environment"][variable] = bad_url
    check(changed, containers)
    cases += 1
for section, key in (("HostConfig", "PortBindings"), ("NetworkSettings", "Ports")):
    for target in bindings:
        for bad_binding in (None, [{"HostIp": "0.0.0.0", "HostPort": bindings[target][0]["HostPort"]}],
                            [{"HostIp": "127.0.0.1", "HostPort": "8080"}]):
            changed = copy.deepcopy(containers)
            changed["example-ingress"][section][key][target] = bad_binding
            check(config, changed)
            cases += 1
for field in ("project", "service"):
    changed = copy.deepcopy(containers)
    changed["example-ingress"]["Config"]["Labels"][f"com.docker.compose.{field}"] = "foreign"
    check(config, changed)
    cases += 1
changed = copy.deepcopy(containers)
changed["example-ingress"]["State"]["Running"] = False
check(config, changed)
cases += 1
print(f"Smoke isolation guard accepted owned loopback bindings and rejected {cases} unsafe configurations before probes, secrets or HTTP.")

# Load the real transport definitions without running the mutating smoke flow.
# Explicit IPv4 avoids localhost resolving to a different IPv6 listener; neither
# an environment proxy nor a redirect may move requests beyond the owned ports.
source = ast.parse(helper.read_text())
definitions = [node for node in source.body if isinstance(node, (ast.ClassDef, ast.FunctionDef))
               and node.name in ("LoopbackConnection", "LoopbackHandler", "NoRedirect", "client")]
namespace = {"http": http, "urllib": urllib, "socket": socket}
exec(compile(ast.Module(body=definitions, type_ignores=[]), str(helper), "exec"), namespace)
with patch("socket.create_connection") as connect:
    namespace["LoopbackConnection"]("localhost:33000", timeout=3).connect()
    connect.assert_called_once_with(("127.0.0.1", 33000), 3, None)
with patch.dict(os.environ, {"http_proxy": "http://foreign.invalid:8080", "no_proxy": ""}, clear=True):
    opener = namespace["client"]()
    assert not any(isinstance(handler, urllib.request.ProxyHandler) and handler.proxies for handler in opener.handlers)
    assert any(isinstance(handler, namespace["LoopbackHandler"]) for handler in opener.handlers)
    redirects = [handler for handler in opener.handlers if isinstance(handler, urllib.request.HTTPRedirectHandler)]
    assert len(redirects) == 1 and type(redirects[0]) is namespace["NoRedirect"]
    assert redirects[0].redirect_request(None, None, 302, "Found", {}, "http://foreign.invalid") is None
print("Smoke transport pins IPv4 loopback, ignores environment proxies and refuses redirects.")
