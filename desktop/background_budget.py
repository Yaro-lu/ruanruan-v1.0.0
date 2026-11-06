"""One memory-heavy background job at a time, with foreground admission priority."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid


def budget_paths():
    home = Path.home()
    lock = Path(os.environ.get('WCB_BACKGROUND_LOCK', str(home / '.wechat-codex-background.lock')))
    roots = [home / '.wechat-codex-desktop/app', home / '.wechat-codex-bridge']
    if os.environ.get('WCB_BACKGROUND_APPS'):
        roots = [Path(value) for value in os.environ['WCB_BACKGROUND_APPS'].split(os.pathsep) if value]
    return lock, roots


def foreground_busy(roots, now=None):
    now = time.time() * 1000 if now is None else now
    for root in roots:
        for status in (root / 'jobs').glob('*/status.json'):
            try:
                value = json.loads(status.read_text())
                if value.get('state') not in ('pending', 'running') or now - value.get('updatedAt', 0) > 120_000: continue
                job = json.loads((status.parent / 'job.json').read_text())
                if job.get('kind') in ('codex', 'update'): return True
            except (OSError, ValueError, TypeError):
                continue
    return False


def memory_available(path=Path('/proc/meminfo')):
    values = dict(line.split(':', 1) for line in path.read_text().splitlines() if ':' in line)
    return int(values['MemAvailable'].split()[0]) * 1024


@contextmanager
def background_slot():
    lock, roots = budget_paths()
    lock.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with lock.open('a') as stream:
        lock.chmod(0o600)
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        # Existing jobs continue; admission waits for memory and current chat.
        # The lock is independent of UI and never blocks a foreground worker.
        if foreground_busy(roots) or memory_available() < 384 * 1024 * 1024:
            yield None
        else:
            yield stream


def write_status(directory, **changes):
    path = directory / 'status.json'
    value = json.loads(path.read_text())
    temporary = path.with_name('status.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps({**value, **changes, 'updatedAt': int(time.time() * 1000)}, ensure_ascii=False))
    temporary.chmod(0o600); temporary.replace(path)


def run_job(directory, command):
    directory = Path(directory)
    while True:
        if (directory / 'stop').exists():
            write_status(directory, state='stopped', phase='后台任务在等待资源时已取消')
            return 0
        with background_slot() as slot:
            if slot is not None:
                # Keep the lock across the worker. systemd KillMode=control-group
                # terminates both wrapper and child if the unit is stopped.
                return subprocess.call(command, pass_fds=(slot.fileno(),))
        write_status(directory, state='pending', phase='等待后台资源；优先处理当前聊天')
        time.sleep(2)


if __name__ == '__main__':
    if len(sys.argv) < 4 or sys.argv[2] != '--': raise SystemExit('usage: background_budget.py JOB_DIRECTORY -- COMMAND...')
    raise SystemExit(run_job(sys.argv[1], sys.argv[3:]))
