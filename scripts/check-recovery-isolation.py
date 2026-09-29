#!/usr/bin/env python3
"""Non-Docker checks: refuse foreign resources before any volume-copy process."""
import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("verify-recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class Isolation(unittest.TestCase):
    def fixture(self):
        fixture = object.__new__(recovery.Fixture)
        fixture.project = "krine-test-recovery-012345abcdef-target"
        fixture.token = "012345abcdef"
        fixture.ids = {"clickhouse": "owned-container"}
        fixture.config = {"volumes": {"clickhouse_data": {"name": fixture.project + "_clickhouse_data"}}}
        return fixture

    def resources(self, fixture):
        name = fixture.config["volumes"]["clickhouse_data"]["name"]
        return {("container", "owned-container"): {"Mounts": [
            {"Destination": "/var/lib/clickhouse", "Type": "volume", "Name": name}]},
            ("volume", name): {"Labels": {"com.docker.compose.project": fixture.project,
                                           "com.docker.compose.volume": "clickhouse_data"}}}

    def reject(self, fixture, resources, attached="owned-container"):
        calls = []

        def docker(*args, **kwargs):
            calls.append(args)
            self.assertEqual(args[:2], ("ps", "-aq"), "Started a mutation before ownership validation")
            return SimpleNamespace(stdout=attached)

        with patch.object(recovery, "inspect", side_effect=lambda kind, name: resources[kind, name]), \
                patch.object(recovery, "docker", side_effect=docker):
            with self.assertRaises(RuntimeError):
                fixture.helper("clickhouse", "sha256:reviewed", restore=True)
        self.assertFalse(any(call[0] == "run" for call in calls))

    def test_foreign_project_label(self):
        fixture = self.fixture()
        resources = self.resources(fixture)
        next(value for (kind, _), value in resources.items() if kind == "volume")["Labels"]["com.docker.compose.project"] = "krine"
        self.reject(fixture, resources)

    def test_mismatched_volume_role(self):
        fixture = self.fixture()
        resources = self.resources(fixture)
        next(value for (kind, _), value in resources.items() if kind == "volume")["Labels"]["com.docker.compose.volume"] = "postgres_data"
        self.reject(fixture, resources)

    def test_bind_mount_never_restored(self):
        fixture = self.fixture()
        resources = self.resources(fixture)
        resources["container", "owned-container"]["Mounts"][0]["Type"] = "bind"
        self.reject(fixture, resources)

    def test_extra_attached_container(self):
        fixture = self.fixture()
        self.reject(fixture, self.resources(fixture), "owned-container\nforeign-writer")

    def test_actual_mount_differs_from_config(self):
        fixture = self.fixture()
        resources = self.resources(fixture)
        resources["container", "owned-container"]["Mounts"][0]["Name"] = "krine_clickhouse_data"
        self.reject(fixture, resources)

    def test_killed_writer_not_a_backup_boundary(self):
        fixture = self.fixture()
        for state in ({"Running": True, "Restarting": False, "OOMKilled": False, "ExitCode": 0},
                      {"Running": False, "Restarting": False, "OOMKilled": True, "ExitCode": 0},
                      {"Running": False, "Restarting": False, "OOMKilled": False, "ExitCode": 137}):
            with self.subTest(state=state), patch.object(recovery, "inspect", return_value={"State": state}):
                with self.assertRaises(RuntimeError):
                    fixture.stopped("clickhouse")

    def test_existing_project_refused_before_creation(self):
        fixture = self.fixture()
        with patch.object(recovery, "docker", return_value=SimpleNamespace(stdout="existing-resource")) as docker:
            with self.assertRaises(RuntimeError):
                fixture.absent()
        self.assertEqual(docker.call_count, 1)
        self.assertEqual(docker.call_args.args[:2], ("ps", "-aq"))


    def test_unknown_store_image_fails_before_resource_creation(self):
        args = SimpleNamespace(api_port=39080, example_port=34000, network_prefix="10.203.85",
                               image="core", example_image="example", ingress_image="ingress",
                               postgres_image="missing-store", valkey_image=None, clickhouse_image=None)
        fixture = SimpleNamespace(config={"services": {"postgres": {"image": "pinned-store"}}})
        def image(kind, name):
            if name == "missing-store":
                raise RuntimeError("Image not locally available")
            return {"Id": "sha256:reviewed"}
        with tempfile.TemporaryDirectory(prefix="krine-unknown-image-") as directory, \
                patch.object(recovery, "Fixture", return_value=fixture), patch.object(recovery, "inspect", side_effect=image), \
                patch.object(recovery, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "not locally available"):
                recovery.execute(args, Path(directory))
            command.assert_not_called()

    def test_mismatched_running_image_is_rejected(self):
        fixture = self.fixture()
        fixture.config["services"] = {"postgres": {"image": "sha256:expected"}}
        fixture.run = lambda *args, **kwargs: SimpleNamespace(stdout="owned-container")
        actual = {"Config": {"Labels": {"com.docker.compose.project": fixture.project,
                                         "com.docker.compose.service": "postgres"}}, "Image": "sha256:different"}
        with patch.object(recovery, "inspect", return_value=actual):
            with self.assertRaisesRegex(RuntimeError, "image differs"):
                fixture.refresh()

    def test_foreign_network_attachment_prevents_cleanup(self):
        fixture = self.fixture()
        fixture.config["networks"] = {"storage": {"name": fixture.project + "_storage"}}
        def listing(*args, **kwargs):
            return SimpleNamespace(stdout="owned-container" if args[0] == "ps" else "owned-network")
        def resource(kind, name):
            if kind == "container":
                return {"Config": {"Labels": {"com.docker.compose.project": fixture.project,
                                               "com.docker.compose.service": "clickhouse"}}}
            return {"Labels": {"com.docker.compose.project": fixture.project}, "Name": fixture.project + "_storage",
                    "Containers": {"foreign-container": {}}}
        with patch.object(recovery, "docker", side_effect=listing), patch.object(recovery, "inspect", side_effect=resource), \
                patch.object(recovery.Fixture, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "externally attached"):
                fixture.cleanup()
            run.assert_not_called()



class CounterRecovery(unittest.TestCase):
    def metric(self, value, at=1_000_000, status="known"):
        state = {"status": status, "value": value} if status == "known" else {"status": status, "reason": "unavailable"}
        return {"version": 1, "state": state, "provenance": {"observed_at": at}}

    def test_exact_retained_count_rejects_partial_and_duplicate_projection(self):
        events = [{"id": str(i), "ip": "192.0.2.1", "accepted_at": 990_000 + i} for i in range(5)]
        self.assertEqual(recovery.assert_event_count(self.metric(5), events, "192.0.2.1"), 5)
        for value in (0, 1, 4, 6, 99, True):
            with self.subTest(value=value), self.assertRaisesRegex(RuntimeError, "expected exactly 5"):
                recovery.assert_event_count(self.metric(value), events, "192.0.2.1")

    def test_unknown_is_never_a_successful_rebuild_even_for_an_empty_window(self):
        with self.assertRaisesRegex(RuntimeError, "Authoritative counter mismatch"):
            recovery.assert_event_count(self.metric(None, status="unknown"), [], "192.0.2.1")

    def test_window_includes_both_boundaries_and_only_the_requested_ip(self):
        events = [{"id": "inclusive-lower", "ip": "192.0.2.1", "accepted_at": 700_000},
                  {"id": "inclusive-upper", "ip": "192.0.2.1", "accepted_at": 1_000_000},
                  {"id": "expired", "ip": "192.0.2.1", "accepted_at": 699_999},
                  {"id": "later", "ip": "192.0.2.1", "accepted_at": 1_000_001},
                  {"id": "other-peer", "ip": "192.0.2.2", "accepted_at": 1_000_000}]
        self.assertEqual(recovery.assert_event_count(self.metric(2), events, "192.0.2.1"), 2)
        for value in (1, 3, 5):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                recovery.assert_event_count(self.metric(value), events, "192.0.2.1")

    def test_expiry_uses_metric_observation_time_without_changing_a_clock(self):
        events = [{"id": "boundary", "ip": "192.0.2.1", "accepted_at": 700_000}]
        self.assertEqual(recovery.assert_event_count(self.metric(1, at=1_000_000), events, "192.0.2.1"), 1)
        self.assertEqual(recovery.assert_event_count(self.metric(0, at=1_000_001), events, "192.0.2.1"), 0)
        with self.assertRaisesRegex(RuntimeError, "expected exactly 0"):
            recovery.assert_event_count(self.metric(1, at=1_000_001), events, "192.0.2.1")

    def test_metric_counts_distinct_event_ids(self):
        event = {"id": "one-authoritative-event", "ip": "192.0.2.1", "accepted_at": 999_000}
        self.assertEqual(recovery.assert_event_count(self.metric(1), [event, event], "192.0.2.1"), 1)



class ImageArchive(unittest.TestCase):
    def exercise(self, failure=None):
        blobs = [json.dumps({"architecture": "arm64", "os": "linux", "config": {"fixture": n}}).encode()
                 for n in range(3)]
        digests = [hashlib.sha256(blob).hexdigest() for blob in blobs]
        images = {service: "sha256:" + digests[index % 3] for index, service in enumerate(recovery.SERVICES)}
        fixture = SimpleNamespace(ids={service: service for service in recovery.SERVICES})

        def inspect(kind, name):
            return {"Image": images[name]} if kind == "container" else {"Size": 1000, "Architecture": "arm64", "Os": "linux"}

        def save(*args, **kwargs):
            self.assertEqual(args[:3], ("image", "save", "-o"))
            self.assertEqual(set(args[4:]), set(images.values()))
            records = [{"Config": "blobs/sha256/" + digest, "RepoTags": [], "Layers": []} for digest in digests]
            if failure == "missing":
                records.pop()
            with tarfile.open(args[3], "w") as archive:
                files = [("manifest.json", json.dumps(records).encode())]
                files += [("blobs/sha256/" + digest, blob) for digest, blob in zip(digests, blobs)]
                if failure == "tampered":
                    files[-1] = (files[-1][0], blobs[0])
                for name, blob in files:
                    info = tarfile.TarInfo(name)
                    info.size = len(blob)
                    archive.addfile(info, io.BytesIO(blob))

        with tempfile.TemporaryDirectory(prefix="krine-image-archive-test-") as directory, \
                patch.object(recovery, "inspect", side_effect=inspect), patch.object(recovery, "docker", side_effect=save):
            if failure:
                with self.assertRaises(RuntimeError):
                    recovery.save_images(fixture, Path(directory))
            else:
                self.assertEqual(recovery.save_images(fixture, Path(directory)), images)
                self.assertEqual((Path(directory) / "images.tar").stat().st_mode & 0o777, 0o600)

    def test_all_services_and_shared_image_are_validated(self):
        self.exercise()

    def test_missing_service_image_is_rejected(self):
        self.exercise("missing")

    def test_config_content_must_match_immutable_id(self):
        self.exercise("tampered")


if __name__ == "__main__":
    unittest.main()
