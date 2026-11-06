#!/usr/bin/env python3
"""Install a checked, reversible lifecycle hook into the pinned Selkies package."""
import argparse
import ast
from pathlib import Path
import shutil


PACKAGE = Path('/lsiopy/lib/python3.12/site-packages/selkies')
MARKER = '# ruanruan-manual-control-v1'
IMPORT = ('from .selkies_manual_control import manual_control_guard, manual_control_ensure\n'
          + MARKER + '\n')
PATCHES = (
    ('    async def ws_handler(self, websocket):\n',
     '    @manual_control_guard\n    async def ws_handler(self, websocket):\n'),
    ('        raddr = websocket.remote_address\n'
     '        data_logger.info(f"Data WebSocket connected from {raddr}")\n',
     '        await manual_control_ensure(websocket, client_permissions.get(websocket, {}), globals().get("active_mk_token"))\n'
     '        raddr = websocket.remote_address\n'
     '        data_logger.info(f"Data WebSocket connected from {raddr}")\n'),
    ('            async for message in websocket:\n',
     '            async for message in websocket:\n'
     '                await manual_control_ensure(websocket, client_permissions.get(websocket, {}), globals().get("active_mk_token"))\n'),
)


def patched_source(source):
    if MARKER in source:
        # Initial v1 assumed secure mode had initialized this optional global.
        # Recognize only our complete old calls and upgrade them in place.
        old = 'client_permissions.get(websocket, {}), active_mk_token)'
        if source.count(old) == 2:
            source = source.replace(old, 'client_permissions.get(websocket, {}), globals().get("active_mk_token"))')
        checked = source.replace("globals().get('active_mk_token')", 'globals().get("active_mk_token")')
        if source.count(IMPORT) != 1 or any(checked.count(after) != 1 for _, after in PATCHES):
            raise RuntimeError('Selkies manual-control patch is incomplete or changed')
        return source
    for before, _ in PATCHES:
        if source.count(before) != 1:
            raise RuntimeError('Unsupported Selkies version: lifecycle anchor missing or ambiguous')
    # This hook depends on roles being established before admission and on all
    # keyboard/mouse handling happening inside the guarded input loop.
    admission = source.index(PATCHES[1][0])
    if source.index('client_permissions[websocket] = {"token": None, "role": role, "slot": slot}') > admission:
        raise RuntimeError('Unsupported Selkies authorization order')
    if source.index('self.clients.add(websocket)', admission) > source.index('await websocket.send(f"MODE {self.mode}")', admission):
        raise RuntimeError('Unsupported Selkies connection order')
    result = source
    for before, after in PATCHES:
        result = result.replace(before, after, 1)
    # Append the import after the module docstring/import preamble, before the
    # first class. This preserves any __future__ import ordering.
    tree = ast.parse(result)
    first_class = next(node for node in tree.body if isinstance(node, ast.ClassDef))
    lines = result.splitlines(keepends=True)
    lines.insert(first_class.lineno - 1, IMPORT)
    result = ''.join(lines)
    ast.parse(result)
    return result


def install(package=PACKAGE, helper=None, restore=False):
    package = Path(package)
    target = package / 'selkies.py'
    backup = package / 'selkies.py.ruanruan-original'
    source = target.read_text()
    if restore:
        if not backup.is_file():
            raise RuntimeError('No original Selkies backup exists')
        target.write_text(backup.read_text())
        return 'restored'
    result = patched_source(source)
    helper = Path(helper) if helper else Path(__file__).with_name('selkies_manual_control.py')
    ast.parse(helper.read_text())
    if MARKER not in source:
        if backup.exists() and backup.read_text() != source:
            raise RuntimeError('Existing Selkies backup differs; refusing to overwrite')
        if not backup.exists():
            shutil.copy2(target, backup)
    shutil.copy2(helper, package / 'selkies_manual_control.py')
    if result != source:
        temporary = target.with_name(target.name + '.ruanruan-new')
        temporary.write_text(result)
        shutil.copymode(target, temporary)
        temporary.replace(target)
    return 'installed' if result != source else 'already installed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', type=Path, default=PACKAGE)
    parser.add_argument('--restore', action='store_true')
    args = parser.parse_args()
    print(install(args.package, restore=args.restore))
