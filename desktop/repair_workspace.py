"""Host-owned isolated validation and idle deployment for desktop code repairs."""
import fcntl
import ctypes
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import uuid

PROJECT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get('WCB_DESKTOP_DATA', Path.home()/'.wechat-codex-desktop'))
# Runtime imports and fixed host tests read bundled plugin documents. Include
# their snapshot as context; _editable deliberately excludes the plugins tree.
ROOTS = {'src', 'desktop', 'tests', 'personas', 'plugins', 'docs', 'scripts', 'third_party'}
CONTEXT = {'package.json', 'package-lock.json', 'tsconfig.json', '.gitignore', 'AGENTS.md', 'README.md'}
SKIP = {'.git', 'node_modules', '__pycache__', '.cache', 'assets', 'acceptance', 'artifacts', 'exports', 'upstream', 'vendor'}
GENERATED = {'.repair-build', '.repair-validation'}
PROTECTED = {'desktop/repair_workspace.py', 'desktop/repair_worker.py', 'desktop/repair_queue.py',
    'desktop/background_budget.py', 'desktop/repair_capsule.py',
    'desktop/deployment_hold.py', 'desktop/deploy_hold.py', 'src/desktop/deployment-hold.ts',
    'desktop/install_database_transport.py',
    'desktop/security_notify.py', 'desktop/wechat_gui.py', 'desktop/transport_recovery.py',
    'desktop/manual_control.py', 'src/desktop/manual-control.ts',
    'desktop/selkies_manual_control.py', 'desktop/install_selkies_control.py',
    'src/wechat/access.ts', 'src/desktop/store.ts', 'src/desktop/cli.ts',
    'src/desktop/database-proof.ts', 'src/desktop/config.ts', 'src/desktop/identity.ts'}
HOST_TESTS = {'tests/desktop-security.test.py', 'tests/desktop-delivery-recovery.test.py', 'tests/desktop-manual-control.test.py',
    'tests/desktop-deployment-hold.test.py', 'tests/desktop-channel.test.ts',
    'tests/desktop-database.test.ts', 'tests/desktop-only-imports.test.ts',
    'tests/desktop-deployment-hold.test.ts'}
BRIDGE = 'wechat-desktop-bridge.service'
DATABASE = 'wechat-desktop-database.service'
RUNTIME = 'wechat-desktop-runtime.service'
HEARTBEAT = 'ruanruan-heartbeat.service'


def _json(path, default=None):
    return json.loads(Path(path).read_text()) if Path(path).exists() else default


def _atomic(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600); temporary.replace(path)


def _hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _ignored(name):
    return name in SKIP or name in GENERATED or name.startswith(('dist', '.desktop-release-', '.env')) or name.endswith('.log')


def _inventory(root):
    result = {}
    for folder, directories, files in os.walk(root, followlinks=False):
        for name in list(directories):
            path = Path(folder) / name
            if _ignored(name):
                directories.remove(name)
            elif path.is_symlink():
                result[str(path.relative_to(root))] = {'symlink': os.readlink(path)}
                directories.remove(name)
        for name in files:
            if _ignored(name): continue
            path = Path(folder) / name; relative = str(path.relative_to(root))
            result[relative] = {'symlink': os.readlink(path)} if path.is_symlink() else {
                'hash': _hash(path), 'mode': path.stat().st_mode & 0o777}
    return result


def _editable(relative):
    path = Path(relative)
    if relative in PROTECTED | HOST_TESTS or path.name == 'AGENTS.md' or any(_ignored(part) for part in path.parts): return False
    if path.parts[0] == 'src': return path.suffix in ('.ts', '.json')
    if path.parts[0] == 'tests': return path.suffix in ('.ts', '.py', '.json', '.txt', '.md', '.png')
    if path.parts[0] in ('personas', 'docs'): return path.suffix in ('.md', '.txt', '.json')
    if path.parts[0] == 'desktop':
        if len(path.parts) == 2: return path.suffix in ('.py', '.md', '.txt', '.json') and not path.name.endswith('.example.json')
        return relative in ('desktop/db-worker/rpc.py', 'desktop/db-worker/live_database.py')
    return len(path.parts) == 1 and path.suffix == '.md'


