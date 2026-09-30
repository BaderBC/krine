"""Offline adversarial checks; real-store interruption checks accompany release."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("krine_demo_import", Path(__file__).resolve().parents[1] / "demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class HistoryHarness(demo.Deployment):
    def __init__(self):
        self.rows, self.ledger, self.inserts = [], {}, 0
        self.lose_insert_ack = False
        self.lose_journal_ack = False

    def ch_rows(self, rows, final=False):
        ids = {row["id"] for row in rows}
        return [{**row, "revision": str(row["revision"]), "at": str(row["at"])} for row in self.rows if row["id"] in ids]

    def ch(self, query, body=b""):
        assert query.startswith("INSERT INTO history_v2")
        self.inserts += 1
        self.rows.extend(json.loads(line) for line in body.splitlines())
        if self.lose_insert_ack:
            self.lose_insert_ack = False
            raise RuntimeError("Simulated lost insert acknowledgment")
        return ""

    def journal(self, chunk):
        if chunk["name"] in self.ledger:
            demo.require(self.ledger[chunk["name"]] == chunk["sha256"], "Journal mismatch")
            return True
        return False

    def journal_sql(self, chunk):
        return json.dumps(chunk)

    def sql(self, query):
        chunk = json.loads(query)
        self.ledger[chunk["name"]] = chunk["sha256"]
        if self.lose_journal_ack:
            self.lose_journal_ack = False
            raise RuntimeError("Simulated lost journal acknowledgment")
        return ""


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{"kind": "decision", "id": "decision:demo", "revision": 2, "at": 123, "payload": '{"sample_data":{"dataset_id":"demo"}}'}]
        self.content = (demo.canonical(self.rows[0]) + "\n").encode()
        self.chunk = {"name": "chunk-000001.jsonl", "sha256": demo.digest(self.content), "store": "clickhouse", "table": "history_v2", "rows": 1}

    def test_lost_insert_ack_reads_back_before_replay(self):
        history = HistoryHarness()
        history.lose_insert_ack = True
        with self.assertRaisesRegex(RuntimeError, "lost insert"):
            history.import_ch(self.chunk, self.rows, self.content)
        self.assertEqual(history.inserts, 1)
        self.assertFalse(history.ledger)
        history.import_ch(self.chunk, self.rows, self.content)
        self.assertEqual(history.inserts, 1)
        self.assertEqual(len(history.ledger), 1)

    def test_lost_journal_ack_does_not_duplicate_insert(self):
        history = HistoryHarness()
        history.lose_journal_ack = True
        with self.assertRaisesRegex(RuntimeError, "lost journal"):
            history.import_ch(self.chunk, self.rows, self.content)
        history.import_ch(self.chunk, self.rows, self.content)
        self.assertEqual(history.inserts, 1)

    def test_conflicting_payload_and_missing_committed_rows_stop(self):
        history = HistoryHarness()
        history.rows = [{**self.rows[0], "payload": "different"}]
        with self.assertRaisesRegex(RuntimeError, "conflicting"):
            history.import_ch(self.chunk, self.rows, self.content)
        self.assertEqual(history.inserts, 0)
        history.rows = []
        history.ledger[self.chunk["name"]] = self.chunk["sha256"]
        with self.assertRaisesRegex(RuntimeError, "missing"):
            history.import_ch(self.chunk, self.rows, self.content)
        self.assertEqual(history.inserts, 0)

    def test_partial_unacknowledged_chunk_replays_identical_bytes(self):
        history = HistoryHarness()
        rows = [*self.rows, {**self.rows[0], "id": "decision:second"}]
        history.rows = [self.rows[0]]
        content = ("\n".join(map(demo.canonical, rows)) + "\n").encode()
        chunk = {**self.chunk, "sha256": demo.digest(content), "rows": 2}
        history.import_ch(chunk, rows, content)
        self.assertEqual(history.inserts, 1)
        self.assertEqual(len(history.rows), 3)
        self.assertEqual(len({demo.canonical(row) for row in history.rows}), 2)
        history.import_ch(chunk, rows, content)
        self.assertEqual(history.inserts, 1)

    def test_postgres_unjournaled_rows_are_never_overwritten(self):
        deployment = object.__new__(demo.Deployment)
        rows = [{"id": "existing"}]
        deployment.pg_rows = lambda table, expected: rows
        deployment.journal = lambda chunk: False
        deployment.sql = lambda query: self.fail("Must not execute a mutation")
        with self.assertRaisesRegex(RuntimeError, "Unjournaled"):
            deployment.import_pg({"table": "entities"}, rows)

    def test_postgres_mutated_committed_rows_are_rejected(self):
        deployment = object.__new__(demo.Deployment)
        deployment.pg_rows = lambda table, expected: [{"id": "changed"}]
        deployment.journal = lambda chunk: True
        deployment.sql = lambda query: self.fail("Must not execute a mutation")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            deployment.import_pg({"table": "entities"}, [{"id": "original"}])


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="krine-demo-guard-test-")
        self.directory = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        owner = "a" * 24
        project = "krine-demo-" + owner
        labels = {"com.docker.compose.project": project, "io.krine.demo.owner": owner, "io.krine.demo.dataset": "demo_test"}
        config = {"name": project, "services": {}, "networks": {"storage": {"name": project + "_storage"}}, "volumes": {}, "secrets": {}}
        self.containers, self.volumes, self.networks = {}, {}, {}
        for service in demo.SERVICES:
            identifier = "container-" + service
            mounts = []
            actual_mounts = []
            if service in demo.VOLUMES:
                key, target = demo.VOLUMES[service]
                name = project + "_" + key
                config["volumes"][key] = {"name": name}
                mounts.append({"type": "volume", "source": key, "target": target})
                actual_mounts.append({"Type": "volume", "Name": name, "Destination": target, "RW": True})
                self.volumes[name] = {"Labels": labels.copy(), "CreatedAt": "fixed", "Mountpoint": "/owned/" + key}
            config["services"][service] = {"image": "sha256:" + service, "networks": {"storage": {}}, "volumes": mounts}
            self.containers[identifier] = {"Image": "sha256:" + service,
                "Config": {"Labels": {**labels, "com.docker.compose.service": service}}, "HostConfig": {"PortBindings": {}},
                "State": {"Running": service != "app", "Restarting": False, "OOMKilled": False, "ExitCode": 0},
                "Mounts": actual_mounts, "NetworkSettings": {"Networks": {project + "_storage": {}}}}
        self.networks[project + "_storage"] = {"Labels": labels.copy(), "Id": "network-id", "Containers": {key: {} for key in self.containers if key != "container-app"}}
        demo.save_json(self.directory / "compose.json", config)
        state = {"project": project, "owner_id": owner, "dataset_id": "demo_test", "config_hash": demo.digest(demo.canonical(config).encode()),
                 "containers": {}, "volumes": {}, "networks": {}, "phase": "importing", "port": 18080}
        self.deployment = demo.Deployment(self.directory, state)
        self.deployment.assert_files = lambda: None
        self.patches = [patch.object(demo, "docker", self.docker), patch.object(demo, "inspect", self.inspect)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def inspect(self, kind, name):
        return copy.deepcopy({"container": self.containers, "volume": self.volumes, "network": self.networks}[kind][name])

    def docker(self, *args, **kwargs):
        if args[:2] == ("ps", "-aq"):
            selector = args[-1]
            if selector.startswith("volume="):
                name = selector.removeprefix("volume=")
                values = [key for key, container in self.containers.items() if any(mount.get("Name") == name for mount in container["Mounts"])]
            else:
                values = list(self.containers)
        elif args[:2] == ("volume", "ls"):
            values = list(self.volumes)
        elif args[:2] == ("network", "ls"):
            values = list(self.networks)
        else:
            self.fail("Unexpected Docker operation: " + repr(args))
        return "\n".join(values).encode()

    def test_owned_stopped_resources_pass(self):
        self.deployment.owned(stopped=True)
        self.assertEqual(len(self.deployment.state["containers"]), 4)
        self.assertEqual(len(self.deployment.state["volumes"]), 3)

    def test_running_writer_is_rejected(self):
        self.containers["container-app"]["State"]["Running"] = True
        with self.assertRaisesRegex(RuntimeError, "gracefully stopped"):
            self.deployment.owned(stopped=True)

    def test_extra_network_is_rejected(self):
        self.containers["container-postgres"]["NetworkSettings"]["Networks"]["unrelated"] = {}
        with self.assertRaisesRegex(RuntimeError, "foreign or missing networks"):
            self.deployment.owned(stopped=True)

    def test_foreign_network_attachment_is_rejected(self):
        next(iter(self.networks.values()))["Containers"]["foreign"] = {}
        with self.assertRaisesRegex(RuntimeError, "Foreign container attached"):
            self.deployment.owned(stopped=True)

    def test_recreated_volume_is_rejected(self):
        self.deployment.owned(stopped=True)
        next(iter(self.volumes.values()))["CreatedAt"] = "replacement"
        with self.assertRaisesRegex(RuntimeError, "Volume identity changed"):
            self.deployment.owned(stopped=True)

    def test_foreign_partial_provision_is_rejected_before_up(self):
        self.containers = {}
        self.networks = {}
        self.deployment.state["phase"] = "provisioning"
        next(iter(self.volumes.values()))["Labels"]["io.krine.demo.owner"] = "foreign"
        with self.assertRaisesRegex(RuntimeError, "Volume ownership"):
            self.deployment.owned(partial=True)

    def test_extra_mount_and_store_port_are_rejected(self):
        self.containers["container-postgres"]["Mounts"].append({"Type": "bind", "Source": "/foreign", "Destination": "/unexpected", "RW": True})
        with self.assertRaisesRegex(RuntimeError, "mounts differ"):
            self.deployment.owned(stopped=True)
        self.containers["container-postgres"]["Mounts"].pop()
        self.containers["container-postgres"]["HostConfig"]["PortBindings"] = {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5432"}]}
        with self.assertRaisesRegex(RuntimeError, "host port"):
            self.deployment.owned(stopped=True)


class InputTests(unittest.TestCase):
    def test_freshness_rejects_hot_future_and_stale_fixtures(self):
        now = 1_790_000_000_000
        manifest = {"configuration": {"anchor_ms": now}, "from": now - 28 * 86_400_000, "to": now - 600_000}
        demo.freshness(manifest, now)
        with self.assertRaisesRegex(RuntimeError, "hot window"):
            demo.freshness({**manifest, "to": now}, now)
        with self.assertRaisesRegex(RuntimeError, "previous 24 hours"):
            demo.freshness(manifest, now - 1)
        with self.assertRaisesRegex(RuntimeError, "previous 24 hours"):
            demo.freshness(manifest, now + 86_400_001)

    def test_oversized_and_symlink_files_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "artifact"
            path.write_bytes(b"large")
            with self.assertRaisesRegex(RuntimeError, "oversized"):
                demo.read_file(path, 2)
            linked = Path(directory) / "linked"
            linked.symlink_to(path)
            with self.assertRaisesRegex(RuntimeError, "Unsafe"):
                demo.read_file(linked, 10)


if __name__ == "__main__":
    unittest.main()
