#!/usr/bin/env python3
"""Exercise diagnostic retention/upgrades in an owned, disposable ClickHouse only."""
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
project = "krine-test-diagnostics-" + secrets.token_hex(4)
container, volume, network = (project + suffix for suffix in ("-server", "-data", "-network"))
password = secrets.token_hex(32)


def docker(*args, data=None, check=True):
    result = subprocess.run(["docker", *args], input=data, capture_output=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError(result.stderr.decode()[-6000:])
    return result


config = json.loads(docker("compose", "-f", str(ROOT / "compose.yaml"), "config", "--format", "json").stdout)
image = os.environ.get("KRINE_CLICKHOUSE_TEST_IMAGE", config["services"]["clickhouse"]["image"])
if docker("image", "inspect", image, check=False).returncode:
    docker("pull", image)


def copy_files(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as archive:
        for name, content in files.items():
            content = content.encode() if isinstance(content, str) else content
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o755 if name.startswith("usr/local/bin/") else (0o600 if name.startswith("run/secrets/") else 0o644)
            archive.addfile(info, io.BytesIO(content))
    docker("cp", "-", container + ":/", data=stream.getvalue())


def sql(query, user="qa_operator", host="127.0.0.1", check=True):
    return docker("exec", "-i", container, "sh", "-c",
        'export CLICKHOUSE_PASSWORD="$(cat /run/secrets/clickhouse_password)"; '
        'exec /usr/bin/clickhouse-client --connect_timeout=1 --user "$1" --host "$2" --multiquery --log_queries=0',
        "sh", user, host, data=query.encode(), check=check)


def read(query):
    return sql(query).stdout.decode().strip()


def literal(value):
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n") + "'"


def running():
    return json.loads(docker("inspect", container).stdout)[0]["State"]


def start(legacy=False, interruption=None):
    docker("rm", "-f", container, check=False)
    docker("create", "--name", container, "--network", network, "--hostname", "clickhouse",
           "--memory", "1g", "-e", "CLICKHOUSE_DB=krine",
           "-e", "CLICKHOUSE_PASSWORD_FILE=/run/secrets/clickhouse_password", "--label", "com.docker.compose.project=" + project,
           "-v", volume + ":/var/lib/clickhouse", "--entrypoint", "/bin/sh", image,
           "/opt/krine/clickhouse-entrypoint.sh")
    config = ET.parse(ROOT / "deploy/clickhouse/config.xml")
    if legacy:
        # Reproduce the previously shipped override: leave upstream diagnostics
        # untouched and perform only the original database initialization.
        for node in list(config.getroot()):
            if node.tag.endswith("_log"):
                config.getroot().remove(node)
    files = {
        "run/secrets/clickhouse_password": password,
        "opt/krine/clickhouse-entrypoint.sh": (ROOT / "deploy/clickhouse/entrypoint.sh").read_bytes(),
        "opt/krine/clickhouse-diagnostics.sh": "#!/bin/sh\nexit 0\n" if legacy else (ROOT / "deploy/clickhouse/diagnostics.sh").read_bytes(),
        "etc/clickhouse-server/config.d/krine.xml": ET.tostring(config.getroot()),
        # Fixture-only operator: no published ports, only loopback authentication,
        # independent password. The shipped application role is tested unchanged.
        "etc/clickhouse-server/users.d/qa.xml": f"""<clickhouse><users><qa_operator>
            <password_sha256_hex>{hashlib.sha256(password.encode()).hexdigest()}</password_sha256_hex>
            <profile>default</profile><quota>default</quota><networks><ip>127.0.0.1</ip></networks>
            <grants><query>GRANT ALL ON *.*</query></grants></qa_operator></users></clickhouse>""",
    }
    if interruption == "completed-maintenance":
        files["opt/krine/clickhouse-diagnostics.sh"] += b'\nif [ "${1:-}" = --maintain ]; then touch /tmp/qa-phase-complete; sleep 4; exit 75; fi\n'
    elif interruption:
        # Fail AFTER the actual SQL has committed, exercising lost acknowledgement.
        # During the pause, the test checks that the container address is not ready.
        files["usr/local/bin/clickhouse-client"] = """#!/bin/sh
/usr/bin/clickhouse-client "$@"
result=$?
[ "$result" = 0 ] || exit "$result"
case "$*" in
    *PATTERN*) touch /tmp/qa-phase-complete; sleep 4; exit 75 ;;
esac
""".replace("PATTERN", interruption.replace(" ", "\\ "))
    copy_files(files)
    docker("start", container)
    if interruption:
        return
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        if not running()["Running"]:
            result = docker("logs", "--tail", "40", container)
            raise AssertionError((result.stdout + result.stderr).decode())
        ready = docker("exec", container, "test", "!", "-e",
                       "/etc/clickhouse-server/users.d/krine-bootstrap.xml", check=False)
        if not ready.returncode and not sql("SELECT 1", user="krine", host="clickhouse", check=False).returncode:
            return
        time.sleep(.25)
    raise AssertionError("ClickHouse startup did not complete")


def stop():
    docker("stop", "--time", "60", container)


def wait_expired(table, marker):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if read(f"SELECT count() FROM system.{table} WHERE query={literal(marker)}") == "0":
            return
        time.sleep(.25)
    raise AssertionError("Diagnostic TTL did not physically remove the expired row")


created = []
assert docker("container", "inspect", container, check=False).returncode
assert docker("volume", "inspect", volume, check=False).returncode
assert docker("network", "inspect", network, check=False).returncode
try:
    docker("network", "create", "--internal", "--label", "com.docker.compose.project=" + project, network)
    created.append("network")
    docker("volume", "create", "--label", "com.docker.compose.project=" + project, volume)
    created.append("volume")
    start()
    assert read("SELECT count() FROM system.databases WHERE name='krine'") == "1"
    assert sql("SELECT 1", user="krine_bootstrap", check=False).returncode
    stop()
    docker("rm", container)
    docker("volume", "rm", volume)
    docker("volume", "create", "--label", "com.docker.compose.project=" + project, volume)
    start(legacy=True)
    assert read("SELECT count() FROM system.databases WHERE name='krine'") == "1"
    sql("SYSTEM FLUSH LOGS")
    assert int(read("SELECT count() FROM system.columns WHERE database='system' AND table='metric_log'")) > 1000
    query_comment = json.loads(read("SELECT comment FROM system.tables WHERE database='system' AND name='query_log' FORMAT JSON"))["data"][0]["comment"]
    metric_comment = json.loads(read("SELECT comment FROM system.tables WHERE database='system' AND name='metric_log' FORMAT JSON"))["data"][0]["comment"]
    trace_comment = json.loads(read("SELECT comment FROM system.tables WHERE database='system' AND name='trace_log' FORMAT JSON"))["data"][0]["comment"]
    sql("CREATE DATABASE IF NOT EXISTS krine; CREATE TABLE krine.diagnostics_canary (id UInt64) ENGINE=MergeTree ORDER BY id; INSERT INTO krine.diagnostics_canary VALUES(42)")
    sql("INSERT INTO system.query_log(event_date,event_time,type,query) VALUES(today(),now(),'QueryFinish','keep-upgrade'),(today()-9,now()-INTERVAL 9 DAY,'QueryFinish','expire-upgrade')")
    sql("INSERT INTO system.crash_log(event_date,event_time) VALUES(today(),now()),(today()-9,now()-INTERVAL 9 DAY)")
    # Each case independently defeats an unsafe prefix-only/metadata-only matcher.
    for table, engine, comment in (("metric_log_customer", "MergeTree ORDER BY id", metric_comment),
                                  ("metric_log_987", "MergeTree ORDER BY id", "customer data"),
                                  ("query_log_987", "MergeTree ORDER BY id", "customer data"),
                                  ("trace_log_987", "Log", trace_comment)):
        sql(f"CREATE TABLE system.{table}(id UInt64) ENGINE={engine} COMMENT {literal(comment)}; INSERT INTO system.{table} VALUES(7)")
    sql("CREATE TABLE krine.metric_log(id UInt64) ENGINE=MergeTree ORDER BY id; INSERT INTO krine.metric_log VALUES(8)")
    stop()
    start()
    wait_expired("query_log_0", "expire-upgrade")
    assert read("SELECT count() FROM system.query_log_0 WHERE query='keep-upgrade'") == "1"
    assert read("SELECT count() FROM system.crash_log_0 WHERE event_date=today()") == "1"
    assert read("SELECT count() FROM system.crash_log_0 WHERE event_date<today()-7") == "0"
    canaries = ("system.metric_log_customer", "system.metric_log_987", "system.query_log_987", "system.trace_log_987", "krine.metric_log", "krine.diagnostics_canary")
    canary_state = {table: (read("SHOW CREATE TABLE " + table), read("SELECT groupArray(id) FROM " + table)) for table in canaries}
    for pattern in ("SYSTEM FLUSH LOGS query_log, crash_log",
                    "ALTER TABLE system.query_log_900 MODIFY SETTING table_readonly = 0",
                    "ALTER TABLE system.query_log_900 MODIFY TTL*",
                    "DROP TABLE IF EXISTS system.metric_log_900 SYNC", "completed-maintenance"):
        sql("DROP TABLE IF EXISTS system.query_log_900 SYNC; CREATE TABLE system.query_log_900 AS system.query_log "
            "ENGINE=MergeTree ORDER BY(event_date,event_time) TTL event_time + INTERVAL 90 DAY COMMENT " + literal(query_comment))
        sql("INSERT INTO system.query_log_900(event_date,event_time,type,query) SELECT toDate(now()-INTERVAL 166 HOUR),now()-INTERVAL 166 HOUR,'QueryFinish','keep-phase'; "
            "INSERT INTO system.query_log_900(event_date,event_time,type,query) SELECT toDate(now()-INTERVAL 169 HOUR),now()-INTERVAL 169 HOUR,'QueryFinish','expire-phase'; "
            "ALTER TABLE system.query_log_900 MODIFY SETTING table_readonly=1")
        sql("CREATE TABLE IF NOT EXISTS system.metric_log_900(id UInt64) ENGINE=MergeTree ORDER BY id COMMENT " + literal(metric_comment))
        stop()
        start(interruption=pattern)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline and running()["Running"]:
            marker = docker("exec", container, "test", "-e", "/tmp/qa-phase-complete", check=False)
            if not marker.returncode:
                assert sql("SELECT 1", user="krine", host="clickhouse", check=False).returncode
                assert sql("SELECT 1", user="krine_bootstrap", host="clickhouse", check=False).returncode
                break
            time.sleep(.2)
        else:
            raise AssertionError("Upgrade interruption was not reached")
        while time.monotonic() < deadline and running()["Running"]:
            time.sleep(.2)
        assert not running()["Running"] and running()["ExitCode"] == 75
        start()
        wait_expired("query_log_900", "expire-phase")
        assert read("SELECT count() FROM system.query_log_900 WHERE query='keep-phase'") == "1"
        assert read("SELECT count() FROM system.tables WHERE database='system' AND name='metric_log_900'") == "0"
        assert canary_state == {table: (read("SHOW CREATE TABLE " + table), read("SELECT groupArray(id) FROM " + table)) for table in canaries}
    sql("SELECT 42 AS diagnostic_success SETTINGS log_queries=1", user="krine")
    assert sql("SELECT diagnostic_missing_function() SETTINGS log_queries=1", user="krine", check=False).returncode
    sql("SYSTEM FLUSH LOGS query_log")
    assert int(read("SELECT count() FROM system.query_log WHERE query LIKE '%diagnostic_success%' AND type='QueryFinish'")) > 0
    assert int(read("SELECT count() FROM system.query_log WHERE query LIKE '%diagnostic_missing_function%' AND exception_code!=0")) > 0
    assert int(sql("SELECT count() FROM system.user_query_log WHERE query LIKE '%diagnostic_success%'", user="krine").stdout) > 0
    for query in ("DROP TABLE system.query_log", "SELECT * FROM system.query_log LIMIT 1", "SYSTEM FLUSH LOGS", "CREATE USER forbidden"):
        result = sql(query, user="krine", check=False)
        assert result.returncode and b"ACCESS_DENIED" in result.stderr
    assert sql("SELECT 1", user="krine_bootstrap", check=False).returncode
    before = read("SELECT arraySort(groupArray((table,mutation_id))) FROM system.mutations WHERE database='system'")
    stop()
    start()
    after = read("SELECT arraySort(groupArray((table,mutation_id))) FROM system.mutations WHERE database='system'")
    assert before == after, "Restart enqueued redundant diagnostic mutations"
    assert read("SELECT count() FROM system.tables WHERE database='system' AND name IN('metric_log','asynchronous_metric_log','trace_log','query_metric_log','part_log','text_log','error_log')") == "0"
    print("ClickHouse diagnostics: retained-volume upgrade, 168-hour boundary, five interrupted upgrades, idempotent restart, canaries and privilege boundary passed.")
finally:
    docker("rm", "-f", container, check=False)
    if "volume" in created:
        docker("volume", "rm", volume)
    if "network" in created:
        docker("network", "rm", network)
