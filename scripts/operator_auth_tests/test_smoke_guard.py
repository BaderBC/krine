"""Prove packaged smoke ownership checks stop before constructing HTTP transport."""
import importlib.util
import json
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).parents[1] / "smoke-app.py"
spec = importlib.util.spec_from_file_location("operator_auth", SCRIPT.with_name("operator_auth.py"))
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class ReachedTransport(Exception):
    pass


class SmokeOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="krine-smoke-owner-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.container = {"Config": {"Labels": {"com.docker.compose.project": "krine-test-guard", "com.docker.compose.service": "app"}},
            "NetworkSettings": {"Ports": {"8080/tcp": [{"HostIp": "127.0.0.1", "HostPort": "18080"}]}},
            "Mounts": [{"Destination": "/run/secrets/admin_password", "Type": "bind", "Source": str(self.directory / "admin_password")}]}

    def invoke(self, origin="http://127.0.0.1:18080", project="krine-test-guard", identifiers="owned\n"):
        with patch.dict(os.environ, {"COMPOSE_PROJECT_NAME": project, "KRINE_SECRETS_DIR": str(self.directory)}), \
             patch.dict(sys.modules, {"operator_auth": auth}), \
             patch.object(sys, "argv", [str(SCRIPT), origin]), \
             patch("subprocess.check_output", side_effect=[identifiers, json.dumps([self.container])]), \
             patch("urllib.request.build_opener", side_effect=ReachedTransport):
            runpy.run_path(str(SCRIPT), run_name="__guard_test__")

    def test_matching_owned_loopback_endpoint_reaches_transport(self):
        with self.assertRaises(ReachedTransport):
            self.invoke()

    def test_normal_or_ambiguous_projects_stop(self):
        for project in ("krine", "", "krine-test-../native", "other"):
            with self.subTest(project=project), self.assertRaises(SystemExit):
                self.invoke(project=project)
        for identifiers in ("", "one\ntwo\n"):
            with self.assertRaises(SystemExit):
                self.invoke(identifiers=identifiers)

    def test_foreign_or_ambiguous_origins_stop(self):
        for origin in ("https://example.com:18080", "http://localhost:18080", "http://127.0.0.1:18080/path",
                       "http://user:password@127.0.0.1:18080", "http://127.0.0.1:18080?redirect=other", "http://127.0.0.1:18080#fragment",
                       "http://127.0.0.1", "http://[::1]:18080"):
            with self.subTest(origin=origin), self.assertRaises(SystemExit):
                self.invoke(origin=origin)

    def test_port_secret_or_container_owner_mismatch_stops(self):
        for part, key, changed in ((self.container["Config"]["Labels"], "com.docker.compose.project", "krine"),
                                   (self.container["NetworkSettings"]["Ports"], "8080/tcp", [{"HostIp": "0.0.0.0", "HostPort": "18080"}]),
                                   (self.container["Mounts"][0], "Source", "/not-this-fixture/admin_password")):
            original = part[key]
            part[key] = changed
            with self.assertRaises(SystemExit):
                self.invoke()
            part[key] = original