def create_workspace(incident_dir, *, project=PROJECT, data=DATA):
    incident = Path(incident_dir).resolve(); incident.mkdir(parents=True, exist_ok=True, mode=0o700)
    project = Path(project).resolve(); workspace = incident / 'workspace'
    if workspace.exists(): raise RuntimeError('Repair workspace already exists')
    workspace.mkdir(mode=0o700)
    for item in project.iterdir():
        if item.is_symlink() or _ignored(item.name): continue
        if item.is_dir() and item.name in ROOTS:
            def ignore(folder, names):
                return [name for name in names if _ignored(name) or (Path(folder) / name).is_symlink()
                    or ((Path(folder) / name).is_file() and (Path(folder) / name).stat().st_size > 2_000_000)]
            shutil.copytree(item, workspace / item.name, ignore=ignore)
        elif item.is_file() and (item.name in CONTEXT or item.suffix == '.md'):
            shutil.copy2(item, workspace / item.name)
    modules = project / 'node_modules'
    if modules.exists(): (workspace / 'node_modules').symlink_to(modules, target_is_directory=True)
    value = _json(incident / 'incident.json', {})
    if value.get('evidence'):
        # Copy only this incident's captured evidence, never grant access to
        # the production directory referred to by the original observation.
        evidence = dict(value['evidence'])
        local = workspace / '.repair-evidence'; local.mkdir(mode=0o700)
        for key, filename in [('screenshot', 'failure.png'), ('beforeScreenshot', 'before.png')]:
            evidence.pop(key, None)
            source = incident / filename
            if source.is_file() and not source.is_symlink() and source.stat().st_size <= 8 * 1024 * 1024:
                copied = local / filename; shutil.copyfile(source, copied); copied.chmod(0o600)
                evidence[key] = str(copied.relative_to(workspace))
        _atomic(local / 'incident.json', evidence)
    baseline = incident / 'workspace-baseline.json'
    _atomic(baseline, {'files': _inventory(workspace), 'modules': str(modules.resolve()), 'createdAt': int(time.time() * 1000)})
    return {'path': str(workspace), 'baseline': str(baseline), 'incident': str(incident),
        'production': str(project), 'data': str(Path(data).resolve())}


def _changes(workspace):
    root = Path(workspace['path']); baseline = _json(workspace['baseline'])
    modules = root / 'node_modules'
    if Path(baseline['modules']).exists() and (not modules.is_symlink() or str(modules.resolve()) != baseline['modules']):
        raise RuntimeError('Shared node_modules link changed')
    current = _inventory(root); old = baseline['files']
    changed = [name for name in sorted(set(old) | set(current)) if old.get(name) != current.get(name)]
    for name in changed:
        if not _editable(name) or 'symlink' in current.get(name, {}): raise RuntimeError('Repair changed a protected path: ' + name)
    return changed, current, baseline


def _run(command, *, cwd=None, env=None, timeout=180):
    result = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        timeout=timeout, text=True)
    if result.returncode: raise RuntimeError('Command failed: ' + ' '.join(map(str, command[:4])) + '\n' + result.stdout[-6000:])
    return result.stdout


def _sandbox(workspace, command, *, timeout=180):
    root = Path(workspace['path']); baseline = _json(workspace['baseline'])
    validation = root / '.repair-validation'; validation.mkdir(exist_ok=True)
    args = ['bwrap', '--unshare-net', '--unshare-pid', '--new-session', '--die-with-parent']
    for directory in ('/usr', '/bin', '/lib', '/lib64'):
        if Path(directory).exists(): args += ['--ro-bind', directory, directory]
    args += ['--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', str(root), str(root)]
    if Path(baseline['modules']).exists(): args += ['--ro-bind', baseline['modules'], baseline['modules']]
    args += ['--chdir', str(root), '--', *map(str, command)]
    # No production HOME, credentials, runtime socket, proxies or Docker socket.
    env = {'PATH': '/usr/bin:/bin:/usr/local/bin', 'HOME': '/tmp', 'TMPDIR': '/tmp', 'LANG': 'C.UTF-8',
        'WCB_DATA_DIR': str(validation / 'app'), 'WCB_DESKTOP_DATA': str(validation / 'desktop'),
        'WCB_DESKTOP_CONFIG': str(validation / 'bridge.json'), 'WCB_CODEX_EPHEMERAL': '1',
        'PYTHONDONTWRITEBYTECODE': '1', 'NODE_NO_WARNINGS': '1'}
    return _run(args, cwd=root, env=env, timeout=timeout)


