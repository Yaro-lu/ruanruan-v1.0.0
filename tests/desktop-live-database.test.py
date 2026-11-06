"""Connection lifecycle tests only; no source databases, keys or UI access."""
import importlib.util
import os
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, patch


class FakeDatabaseService:
    def __init__(self):
        self._connections = {}
        self._connection_identities = {}
        self._lock = threading.RLock()
        self._keys = {'existing': 'opaque-test-key'}
        self._table_sequences = {'existing': 12}
        self._contact_by_username = {'existing': 'contact'}
        self._message_username_map = {'existing': 'shard'}
        self.created = []
        self.identity_kind = 'live'
        self.on_open = lambda: None

    def _connection(self, path):
        if path not in self._connections:
            conn = Mock()
            self.created.append(conn)
            self._connections[path] = conn
            self._connection_identities[path] = (self.identity_kind,)
            self.on_open()
        return self._connections[path]

    def _drop_connection(self, path):
        self._connection_identities.pop(path, None)
        conn = self._connections.pop(path, None)
        if conn is not None:
            conn.close()

    def stop(self):
        for conn in self._connections.values():
            conn.close()
        self._connections.clear()
        self._connection_identities.clear()


upstream = types.ModuleType('wechat_ai_bot.services.core.linux_database_service')
upstream.LinuxDatabaseService = FakeDatabaseService
spec = importlib.util.spec_from_file_location('live_database', Path(__file__).resolve().parents[1] / 'desktop/db-worker/live_database.py')
live = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {upstream.__name__: upstream}):
    spec.loader.exec_module(live)


class LiveDatabaseTests(unittest.TestCase):
    path = Path('/fixture/message_0.db')

    def service(self, mapped=False):
        service = live.LiveDatabaseService()
        service.revision = (1, 2, 4096, 100)
        service._wal_revision = lambda _: service.revision
        service._has_shared_shm = Mock(return_value=mapped)
        return service

    def test_only_changed_wal_on_heap_connection_reopens_and_preserves_state(self):
        service = self.service()
        state = (service._keys, service._table_sequences, service._contact_by_username, service._message_username_map)
        first = service._connection(self.path)
        self.assertIs(service._connection(self.path), first)
        service.revision = (1, 2, 4096, 200)  # Same inode/length; overwritten WAL frames.
        second = service._connection(self.path)
        self.assertIsNot(second, first)
        first.close.assert_called_once()
        self.assertEqual(len(service.created), 2)
        self.assertEqual(state, (service._keys, service._table_sequences, service._contact_by_username, service._message_username_map))
        self.assertEqual(service._table_sequences, {'existing': 12})

    def test_shared_mapping_or_orphan_snapshot_keeps_existing_connection(self):
        for mapped, kind in ((True, 'live'), (None, 'live'), (False, 'orphan')):
            service = self.service(mapped)
            service.identity_kind = kind
            first = service._connection(self.path)
            service.revision = (1, 2, 8192, 200)
            self.assertIs(service._connection(self.path), first)
            first.close.assert_not_called()
            if kind == 'orphan':
                service._has_shared_shm.assert_not_called()

    def test_heap_connection_that_gains_shared_mapping_stops_reopening(self):
        service = self.service()
        first = service._connection(self.path)
        service._has_shared_shm.return_value = True
        service.revision = (1, 2, 8192, 200)
        self.assertIs(service._connection(self.path), first)
        self.assertIsNone(service._wal_watch[self.path])
        first.close.assert_not_called()

    def test_change_during_open_remains_unseen_until_next_poll(self):
        service = self.service()
        old = service.revision
        service.on_open = lambda: setattr(service, 'revision', (1, 2, 8192, 200))
        first = service._connection(self.path)
        self.assertEqual(service._wal_watch[self.path], old)
        second = service._connection(self.path)
        self.assertIsNot(second, first)
        self.assertEqual(service._wal_watch[self.path], service.revision)

    def test_upstream_clear_reclassifies_new_connection_and_stop_clears_watch(self):
        service = self.service(True)
        service._connection(self.path)
        service._connections.clear()  # Upstream refresh bypasses _drop_connection.
        service._has_shared_shm.return_value = False
        service._connection(self.path)
        self.assertEqual(service._wal_watch[self.path], service.revision)
        service.stop()
        self.assertEqual(service._wal_watch, {})

    def test_missing_wal_stat_does_not_force_reopen(self):
        service = self.service()
        first = service._connection(self.path)
        service.revision = None
        self.assertIs(service._connection(self.path), first)
        first.close.assert_not_called()

    def test_mapping_check_uses_stat_and_proc_maps_without_opening_shm(self):
        shm = Mock()
        shm.stat.return_value = types.SimpleNamespace(st_dev=os.makedev(8, 3), st_ino=42)
        maps = Mock()
        maps.read_text.return_value = '1000-2000 r--s 00000000 08:03 42 /fixture/message_0.db-shm\n'
        with patch.object(live, 'Path', side_effect=lambda path: maps if path == '/proc/self/maps' else shm):
            self.assertTrue(live.LiveDatabaseService._has_shared_shm(self.path))
            maps.read_text.return_value = '1000-2000 r--p 00000000 08:03 42 /fixture/message_0.db-shm\n'
            self.assertFalse(live.LiveDatabaseService._has_shared_shm(self.path))
            maps.read_text.side_effect = PermissionError('unavailable')
            self.assertIsNone(live.LiveDatabaseService._has_shared_shm(self.path))
        shm.open.assert_not_called()
        shm.read_bytes.assert_not_called()


if __name__ == '__main__':
    unittest.main()
