"""Keep read-only SQLCipher heap WAL indexes current after WCDB WAL reuse."""
import os
from pathlib import Path

from wechat_ai_bot.services.core.linux_database_service import LinuxDatabaseService


class LiveDatabaseService(LinuxDatabaseService):
    def __init__(self, *args, **kwargs):
        self._wal_watch = {}
        super().__init__(*args, **kwargs)

    @staticmethod
    def _wal_revision(path):
        try:
            value = Path(str(path) + '-wal').stat()
            return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns
        except OSError:
            return None

    @staticmethod
    def _has_shared_shm(path):
        """Inspect mappings without opening/closing SQLCipher's SHM inode.

        Closing any extra descriptor for that inode would release this process's
        POSIX locks. stat() and reading /proc/self/maps do not touch those locks.
        None means inspection was unavailable, so normal connection reuse wins.
        """
        try:
            shm = Path(str(path) + '-shm').stat()
            device = os.major(shm.st_dev), os.minor(shm.st_dev)
            for line in Path('/proc/self/maps').read_text().splitlines():
                fields = line.split(maxsplit=5)
                if len(fields) < 5 or len(fields[1]) < 4 or fields[1][3] != 's':
                    continue
                mapped_device = tuple(int(part, 16) for part in fields[3].split(':'))
                if mapped_device == device and int(fields[4]) == shm.st_ino:
                    return True
            return False
        except (OSError, ValueError):
            return None

    def _connection(self, db_path):
        path = Path(db_path)
        with self._lock:
            # Upstream refresh() can clear its connection dict directly.
            if path not in self._connections:
                self._wal_watch.pop(path, None)
            # Capture before opening/querying: a concurrent later commit must
            # remain a change to inspect on the next poll, not be marked seen.
            revision = self._wal_revision(path)
            watched = self._wal_watch.get(path)
            if path in self._connections and watched is not None and revision is not None and revision != watched:
                mapped = self._has_shared_shm(path)
                if mapped is False:
                    # Only this connection is reopened. Existing keys, message
                    # watermarks, contact caches and shard maps stay untouched.
                    self._drop_connection(path)
                elif mapped is True:
                    self._wal_watch[path] = None
            connection = super()._connection(path)
            if path not in self._wal_watch:
                identity = self._connection_identities.get(path)
                direct = identity is not None and identity[0] == 'live'
                self._wal_watch[path] = revision if direct and revision is not None and self._has_shared_shm(path) is False else None
            return connection

    def _drop_connection(self, db_path):
        self._wal_watch.pop(Path(db_path), None)
        super()._drop_connection(db_path)

    def stop(self):
        super().stop()
        self._wal_watch.clear()