def _tests(root, changed):
    chosen = {name for name in HOST_TESTS if (root / name).is_file()}
    chosen.update(name for name in changed if name.startswith('tests/') and name.endswith(('.test.py', '.test.ts')) and (root / name).exists())
    if any(name.startswith('personas/') for name in changed) and (root / 'tests/prompt-layout.test.ts').exists():
        chosen.add('tests/prompt-layout.test.ts')
    modules = [Path(name) for name in changed if not name.startswith('tests/') and Path(name).suffix in ('.py', '.ts')]
    for test in (root / 'tests').glob('*.test.*') if (root / 'tests').exists() else []:
        # This host launcher attaches to a pre-existing reader container; it is
        # intentionally not an unattended repair test against production.
        if test.name == 'desktop-wal-visibility.test.py': continue
        if test.suffix not in ('.py', '.ts'): continue
        text = test.read_text()
        if any(str(module).replace('.ts', '.js') in text or module.name in text or "import " + module.stem in text
            or "from " + module.stem in text for module in modules): chosen.add(str(test.relative_to(root)))
    return sorted(chosen)


def _container_candidate(workspace, changed):
    container = [name for name in changed if name.startswith('desktop/db-worker/')]
    if not container: return None
    if any(not (Path(workspace['path']) / name).exists() for name in container): raise RuntimeError('Container runtime files cannot be deleted automatically')
    settings = _json(Path(workspace['data']) / 'database.json', {})
    image = settings.get('readerImage')
    if not isinstance(image, str) or not image.startswith('local/'): raise RuntimeError('Expected a locally installed reader image')
    old = _run(['docker', 'image', 'inspect', image, '--format', '{{.Id}}']).strip()
    if not old.startswith('sha256:') or len(old) != 71 or any(c not in '0123456789abcdef' for c in old[7:]): raise RuntimeError('Invalid local image ID')
    folder = Path(workspace['incident']) / 'container-build'; folder.mkdir(exist_ok=True)
    # BuildKit parses a raw `FROM sha256:...` as a registry repository/tag.
    # Give the verified local image an isolated local tag instead. Production's
    # reader tag is never moved while building or validating the candidate.
    base = 'local/ruanruan-reader-base:' + uuid.uuid4().hex
    _run(['docker', 'tag', old, base])
    lines = ['FROM ' + base]
    for name in container:
        source = Path(workspace['path']) / name; shutil.copy2(source, folder / source.name)
        lines.append('COPY ' + source.name + ' /opt/ruanruan-reader/' + source.name)
    (folder / 'Dockerfile').write_text('\n'.join(lines) + '\n')
    candidate = 'local/ruanruan-wechat-reader:auto-repair-' + uuid.uuid4().hex[:12]
    try:
        _run(['docker', 'build', '--network=none', '--pull=false', '--tag', candidate, str(folder)], timeout=180)
        if _run(['docker', 'image', 'inspect', base, '--format', '{{.Id}}']).strip() != old:
            raise RuntimeError('Local reader base tag changed while building the candidate')
    finally:
        _run(['docker', 'image', 'rm', base], timeout=30)
    return {'image': image, 'previous': old, 'candidate': candidate}


