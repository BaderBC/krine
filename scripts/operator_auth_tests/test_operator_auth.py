import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("operator_auth", Path(__file__).parents[1] / "operator_auth.py")
auth = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auth)


class AuthenticationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="krine-operator-helper-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        (self.directory / "admin_password").write_text("bootstrap-only-secret")
        self.bootstraps = 0
        self.installation = "installation_fixture"
        self.operator = "op_" + "o" * 43
        self.credential = "ok_" + "s" * 43
        self.consumed = False
        self.failure = None

    def request(self, path, body=None):
        if path.endswith("/auth/methods"):
            return {"installation_id": self.installation, "bootstrap": not self.consumed}
        if path.endswith("/auth/bootstrap"):
            self.assertFalse(self.consumed)
            self.bootstraps += 1
            self.consumed = True
            if self.failure == "lost_reveal":
                raise RuntimeError("Lost response")
            return {"operator": {"id": self.operator, "sign_in_name": "deployment_verification"},
                    "credential": self.credential, "secret_status": "revealed"}
        self.assertEqual(path, "/v1/admin/session")
        self.assertEqual(body, {"sign_in_name": "deployment_verification", "credential": self.credential})
        if self.failure == "disabled":
            raise RuntimeError("Unauthorized")
        return {"actor_id": self.operator, "csrf_token": "csrf"}

    def test_enroll_once_then_login_across_restarts(self):
        first = auth.authenticate(self.request, self.directory)
        content = (self.directory / "verification_operator_installation_fixture.json").read_bytes()
        second = auth.authenticate(self.request, self.directory)
        self.assertEqual(first, second)
        self.assertEqual(self.bootstraps, 1)
        self.assertEqual(content, (self.directory / "verification_operator_installation_fixture.json").read_bytes())
        self.assertEqual((self.directory / "verification_operator_installation_fixture.json").stat().st_mode & 0o777, 0o600)

    def test_lost_reveal_never_reenrolls_or_invents_recovery(self):
        self.failure = "lost_reveal"
        with self.assertRaises(RuntimeError):
            auth.authenticate(self.request, self.directory)
        with self.assertRaisesRegex(auth.OperatorAccessError, "already consumed"):
            auth.authenticate(self.request, self.directory)
        self.assertEqual(self.bootstraps, 1)

    def test_saved_identity_cannot_follow_another_installation(self):
        auth.authenticate(self.request, self.directory)
        foreign=self.directory / "verification_operator_installation_another.json"
        foreign.write_bytes((self.directory / "verification_operator_installation_fixture.json").read_bytes())
        foreign.chmod(0o600)
        self.installation = "installation_another"
        with self.assertRaisesRegex(auth.OperatorAccessError, "another installation"):
            auth.authenticate(self.request, self.directory)
        self.assertEqual(self.bootstraps, 1)

    def test_rejected_named_login_preserves_saved_credential(self):
        auth.authenticate(self.request, self.directory)
        before = (self.directory / "verification_operator_installation_fixture.json").read_bytes()
        self.failure = "disabled"
        with self.assertRaises(RuntimeError):
            auth.authenticate(self.request, self.directory)
        self.assertEqual(before, (self.directory / "verification_operator_installation_fixture.json").read_bytes())
        self.assertEqual(self.bootstraps, 1)

    def test_partial_file_and_permissive_file_fail_closed(self):
        path = self.directory / "verification_operator_installation_fixture.json"
        path.write_text('{"credential":')
        path.chmod(0o600)
        with self.assertRaises(auth.OperatorAccessError):
            auth.authenticate(self.request, self.directory)
        path.chmod(0o644)
        with self.assertRaisesRegex(auth.OperatorAccessError, "private"):
            auth.authenticate(self.request, self.directory)
        self.assertEqual(self.bootstraps, 0)

    def test_symlink_and_hardlink_are_rejected_without_modifying_target(self):
        target = self.directory / "target"
        target.write_text("unchanged")
        target.chmod(0o600)
        path = self.directory / "verification_operator_installation_fixture.json"
        path.symlink_to(target)
        with self.assertRaises(OSError):
            auth.authenticate(self.request, self.directory)
        path.unlink()
        os.link(target, path)
        with self.assertRaises(auth.OperatorAccessError):
            auth.authenticate(self.request, self.directory)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertEqual(self.bootstraps, 0)

    def test_private_directory_and_exclusive_lock_are_required(self):
        self.directory.chmod(0o755)
        with self.assertRaises(auth.OperatorAccessError):
            auth.authenticate(self.request, self.directory)
        self.directory.chmod(0o700)
        with patch.object(auth.fcntl, "flock", side_effect=BlockingIOError):
            with self.assertRaisesRegex(auth.OperatorAccessError, "Another verifier"):
                auth.authenticate(self.request, self.directory)
        self.assertEqual(self.bootstraps, 0)

    def test_invalid_server_reveal_does_not_create_saved_authority(self):
        self.operator = "invalid"
        with self.assertRaises(auth.OperatorAccessError):
            auth.authenticate(self.request, self.directory)
        self.assertEqual((self.directory / "verification_operator_installation_fixture.json").read_bytes(), b"")
        with self.assertRaisesRegex(auth.OperatorAccessError, "already consumed"):
            auth.authenticate(self.request, self.directory)

    def test_failed_persistence_does_not_retry_enrollment(self):
        with patch.object(auth.os, "fsync", side_effect=OSError("disk failure")):
            with self.assertRaises(OSError):
                auth.authenticate(self.request, self.directory)
        auth.authenticate(self.request, self.directory)
        self.assertEqual(self.bootstraps, 1)

    def test_wrong_actor_session_fails_closed(self):
        def request(path, body=None):
            result = self.request(path, body)
            return {**result, "actor_id": "different"} if path.endswith("/session") else result
        with self.assertRaisesRegex(auth.OperatorAccessError, "unexpected operator"):
            auth.authenticate(request, self.directory)
