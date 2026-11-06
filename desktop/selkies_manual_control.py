"""Tie authenticated Selkies input connections to the host's existing UI lock."""
import asyncio
from functools import wraps


class ManualControlUnavailable(RuntimeError):
    pass


def needs_control(permissions, active_mk_token=None):
    # A shared viewer is read-only. Assigned gamepads and explicit mouse/key
    # grants can operate the desktop too, even when their role is 'viewer'.
    return (permissions.get('role', 'controller') != 'viewer'
        or permissions.get('slot') is not None
        or (active_mk_token is not None and permissions.get('token') == active_mk_token))


class ManualControlLease:
    def __init__(self, path='/exchange/manual-control.sock', timeout=25):
        self.path = path
        self.timeout = timeout
        self.lock = asyncio.Lock()
        self.clients = set()
        self.revoked = set()
        self.writer = None
        self.watcher = None

    async def _close_writer(self, writer):
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def ensure(self, websocket, permissions, active_mk_token=None):
        if not needs_control(permissions, active_mk_token):
            if websocket in self.clients:
                await self.release(websocket)
            return
        if websocket in self.clients and self.writer and not self.writer.is_closing():
            return
        candidate = None
        try:
            async with self.lock:
                if websocket in self.revoked:
                    raise ManualControlUnavailable('Desktop takeover lease was lost')
                if self.writer is not None and self.writer.is_closing():
                    raise ManualControlUnavailable('Desktop takeover connection is closing')
                if self.writer is None:
                    async with asyncio.timeout(self.timeout):
                        reader, candidate = await asyncio.open_unix_connection(self.path)
                        if (await reader.readline()).strip() != b'RR_CONTROL_READY':
                            raise ManualControlUnavailable('Host did not grant desktop takeover')
                    self.writer = candidate
                    candidate = None
                    self.watcher = asyncio.create_task(self._watch_host(reader, self.writer))
                self.clients.add(websocket)
        except BaseException as error:
            await self._close_writer(candidate)
            if isinstance(error, asyncio.CancelledError):
                raise
            await websocket.close(code=1013, reason='Desktop takeover unavailable; retry shortly')
            raise ManualControlUnavailable('Could not acquire host desktop takeover') from error

    async def _watch_host(self, reader, writer):
        try:
            await reader.read()
        except asyncio.CancelledError:
            return
        except (ConnectionError, OSError):
            pass
        async with self.lock:
            if self.writer is not writer:
                return
            clients = list(self.clients)
            self.revoked.update(clients)
            self.clients.clear()
            self.writer = None
            self.watcher = None
        await self._close_writer(writer)
        # Once the host lock is gone, these connections must no longer input.
        await asyncio.gather(*(client.close(code=1011, reason='Desktop takeover connection lost')
            for client in clients), return_exceptions=True)

    async def release(self, websocket):
        async with self.lock:
            self.clients.discard(websocket)
            self.revoked.discard(websocket)
            if self.clients:
                return
            writer, watcher = self.writer, self.watcher
            self.writer = self.watcher = None
        # EOF is the existing host manual_control.py session release protocol.
        await self._close_writer(writer)
        if watcher is not None:
            watcher.cancel()
            await asyncio.gather(watcher, return_exceptions=True)


_lease = ManualControlLease()


async def manual_control_ensure(websocket, permissions, active_mk_token=None):
    await _lease.ensure(websocket, permissions, active_mk_token)


def manual_control_guard(handler):
    @wraps(handler)
    async def guarded(self, websocket):
        try:
            return await handler(self, websocket)
        except ManualControlUnavailable:
            return
        finally:
            await asyncio.shield(_lease.release(websocket))
            # The upstream handler has returns before its own cleanup block.
            handler.__globals__.get('client_permissions', {}).pop(websocket, None)
    return guarded