def complete_runtime(source, build):
    """Verify a fresh build without importing application entry points or running them."""
    source = Path(source); build = Path(build)
    for path in source.rglob('*.ts'):
        if path.name.endswith('.d.ts'): continue
        emitted = build / path.relative_to(source).with_suffix('.js')
        if not emitted.is_file(): raise RuntimeError('Incomplete runtime build: ' + str(emitted.relative_to(build)))
    # Path-based JSON reads are not all copied by tsc's resolveJsonModule.
    for path in source.rglob('*.json'):
        destination = build / path.relative_to(source)
        destination.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, destination)
    for path in build.rglob('*'):
        if path.is_symlink(): raise RuntimeError('Runtime build contains a symlink: ' + str(path))
        if path.suffix != '.js': continue
        imports = re.findall(r'''(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']''', path.read_text())
        for target in imports:
            dependency = (path.parent / target).resolve()
            if dependency.suffix in ('.js', '.json') and not dependency.is_file():
                raise RuntimeError('Incomplete runtime import: ' + str(path.relative_to(build)) + ' -> ' + target)
    if not any(build.rglob('*.js')): raise RuntimeError('Compiled runtime is empty')


def exchange_directories(first, second):
    """Linux rename exchange: readers see a complete old or new directory, never a gap."""
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(first), -100, os.fsencode(second), 2) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(first))


def stage_runtime(source, build, production):
    """Stage on the destination filesystem; never compile into the live directory."""
    stage = Path(tempfile.mkdtemp(prefix='.desktop-release-', dir=production))
    try:
        shutil.copytree(Path(build) / 'src', stage / 'src')
        complete_runtime(Path(source) / 'src', stage / 'src')
        return stage
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def validate_workspace(workspace):
    try:
        changed, current, baseline = _changes(workspace)
        if not changed: return {'ok': False, 'status': 'unchanged', 'changed': [], 'tests': []}
        root = Path(workspace['path']); tests = _tests(root, changed)
        python = [name for name in changed if name.endswith('.py') and (root / name).exists()]
        if python:
            _sandbox(workspace, ['python3', '-c', 'import pathlib,sys; [compile(pathlib.Path(p).read_bytes(),p,"exec") for p in sys.argv[1:]]', *python])
        runtime = any(name.startswith('src/') and name.endswith(('.ts', '.json')) for name in changed)
        for name in changed:
            if name.startswith('src/') and name.endswith('.json') and (root / name).exists():
                json.loads((root / name).read_text())
        typescript = runtime or any(name.endswith('.ts') for name in changed) or any(name.endswith('.ts') for name in tests)
        if typescript:
            output = root / '.repair-build'
            if output.is_symlink(): output.unlink()
            elif output.exists(): shutil.rmtree(output)
            _sandbox(workspace, ['node', 'node_modules/typescript/bin/tsc', '--outDir', '.repair-build'], timeout=240)
            complete_runtime(root / 'src', root / '.repair-build' / 'src')
        image = _container_candidate(workspace, changed)
        pytests = [name for name in tests if name.endswith('.py')]
        for name in pytests:
            if image and 'desktop/db-worker/' in (root / name).read_text():
                _run(['docker', 'run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
                    '--security-opt=no-new-privileges', '--cpus=0.7', '--memory=512m', '--pids-limit=80',
                    '--user', str(os.getuid()) + ':' + str(os.getgid()), '--tmpfs', '/tmp:rw,nosuid,size=256m',
                    '--mount', 'type=bind,src=' + str(root) + ',dst=/repair,readonly',
                    '--env', 'HOME=/tmp', '--env', 'WCB_DATA_DIR=/tmp/test-app',
                    '--env', 'WCB_DESKTOP_DATA=/tmp/test-desktop', '--env', 'PYTHONDONTWRITEBYTECODE=1',
                    '--entrypoint', '/opt/ruanruan-reader/bin/python', image['candidate'], '/repair/' + name], timeout=120)
            else: _sandbox(workspace, ['python3', name], timeout=120)
        tstests = [str(Path('.repair-build') / Path(name).with_suffix('.js')) for name in tests if name.endswith('.ts')]
        if tstests: _sandbox(workspace, ['node', '--test', *tstests], timeout=180)
        if _changes(workspace)[1] != current: raise RuntimeError('Validation changed repair source files')
        result = {'ok': True, 'status': 'validated', 'changed': changed, 'tests': tests, 'typescript': typescript,
            'fingerprints': {name: current.get(name) for name in changed}, 'image': image,
            'buildFiles': _inventory(root / '.repair-build' / 'src') if typescript else {}}
        _atomic(Path(workspace['incident']) / 'validation.json', result)
        return result
    except Exception as error:
        return {'ok': False, 'status': 'failed', 'error': str(error)[-6000:]}


