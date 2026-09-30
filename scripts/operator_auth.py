"""Named-operator authentication for owned deployment verification fixtures.

The caller supplies its existing guarded HTTP transport. This helper never opens
another origin, provisions recovery or replaces a previously saved credential.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import stat


class OperatorAccessError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise OperatorAccessError(message)


def authenticate(request, secrets, *, sign_in_name="deployment_verification"):
    """Use request(path, body=None) -> parsed JSON with its own cookie jar."""
    directory = Path(secrets)
    metadata = directory.stat(follow_symlinks=False)
    require(stat.S_ISDIR(metadata.st_mode) and metadata.st_uid == os.getuid()
            and metadata.st_mode & 0o077 == 0, "Operator credential directory must be owned and private (0700).")
    methods = request("/v1/admin/auth/methods")
    require(isinstance(methods, dict) and isinstance(methods.get("installation_id"), str)
            and re.fullmatch(r"installation_[A-Za-z0-9_-]{1,100}", methods["installation_id"]),
            "The server did not return an installation identity.")
    path = directory / ("verification_operator_" + methods["installation_id"] + ".json")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == os.getuid()
                and metadata.st_nlink == 1 and metadata.st_mode & 0o077 == 0,
                "Operator credential file must be an owned private regular file.")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OperatorAccessError("Another verifier is using the saved operator credential.") from None
        content = os.read(descriptor, 8193)
        require(len(content) <= 8192, "Operator credential file is too large.")
        if content:
            try:
                saved = json.loads(content)
            except (ValueError, UnicodeError):
                raise OperatorAccessError("Saved operator credential is invalid; restore its private copy or use controlled recovery.") from None
            validate(saved)
            require(saved["installation_id"] == methods["installation_id"],
                    "Saved operator credential belongs to another installation.")
        else:
            require(methods.get("bootstrap") is True,
                    "Enrollment is already consumed and no credential is saved. Use an existing named credential or controlled host recovery; enrollment is never retried automatically.")
            enrollment = request("/v1/admin/auth/bootstrap", {
                "installation_secret": (directory / "admin_password").read_text().rstrip("\r\n"),
                "sign_in_name": sign_in_name, "name": "Deployment verification",
            })
            require(isinstance(enrollment, dict) and enrollment.get("secret_status") == "revealed"
                    and isinstance(enrollment.get("operator"), dict), "Enrollment did not reveal a named credential; use controlled recovery.")
            saved = {"schema_version": 1, "installation_id": methods["installation_id"],
                     "operator_id": enrollment["operator"].get("id"),
                     "sign_in_name": enrollment["operator"].get("sign_in_name"),
                     "credential": enrollment.get("credential")}
            validate(saved)
            data = json.dumps(saved, sort_keys=True).encode()
            os.lseek(descriptor, 0, os.SEEK_SET)
            os.ftruncate(descriptor, 0)
            written = 0
            while written < len(data):
                amount = os.write(descriptor, data[written:])
                require(amount > 0, "Could not persist the revealed credential; use controlled recovery.")
                written += amount
            os.fsync(descriptor)
            parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)
        session = request("/v1/admin/session", {"sign_in_name": saved["sign_in_name"], "credential": saved["credential"]})
        require(isinstance(session, dict) and session.get("actor_id") == saved["operator_id"]
                and isinstance(session.get("csrf_token"), str), "Named login returned an unexpected operator session.")
        return session
    finally:
        os.close(descriptor)


def validate(saved):
    require(isinstance(saved, dict) and set(saved) == {"schema_version", "installation_id", "operator_id", "sign_in_name", "credential"}
            and saved["schema_version"] == 1, "Unsupported saved operator credential format.")
    for key, pattern in (("installation_id", r"installation_[A-Za-z0-9_-]{1,100}"),
                         ("operator_id", r"op_[A-Za-z0-9_-]{43}"),
                         ("sign_in_name", r"[A-Za-z0-9_.-]{1,64}"),
                         ("credential", r"ok_[A-Za-z0-9_-]{43}")):
        require(isinstance(saved[key], str) and re.fullmatch(pattern, saved[key]) is not None,
                "Invalid saved operator credential; restore its private copy or use controlled recovery.")
