"""Real SQLCipher regression for the read-only WAL heap-cache boundary.

Run from the host: python3 tests/desktop-wal-visibility.test.py
Uses the existing reader container's SQLCipher installation, but only a new /tmp
fixture and a separate uid 65534 reader. It never initializes the production
reader, scans keys, opens WeChat files, sends messages, or changes services.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time


TEST_KEY = "01" * 32  # Public fixture key; never read production credentials.


def source_hashes(path):
    return {
        suffix or "db": hashlib.sha256(Path(str(path) + suffix).read_bytes()).hexdigest()
        for suffix in ("", "-wal", "-shm")
    }


def respond(value):
    print(json.dumps(value), flush=True)


def fixture_writer(wrapper_source):
    from sqlcipher3 import dbapi2 as sqlite

    root = Path(tempfile.mkdtemp(prefix="ruanruan-wal-regression-"))
    directory = root / "message"
    directory.mkdir()
    path = directory / "message_0.db"
    writer = None
    descriptors = []
    try:
        (root / "live_database.py").write_bytes(base64.b64decode(wrapper_source))
        writer = sqlite.connect(str(path))
        writer.execute(f"PRAGMA key=\"x'{TEST_KEY}'\"")
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("CREATE TABLE messages(local_id INTEGER PRIMARY KEY, server_id INTEGER, direction TEXT)")
        writer.execute("INSERT INTO messages VALUES(1,101,'incoming')")
        writer.commit()
        old_wal = Path(str(path) + "-wal").read_bytes()
        writer.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
        main = path.read_bytes()
        empty_shm = Path(str(path) + "-shm").read_bytes()
        stages = {}
        for name, statement in (
            ("incoming", "INSERT INTO messages VALUES(2,102,'incoming')"),
            ("outgoing_pending", "INSERT INTO messages VALUES(3,0,'outgoing')"),
            ("outgoing_ack", "UPDATE messages SET server_id=103 WHERE local_id=3"),
        ):
            writer.execute(statement)
            writer.commit()
            stages[name] = (
                Path(str(path) + "-wal").read_bytes(),
                Path(str(path) + "-shm").read_bytes(),
            )
        writer.close()
        writer = None

        # WCDB can reset the WAL header after checkpoint without truncating its
        # old frames. Their old salts no longer match the new, valid WAL header.
        # The main DB already contains row 1; no valid new WAL commit exists yet.
        path.write_bytes(main)
        Path(str(path) + "-wal").write_bytes(stages["incoming"][0][:32] + old_wal[32:])
        Path(str(path) + "-shm").write_bytes(empty_shm)
        descriptors = [os.open(str(path) + suffix, os.O_RDWR) for suffix in ("-wal", "-shm")]
        for item in directory.iterdir():
            item.chmod(0o444)
        directory.chmod(0o555)
        root.chmod(0o555)
        respond({"path": str(path), "root": str(root), "sqlite": sqlite.sqlite_version,
                 "hashes": source_hashes(path)})
        for line in sys.stdin:
            command = json.loads(line)
            if command["stage"] == "stop":
                break
            wal, shm = stages[command["stage"]]
            # These are the fixture writer's planned commits. Reader checks
            # compare hashes only after this update, never across two commits.
            for fd, data in zip(descriptors, (wal, shm)):
                assert os.pwrite(fd, data, 0) == len(data)
                os.fsync(fd)
            respond({"stage": command["stage"], "hashes": source_hashes(path)})
    finally:
        if writer is not None:
            writer.close()
        for fd in descriptors:
            os.close(fd)
        root.chmod(0o755)
        directory.chmod(0o755)
        for item in directory.iterdir():
            item.chmod(0o644)
        shutil.rmtree(root)


class FixtureFiles:
    """Use the ordinary live-file identity without scanning any process fds."""

    @staticmethod
    def identity(path):
        def inode(item):
            stat = item.stat()
            return stat.st_dev, stat.st_ino
        return ("live", inode(path), inode(Path(str(path) + "-wal")), inode(Path(str(path) + "-shm")))

    @staticmethod
    def read_path(path, _identity):
        return path

    def discard(self, _path):
        pass

    def close(self):
        pass


def fixture_reader(path):
    from sqlcipher3 import dbapi2 as sqlite
    from wechat_ai_bot.models import UserInfo
    from wechat_ai_bot.services.core.linux_database_service import LinuxDatabaseService

    path = Path(path)
    sys.path.insert(0, str(path.parent.parent))
    from live_database import LiveDatabaseService

    assert os.getuid() == 65534
    assert not os.access(path.parent, os.W_OK)
    assert all(not os.access(str(path) + suffix, os.W_OK) for suffix in ("", "-wal", "-shm"))

    def service(cls):
        instance = cls(UserInfo(account="synthetic"), scan_keys=False)
        instance._driver = sqlite
        instance._keys = {path: TEST_KEY}
        instance._database_files = FixtureFiles()
        instance._table_sequences[(path, "messages")] = 1
        return instance

    original, fixed = service(LinuxDatabaseService), service(LiveDatabaseService)

    def query(instance, sql="SELECT local_id,server_id FROM messages ORDER BY local_id"):
        before = source_hashes(path)
        started = time.perf_counter()
        rows = instance.execute_query(path, sql)
        elapsed = (time.perf_counter() - started) * 1000
        assert source_hashes(path) == before, "Reader changed source DB/WAL/SHM bytes"
        return rows, round(elapsed, 3)

    try:
        assert query(original)[0] == [(1, 101)]
        assert query(fixed)[0] == [(1, 101)]
        assert str(path) + "-shm" not in Path("/proc/self/maps").read_text(), "Fixture must use read-only heap SHM"
        respond({"initialRows": 1, "heapShm": True, "sourceUnchanged": True})
        for line in sys.stdin:
            command = json.loads(line)
            stage = command["stage"]
            if stage == "stop":
                break
            before = source_hashes(path)
            assert before == command["hashes"], "Unexpected source change outside fixture writer"
            if stage == "incoming":
                stale, stale_ms = query(original)
                current, current_ms = query(fixed)
                assert stale == [(1, 101)], stale
                assert current == [(1, 101), (2, 102)], current
                assert fixed._table_sequences[(path, "messages")] == 1, "Reopen reset incoming watermark"
                # Resume from the existing watermark, then record the consumed
                # row. This tests the actual service query and state, not a
                # replacement implementation of the bridge's durable cursor.
                assert query(fixed, "SELECT local_id FROM messages WHERE local_id>1")[0] == [(2,)]
                fixed._table_sequences[(path, "messages")] = 2
                result = {"oldRows": len(stale), "fixedRows": len(current),
                          "oldQueryMs": stale_ms, "fixedQueryMs": current_ms}
            else:
                current, current_ms = query(fixed)
                expected_id = 0 if stage == "outgoing_pending" else 103
                assert current == [(1, 101), (2, 102), (3, expected_id)], current
                assert fixed._table_sequences[(path, "messages")] == 2, "Reopen reset persisted input state"
                result = {"localId": 3, "serverId": expected_id, "fixedQueryMs": current_ms}
            assert source_hashes(path) == before
            respond({"stage": stage, **result, "sourceUnchanged": True})
    finally:
        original.stop()
        fixed.stop()


def run_container_regression(container, python):
    source = Path(__file__).read_text()
    wrapper = Path(__file__).resolve().parents[1] / "desktop/db-worker/live_database.py"
    wrapper_source = base64.b64encode(wrapper.read_bytes()).decode()

    def start(role, arguments, user=None):
        command = ["docker", "exec", "-i"]
        if user:
            command += ["-u", user]
        command += [container, "timeout", "45", python, "-u", "-c", source, "--worker", role, *arguments]
        return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)

    def read(process):
        if not select.select([process.stdout], [], [], 12)[0]:
            raise RuntimeError("Isolated SQLCipher regression timed out")
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read()[-3000:] or "Fixture exited without a result")
        return json.loads(line)

    def command(process, value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()
        return read(process)

    writer = start("writer", ["--wrapper-source", wrapper_source])
    reader = None
    try:
        fixture = read(writer)
        reader = start("reader", ["--fixture-path", fixture["path"]], "65534:65534")
        respond({"sqlite": fixture["sqlite"], **read(reader)})
        for stage in ("incoming", "outgoing_pending", "outgoing_ack"):
            update = command(writer, {"stage": stage})
            respond(command(reader, update))
        respond({"result": "PASS", "productionFilesOpened": False})
    finally:
        for process in (reader, writer):
            if process is not None and process.poll() is None:
                try:
                    process.stdin.write('{"stage":"stop"}\n')
                    process.stdin.flush()
                    process.communicate(timeout=3)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    process.kill()
                    process.communicate()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", default="ruanruan-wechat-reader")
    parser.add_argument("--python", default="/opt/ruanruan-reader/bin/python")
    parser.add_argument("--worker", choices=("writer", "reader"))
    parser.add_argument("--wrapper-source")
    parser.add_argument("--fixture-path")
    args = parser.parse_args()
    if args.worker == "writer":
        fixture_writer(args.wrapper_source)
    elif args.worker == "reader":
        fixture_reader(args.fixture_path)
    else:
        run_container_regression(args.container, args.python)