def _rows(path, query):
    if not Path(path).exists(): return []
    db = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=2)
    try: return db.execute(query).fetchall()
    finally: db.close()


def _job_running(path):
    value = _json(path, {})
    if value.get('state') not in ('pending', 'running'): return False
    age = time.time() * 1000 - value.get('updatedAt', time.time() * 1000)
    if age < 30_000: return True
    identifier = path.parent.name
    if not re.fullmatch(r'[a-f0-9-]{36}', identifier): return True
    try:
        raw = _run(['systemctl', '--user', 'show', 'wechat-task-' + identifier + '.service',
            '--property=LoadState,ActiveState'], timeout=5)
        state = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
        # Waiting wrappers are active too. An unavailable systemd query is not
        # proof that a job stopped; only explicit inactive/failed units qualify.
        if state.get('LoadState') in ('loaded', 'not-found') and state.get('ActiveState') in ('inactive', 'failed'):
            return False
    except Exception:
        pass
    return True


def _busy(workspace, *, held=False):
    data = Path(workspace['data']); app = data / 'app'
    config = _json(data / 'bridge.json', {})
    channel = Path(config.get('queueDirectory', str(data / 'bridge'))) / 'channel.sqlite3'
    if _rows(channel, 'SELECT 1 FROM channel_pause LIMIT 1'): return 'security_paused'
    if _rows(channel, 'SELECT 1 FROM ui_lease LIMIT 1'): return 'active_ui_lease'
    states = "'claimed','ready'" if held else "'queued','claimed','ready'"
    if _rows(channel, 'SELECT 1 FROM outgoing WHERE status IN (' + states + ') LIMIT 1'): return 'outgoing_busy'
    if _rows(channel, "SELECT 1 FROM incoming WHERE status='processing' LIMIT 1"): return 'incoming_processing'
    if not held and _rows(channel, "SELECT 1 FROM incoming WHERE status='pending' LIMIT 1"): return 'incoming_queued'
    if _rows(app / 'generated-images' / 'queue.sqlite3', "SELECT 1 FROM jobs WHERE json_extract(value,'$.status')='generating' LIMIT 1"): return 'image_generating'
    for path in (app / 'jobs').glob('*/status.json'):
        if _job_running(path): return 'business_job_running'
    for path in (app / 'sessions').glob('*.json'):
        session = _json(path, {})
        if session.get('state') == 'processing' or session.get('pendingRequest'): return 'business_session_running'
    if not held and any(rows for _, rows in _json(app / 'message-queue.json', [])): return 'message_queue_pending'
    # The life daemon uses the same dist-desktop tree, but stores jobs beside
    # the shared life directory instead of in the personal chat app directory.
    life = app / 'character-life'
    if life.is_symlink():
        for path in (life.resolve().parent / 'jobs').glob('*/status.json'):
            if _json(path.parent / 'job.json', {}).get('kind') == 'life' and _job_running(path):
                return 'life_job_running'
    return None


def _cancelled(workspace):
    return bool(_json(Path(workspace['incident']) / 'incident.json', {}).get('cancelRequested'))


