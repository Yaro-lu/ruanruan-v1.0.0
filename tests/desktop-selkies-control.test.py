"""Offline lifecycle checks with real local Unix sockets; no browser or desktop."""
import asyncio
import importlib.util
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'desktop' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


control = load('selkies_manual_control')
installer = load('install_selkies_control')


class Client:
    def __init__(self):
        self.closed = []
        self.ended = asyncio.Event()

    async def close(self, **kwargs):
        self.closed.append(kwargs)
        self.ended.set()


class LeaseTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='selkies-control-test-')
        self.path = str(Path(self.temp.name) / 'control.sock')
        self.lease = control.ManualControlLease(self.path, timeout=.3)
        self.connections = 0
        self.writers = []
        self.readers = []
        self.tasks = set()
        self.ready = asyncio.Event()
        self.ready.set()
        self.accepted = asyncio.Event()
        self.released = asyncio.Event()
        self.response = b'RR_CONTROL_READY\n'

        async def host(reader, writer):
            task = asyncio.current_task()
            self.tasks.add(task)
            self.connections += 1
            self.writers.append(writer)
            self.readers.append(reader)
            self.accepted.set()
            try:
                await self.ready.wait()
                writer.write(self.response)
                await writer.drain()
                await reader.read()
                self.released.set()
            finally:
                writer.close()
                await writer.wait_closed()
                self.tasks.discard(task)

        self.server = await asyncio.start_unix_server(host, self.path)

    async def asyncTearDown(self):
        for client in list(self.lease.clients | self.lease.revoked):
            await self.lease.release(client)
        self.server.close()
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*list(self.tasks), return_exceptions=True)
        await self.server.wait_closed()
        self.temp.cleanup()

    async def test_input_admission_waits_for_host_ready(self):
        self.ready.clear()
        client = Client()
        task = asyncio.create_task(self.lease.ensure(client, {'role': 'controller'}))
        await asyncio.wait_for(self.accepted.wait(), .2)
        self.assertFalse(task.done())
        self.assertNotIn(client, self.lease.clients)
        self.ready.set()
        await task
        self.assertIn(client, self.lease.clients)

    async def test_multiple_controllers_share_one_lease_until_last_disconnect(self):
        first, second = Client(), Client()
        await asyncio.gather(*(self.lease.ensure(c, {'role': 'controller'}) for c in (first, second)))
        self.assertEqual(self.connections, 1)
        await self.lease.release(first)
        self.assertFalse(self.released.is_set())
        self.assertIn(second, self.lease.clients)
        await self.lease.release(second)
        await asyncio.wait_for(self.released.wait(), .2)

    async def test_shared_viewer_is_free_but_gamepad_or_later_keyboard_grant_takes_lease(self):
        viewer, player = Client(), Client()
        await self.lease.ensure(viewer, {'role': 'viewer', 'token': 'viewer'})
        self.assertEqual(self.connections, 0)
        await self.lease.ensure(player, {'role': 'viewer', 'slot': 2})
        await self.lease.ensure(viewer, {'role': 'viewer', 'token': 'viewer'}, 'viewer')
        self.assertEqual(self.connections, 1)
        self.assertEqual(self.lease.clients, {viewer, player})

    async def test_host_connection_loss_revokes_existing_clients_before_allowing_more_input(self):
        first, second = Client(), Client()
        await asyncio.gather(*(self.lease.ensure(c, {'role': 'controller'}) for c in (first, second)))
        self.writers[0].close()
        await self.writers[0].wait_closed()
        await asyncio.wait_for(asyncio.gather(first.ended.wait(), second.ended.wait()), .2)
        self.assertEqual(first.closed[0]['code'], 1011)
        with self.assertRaises(control.ManualControlUnavailable):
            await self.lease.ensure(first, {'role': 'controller'})
        self.assertEqual(self.connections, 1, 'revoked connection cannot silently regain input')

    async def test_unavailable_or_denied_host_never_admits_controller(self):
        missing = control.ManualControlLease(self.path + '.missing', timeout=.2)
        client = Client()
        with self.assertRaises(control.ManualControlUnavailable):
            await missing.ensure(client, {'role': 'controller'})
        self.assertEqual(client.closed[0]['code'], 1013)
        self.response = b'busy\n'
        with self.assertRaises(control.ManualControlUnavailable):
            await self.lease.ensure(Client(), {'role': 'controller'})
        self.assertFalse(self.lease.clients)
        await asyncio.wait_for(self.released.wait(), .2)

    async def test_cancel_during_host_handshake_closes_its_connection(self):
        self.ready.clear()
        task = asyncio.create_task(self.lease.ensure(Client(), {'role': 'controller'}))
        await asyncio.wait_for(self.accepted.wait(), .2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertIsNone(self.lease.writer)
        self.assertEqual(await asyncio.wait_for(self.readers[0].read(), .2), b'')
        # This handshake never received READY, so no client was admitted.
        self.assertFalse(self.lease.clients)

    async def test_guard_releases_even_when_upstream_returns_before_its_cleanup(self):
        client = Client()

        @control.manual_control_guard
        async def early_return(_self, websocket):
            await control.manual_control_ensure(websocket, {'role': 'controller'})
            return 'closed-before-MODE'

        with patch.object(control, '_lease', self.lease):
            self.assertEqual(await early_return(None, client), 'closed-before-MODE')
        await asyncio.wait_for(self.released.wait(), .2)

    async def test_patched_legacy_handler_executes_without_secure_mode_token_global(self):
        class LegacyClient(Client):
            remote_address = ('127.0.0.1', 12345)

            async def send(self, message):
                self.messages.append(message)
                self.test.assertIn(self, self.test.lease.clients)

            async def __aiter__(self):
                yield 'kd,65'

        source = installer.patched_source(SAMPLE.replace('active_mk_token = None\n', ''))
        namespace = {'manual_control_guard': control.manual_control_guard,
            'manual_control_ensure': control.manual_control_ensure,
            'data_logger': types.SimpleNamespace(info=lambda *_: None)}
        exec(compile(source.replace(installer.IMPORT, ''), '<patched-legacy-handler>', 'exec'), namespace)
        self.assertNotIn('active_mk_token', namespace)
        client = LegacyClient(); client.messages = []; client.test = self
        handled = []

        async def on_message(message, display):
            self.assertIn(client, self.lease.clients)
            handled.append((message, display))

        server = namespace['DataStreamingServer']()
        server.clients = set(); server.mode = 'websockets'
        server.input_handler = types.SimpleNamespace(on_message=on_message)
        with patch.object(control, '_lease', self.lease):
            await server.ws_handler(client)
        self.assertEqual(client.messages, ['MODE websockets'])
        self.assertEqual(handled, [('kd,65', 'primary')])
        self.assertFalse(client.closed)
        self.assertFalse(namespace['client_permissions'])
        await asyncio.wait_for(self.released.wait(), .2)


SAMPLE = '''from __future__ import annotations
client_permissions = {}
active_mk_token = None
class DataStreamingServer:
    async def ws_handler(self, websocket):
        role = 'controller'
        slot = None
        client_permissions[websocket] = {"token": None, "role": role, "slot": slot}
        raddr = websocket.remote_address
        data_logger.info(f"Data WebSocket connected from {raddr}")
        self.clients.add(websocket)
        await websocket.send(f"MODE {self.mode}")
        try:
            async for message in websocket:
                await self.input_handler.on_message(message, 'primary')
        finally:
            client_permissions.pop(websocket, None)
'''


class InstallerTests(unittest.TestCase):
    def test_installer_is_idempotent_keeps_original_and_restores(self):
        with tempfile.TemporaryDirectory(prefix='selkies-install-test-') as folder:
            path = Path(folder)
            target = path / 'selkies.py'
            target.write_text(SAMPLE)
            self.assertEqual(installer.install(path), 'installed')
            result = target.read_text()
            self.assertEqual(installer.install(path), 'already installed')
            self.assertEqual(target.read_text(), result)
            self.assertEqual((path / 'selkies.py.ruanruan-original').read_text(), SAMPLE)
            self.assertTrue((path / 'selkies_manual_control.py').is_file())
            self.assertLess(result.index('await manual_control_ensure'), result.index('self.clients.add'))
            self.assertEqual(result.count('await manual_control_ensure'), 2)
            installer.install(path, restore=True)
            self.assertEqual(target.read_text(), SAMPLE)

    def test_changed_or_ambiguous_upstream_anchors_fail_without_mutation(self):
        for source in (SAMPLE.replace('raddr = websocket.remote_address', 'raddr = None'),
                SAMPLE + '\n' + installer.PATCHES[1][0]):
            with self.assertRaises(RuntimeError):
                installer.patched_source(source)
        changed = installer.patched_source(SAMPLE).replace('@manual_control_guard', '@another_guard')
        with self.assertRaises(RuntimeError):
            installer.patched_source(changed)

    def test_original_v1_token_reference_is_upgraded_without_losing_other_code(self):
        current = installer.patched_source(SAMPLE)
        old = current.replace('globals().get("active_mk_token")', 'active_mk_token')
        self.assertEqual(installer.patched_source(old), current)
        hotfix = current.replace('globals().get("active_mk_token")', "globals().get('active_mk_token')")
        self.assertEqual(installer.patched_source(hotfix), hotfix)


if __name__ == '__main__':
    unittest.main()