def _conflicts(workspace, changed, baseline, typescript):
    production = Path(workspace['production']); names = set(changed)
    # A full TS build includes unchanged imports; never deploy an older compiled
    # version over concurrent user edits elsewhere in that source tree.
    if typescript:
        names.update(name for name in baseline['files'] if name.startswith('src/'))
        names.update('src/' + name for name in _inventory(production / 'src'))
        names.update(('package.json', 'package-lock.json', 'tsconfig.json'))
    conflicts = []
    for name in names:
        path = production / name; previous = baseline['files'].get(name)
        if path.is_symlink() or (previous is None and path.exists()) or (previous is not None
            and (not path.is_file() or _hash(path) != previous.get('hash'))): conflicts.append(name)
    return sorted(conflicts)


def _replace(source, destination):
    destination = Path(destination); destination.parent.mkdir(parents=True, exist_ok=True)
    if source is None:
        destination.unlink(missing_ok=True); return
    temporary = destination.with_name(destination.name + '.' + uuid.uuid4().hex + '.tmp')
    shutil.copy2(source, temporary); temporary.replace(destination)


def _wait_ready(services, renew, timeout=45):
    if not services: return
    deadline = time.monotonic() + timeout
    since = str(int(time.time()) - 120)
    while time.monotonic() < deadline:
        renew(); ready = True
        for service in services:
            raw = _run(['systemctl', '--user', 'show', service, '--property=ActiveState,SubState,MainPID'], timeout=5)
            state = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
            if state.get('ActiveState') == 'failed': raise RuntimeError(service + ' failed after restart')
            if state.get('ActiveState') != 'active' or state.get('SubState') != 'running': ready = False; continue
            if service == DATABASE:
                pid = state.get('MainPID', '')
                if not pid.isdigit() or int(pid) <= 0: ready = False; continue
                logs = _run(['journalctl', '--user', '--unit', DATABASE, '_PID=' + pid,
                    '--since', '@' + since, '--no-pager', '--output=cat', '--lines=80'], timeout=5)
                if '独立读库收件与界面发送已就绪' not in logs: ready = False
        if ready: return
        time.sleep(0.5)
    raise RuntimeError('Restarted desktop services did not become ready before the deadline')


def deploy_workspace(workspace):
    recovery = recover_interrupted_deployment(workspace)
    if recovery is not None: return recovery
    if _cancelled(workspace): return {'status': 'blocked', 'reason': 'incident_cancelled'}
    validation = _json(Path(workspace['incident']) / 'validation.json', {})
    if not validation.get('ok'): return {'status': 'blocked', 'reason': 'validation_required'}
    try:
        changed, current, baseline = _changes(workspace)
        if {name: current.get(name) for name in changed} != validation['fingerprints']:
            return {'status': 'blocked', 'reason': 'repair_changed_after_validation'}
        if validation['typescript'] and _inventory(Path(workspace['path']) / '.repair-build' / 'src') != validation['buildFiles']:
            return {'status': 'blocked', 'reason': 'compiled_build_changed_after_validation'}
        conflicts = _conflicts(workspace, changed, baseline, validation['typescript'])
        if conflicts: return {'status': 'conflict', 'reason': 'production_changed', 'paths': conflicts}
        busy = _busy(workspace)
        if busy: return {'status': 'deferred', 'reason': busy}
        data = Path(workspace['data']); data.mkdir(exist_ok=True, parents=True)
        hold = data / 'auto-repair' / 'deploy-hold.json'
        with (data / 'ui.lock').open('a') as lock:
            try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return {'status': 'deferred', 'reason': 'ui_busy'}
            existing = _json(hold, {})
            if existing.get('until', 0) > time.time() * 1000:
                try: os.kill(int(existing.get('pid', 0)), 0)
                except (ProcessLookupError, ValueError): pass
                else: return {'status': 'deferred', 'reason': 'deployment_in_progress'}
            def renew(): _atomic(hold, {'pid': os.getpid(), 'until': int(time.time() * 1000) + 120_000})
            renew()
            try:
                busy = _busy(workspace, held=True)
                if busy: return {'status': 'deferred', 'reason': busy}
                if _cancelled(workspace): return {'status': 'blocked', 'reason': 'incident_cancelled'}
                conflicts = _conflicts(workspace, changed, baseline, validation['typescript'])
                if conflicts: return {'status': 'conflict', 'reason': 'production_changed', 'paths': conflicts}
                return _apply(workspace, validation, changed, renew)
            finally:
                if _json(hold, {}).get('pid') == os.getpid(): hold.unlink(missing_ok=True)
    except Exception as error:
        return {'status': 'failed', 'reason': str(error)[-6000:]}


def recover_interrupted_deployment(workspace):
    """Finish rollback after a host/worker exit in the middle of a deployment."""
    path = Path(workspace['incident']) / 'deployment-transaction.json'
    record = _json(path, {})
    if record.get('state') == 'committed': return record.get('result')
    if record.get('state') not in ('prepared', 'rollback_failed'): return None
    production = Path(workspace['production']); data = Path(workspace['data'])
    errors = []
    with (data / 'ui.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return {'status': 'deferred', 'reason': 'interrupted_deployment_ui_busy'}
        hold = data / 'auto-repair/deploy-hold.json'
        def renew(): _atomic(hold, {'pid': os.getpid(), 'until': int(time.time() * 1000) + 120_000})
        renew()
        try:
            # Refuse to overwrite a later human change during crash recovery.
            for name, previous in record['originals'].items():
                target = production / name
                actual = _hash(target) if target.is_file() else None
                before = _hash(previous) if previous else None
                if target.is_symlink() or actual not in (before, record['next'][name]):
                    raise RuntimeError('Interrupted deployment conflicts with a later edit: ' + name)
            stage = Path(record['stage']) if record.get('stage') else None
            live = production / 'dist-desktop'
            if stage and (_inventory(live) not in (record['previousBuild'], record['nextBuild'])
                or _inventory(stage) not in (record['previousBuild'], record['nextBuild'])):
                raise RuntimeError('Interrupted runtime deployment has changed since the transaction')
            for service in reversed(record['restart']):
                renew(); _run(['systemctl', '--user', 'stop', service], timeout=30)
            if stage and _inventory(live) == record['nextBuild'] and record['nextBuild'] != record['previousBuild']:
                exchange_directories(stage, live)
            for name, previous in record['originals'].items(): _replace(previous, production / name)
            image = record.get('image')
            if image:
                actual = _run(['docker', 'image', 'inspect', image['image'], '--format', '{{.Id}}']).strip()
                candidate = _run(['docker', 'image', 'inspect', image['candidate'], '--format', '{{.Id}}']).strip()
                if actual not in (image['previous'], candidate): raise RuntimeError('Reader image changed after deployment interruption')
                _run(['docker', 'tag', image['previous'], image['image']])
            for service in record['restart']:
                renew(); _run(['systemctl', '--user', 'restart', service], timeout=30)
            _wait_ready(record['restart'], renew)
        except Exception as error:
            errors.append(str(error))
        finally:
            _atomic(path, {**record, 'state': 'rollback_failed' if errors else 'rolled_back'})
            if _json(hold, {}).get('pid') == os.getpid(): hold.unlink(missing_ok=True)
    return {'status': 'failed', 'reason': 'Interrupted deployment restored the previous release' if not errors else 'Interrupted deployment rollback failed',
        'rolledBack': not errors, 'rollbackErrors': errors}


def _apply(workspace, validation, changed, renew):
    source = Path(workspace['path']); production = Path(workspace['production'])
    replacements = {name: source / name if (source / name).exists() else None for name in changed}
    runtime_ts = any(name.startswith('src/') and name.endswith(('.ts', '.json')) for name in changed)
    stage = stage_runtime(source, source / '.repair-build', production) if runtime_ts else None
    live = production / 'dist-desktop'
    if stage is not None and (live.is_symlink() or not live.is_dir()):
        shutil.rmtree(stage)
        raise RuntimeError('Expected an existing complete desktop runtime directory')
    restart = [BRIDGE, DATABASE] if runtime_ts else [DATABASE] if any(name.startswith('desktop/') and name.endswith('.py') for name in changed) else []
    if runtime_ts and (production / 'scripts/codex-runtime.mjs').is_file(): restart.insert(0, RUNTIME)
    if runtime_ts and (production / 'src/life-daemon.ts').is_file(): restart.insert(0, HEARTBEAT)
    backups = Path(workspace['incident']) / 'rollback'; backups.mkdir(exist_ok=True)
    originals = {}
    for name in replacements:
        path = production / name
        if path.is_symlink(): raise RuntimeError('Deployment destination became a symlink: ' + name)
        original = backups / name if path.exists() else None
        if original is not None: original.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, original)
        originals[name] = original
    applied = []; image = validation.get('image'); image_changed = False; swapped = False
    transaction = Path(workspace['incident']) / 'deployment-transaction.json'
    record = {'state': 'prepared', 'source': str(source), 'production': str(production), 'changed': changed,
        'originals': {name: str(path) if path else None for name, path in originals.items()},
        'next': {name: _hash(path) if path else None for name, path in replacements.items()},
        'restart': restart, 'image': image, 'stage': str(stage) if stage else None,
        'previousBuild': _inventory(live) if stage else None,
        'nextBuild': _inventory(stage) if stage else None}
    _atomic(transaction, record)
    try:
        # Stop consumers before changing source or images. A crash can leave
        # a complete old/new build, and the persisted transaction can restore it.
        for service in reversed(restart): renew(); _run(['systemctl', '--user', 'stop', service], timeout=30)
        busy = _busy(workspace, held=True)
        if busy:
            # A shared heartbeat may have admitted a job between the initial
            # idle check and stopping its scheduler. Leave that worker intact.
            for service in restart: renew(); _run(['systemctl', '--user', 'restart', service], timeout=30)
            _wait_ready(restart, renew)
            _atomic(transaction, {**record, 'state': 'rolled_back'})
            if stage is not None: shutil.rmtree(stage)
            return {'status': 'deferred', 'reason': busy}
        for name, path in replacements.items(): _replace(path, production / name); applied.append(name)
        if stage is not None: exchange_directories(stage, live); swapped = True
        if image:
            latest = _run(['docker', 'image', 'inspect', image['image'], '--format', '{{.Id}}']).strip()
            if latest != image['previous']: raise RuntimeError('Reader image changed since validation')
            _run(['docker', 'tag', image['candidate'], image['image']]); image_changed = True
        for service in restart: renew(); _run(['systemctl', '--user', 'restart', service], timeout=30)
        _wait_ready(restart, renew)
        result = {'status': 'applied', 'changed': changed, 'restarted': restart, 'imageUpdated': bool(image),
            'previousRuntime': str(stage) if stage else None}
        _atomic(transaction, {**record, 'state': 'committed', 'result': result})
        return result
    except Exception as error:
        failures = []
        for service in reversed(restart):
            try: _run(['systemctl', '--user', 'stop', service], timeout=30)
            except Exception as restore: failures.append(str(restore))
        if swapped:
            try: exchange_directories(stage, live)
            except Exception as restore: failures.append(str(restore))
        for name in reversed(applied):
            try: _replace(originals[name], production / name)
            except Exception as restore: failures.append(str(restore))
        if image_changed:
            try: _run(['docker', 'tag', image['previous'], image['image']])
            except Exception as restore: failures.append(str(restore))
        for service in restart:
            try: renew(); _run(['systemctl', '--user', 'restart', service], timeout=30)
            except Exception as restore: failures.append(str(restore))
        try: _wait_ready(restart, renew)
        except Exception as restore: failures.append(str(restore))
        _atomic(transaction, {**record, 'state': 'rolled_back' if not failures else 'rollback_failed'})
        return {'status': 'failed', 'reason': str(error)[-2000:], 'rolledBack': not failures, 'rollbackErrors': failures}


def cleanup_workspace(workspace):
    incident = Path(workspace['incident']).resolve(); path = Path(workspace['path'])
    if path.parent.resolve() != incident or path.name != 'workspace' or path.is_symlink(): raise RuntimeError('Unexpected workspace cleanup path')
    shutil.rmtree(path, ignore_errors=True)
