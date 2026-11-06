"""Synthetic repair snapshots/deployment; systemctl, Docker and models are mocked."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('repair_workspace', Path(__file__).resolve().parents[1] / 'desktop/repair_workspace.py')
repair = importlib.util.module_from_spec(spec); spec.loader.exec_module(repair)


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix='repair-workspace-test-'); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name); self.project = self.root / 'project'; self.data = self.root / 'data'
        self.incident = self.data / 'auto-repair/incidents/example'
        self.put(self.project / 'desktop/demo.py', 'VALUE = "current uncommitted code"\n')
        self.put(self.project / 'tests/demo.test.py', 'from pathlib import Path\n# desktop/demo.py\nassert True\n')
        self.put(self.project / 'src/demo.ts', 'export const value = 1;\n')
        self.put(self.project / 'package.json', '{"type":"module"}')
        self.put(self.project / 'tsconfig.json', '{}')
        self.put(self.project / 'node_modules/fixture/index.js', 'readonly dependency')
        self.put(self.project / 'third_party/knowledge/readme.md', 'small offline reference')
        self.put(self.project / 'plugins/fishing/SKILL.md', 'bundled runtime voice rules')
        self.put(self.project / '.git/config', 'do not copy')
        self.put(self.project / '.env', 'SECRET=do-not-copy')
        self.put(self.project / 'dist-desktop/src/demo.js', 'export const value = 0;')
        self.put(self.project / 'desktop/repair_worker.py', 'host_owned = True')
        self.put(self.data / 'app/message-queue.json', '[]')
        self.put(self.data / 'bridge.json', json.dumps({'queueDirectory': str(self.data / 'bridge')}))
        self.channel = self.data / 'bridge/channel.sqlite3'; self.channel.parent.mkdir(parents=True)
        with sqlite3.connect(self.channel) as db:
            db.executescript('CREATE TABLE channel_pause(account TEXT); CREATE TABLE ui_lease(id TEXT); '
                'CREATE TABLE incoming(status TEXT); CREATE TABLE outgoing(status TEXT);')
        self.workspace = repair.create_workspace(self.incident, project=self.project, data=self.data)
        self.copy = Path(self.workspace['path'])
        self.commands = []
        self.runner = patch.object(repair, '_run', side_effect=self.run_command)
        self.runner.start(); self.addCleanup(self.runner.stop)

    @staticmethod
    def put(path, text):
        path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text)

    def run_command(self, command, **_kwargs):
        self.commands.append(command)
        if command[0] == 'bwrap' and 'node_modules/typescript/bin/tsc' in command:
            self.put(self.copy / '.repair-build/src/demo.js', 'export const value = 2;')
        if command[:3] == ['systemctl', '--user', 'show']:
            return 'ActiveState=active\nSubState=running\nMainPID=12345\n'
        if command[0] == 'journalctl': return '独立读库收件与界面发送已就绪\n'
        if command[:3] == ['docker', 'image', 'inspect']: return 'sha256:' + 'a' * 64
        return ''

    def change_python(self):
        self.put(self.copy / 'desktop/demo.py', 'VALUE = "fixed"\n')
        result = repair.validate_workspace(self.workspace)
        self.assertTrue(result['ok'], result)
        self.assertIn('tests/demo.test.py', result['tests'])
        return result

    def test_snapshot_uses_working_tree_not_git_and_keeps_dependencies_outside_writable_tree(self):
        self.assertIn('current uncommitted', (self.copy / 'desktop/demo.py').read_text())
        self.assertFalse((self.copy / '.git').exists()); self.assertFalse((self.copy / '.env').exists())
        self.assertFalse((self.copy / 'dist-desktop').exists())
        self.assertTrue((self.copy / 'node_modules').is_symlink())
        self.assertEqual((self.copy / 'node_modules').resolve(), self.project / 'node_modules')
        self.assertTrue((self.copy / 'third_party/knowledge/readme.md').exists())
        self.put(self.copy / '.repair-validation/app/memory.json', '{"fake":true}')
        self.assertEqual(repair.validate_workspace(self.workspace)['status'], 'unchanged')

    def test_protected_self_modification_and_symlink_edits_fail_before_commands(self):
        self.put(self.copy / 'desktop/repair_worker.py', 'host_owned = False')
        result = repair.validate_workspace(self.workspace)
        self.assertFalse(result['ok']); self.assertIn('protected path', result['error'])
        self.assertEqual(self.commands, [])
        self.put(self.copy / 'desktop/repair_worker.py', 'host_owned = True')
        (self.copy / 'desktop/demo.py').unlink()
        (self.copy / 'desktop/demo.py').symlink_to(self.project / 'desktop/demo.py')
        self.assertFalse(repair.validate_workspace(self.workspace)['ok'])

    def test_plugin_runtime_material_is_available_but_cannot_be_changed_by_repair(self):
        # fishing.ts loads this file relative to emitted .repair-build/src.
        # Exercise that actual filesystem relationship without compiling TS.
        module = self.copy / '.repair-build/src/resource-check.js'
        self.put(module, "import {readFileSync} from 'node:fs';\n"
            "process.stdout.write(readFileSync(new URL('../../plugins/fishing/SKILL.md', import.meta.url), 'utf8'));\n")
        result = subprocess.run(['node', str(module)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'bundled runtime voice rules')
        self.assertEqual(repair.validate_workspace(self.workspace)['status'], 'unchanged')
        skill = self.copy / 'plugins/fishing/SKILL.md'
        for operation in ('edit', 'delete', 'add'):
            with self.subTest(operation=operation):
                self.put(skill, 'bundled runtime voice rules')
                if operation == 'edit': self.put(skill, 'altered rules')
                elif operation == 'delete': skill.unlink()
                else: self.put(self.copy / 'plugins/other/SKILL.md', 'new rules')
                validation = repair.validate_workspace(self.workspace)
                self.assertFalse(validation['ok'])
                self.assertIn('protected path', validation['error'])
                self.assertEqual(self.commands, [])

    def test_incident_evidence_is_copied_inside_workspace_and_covered_by_baseline(self):
        incident=self.data/'auto-repair/incidents/with-evidence'
        self.put(incident/'failure.png','failure fixture')
        self.put(incident/'before.png','before fixture')
        original={'stage':'mention','screenshot':str(incident/'failure.png'),
            'beforeScreenshot':str(incident/'before.png'),'observations':{'ocrItems':[{'text':'玲','score':.7}]}}
        self.put(incident/'incident.json',json.dumps({'evidence':original}))
        workspace=repair.create_workspace(incident,project=self.project,data=self.data)
        root=Path(workspace['path']);local=root/'.repair-evidence'
        snapshot=json.loads((local/'incident.json').read_text())
        self.assertEqual(snapshot['screenshot'],'.repair-evidence/failure.png')
        self.assertEqual(snapshot['beforeScreenshot'],'.repair-evidence/before.png')
        self.assertEqual(snapshot['observations'],original['observations'])
        self.assertEqual((root/snapshot['screenshot']).read_text(),'failure fixture')
        self.assertEqual(repair.validate_workspace(workspace)['status'],'unchanged')
        self.put(local/'failure.png','altered evidence')
        result=repair.validate_workspace(workspace)
        self.assertFalse(result['ok']);self.assertIn('protected path',result['error'])

    def test_validation_mounts_only_workspace_and_readonly_dependencies_with_no_network(self):
        self.change_python()
        sandboxes = [command for command in self.commands if command[0] == 'bwrap']
        self.assertEqual(len(sandboxes), 2)
        for command in sandboxes:
            self.assertIn('--unshare-net', command)
            self.assertIn('--unshare-pid', command)
            self.assertNotIn('/run', command)
            index = command.index(str(self.project / 'node_modules'))
            self.assertEqual(command[index - 1], '--ro-bind')

    def test_busy_safety_pause_active_job_and_pending_inputs_defer_without_restarts(self):
        self.change_python(); self.commands.clear()
        for table, value, reason in [('channel_pause', 'bot', 'security_paused'),
                ('outgoing', 'ready', 'outgoing_busy'), ('incoming', 'pending', 'incoming_queued')]:
            with self.subTest(table=table):
                with sqlite3.connect(self.channel) as db: db.execute('INSERT INTO ' + table + ' VALUES(?)', [value])
                result = repair.deploy_workspace(self.workspace)
                self.assertEqual(result, {'status': 'deferred', 'reason': reason})
                with sqlite3.connect(self.channel) as db: db.execute('DELETE FROM ' + table)
        self.put(self.data / 'app/jobs/job/status.json', '{"state":"running"}')
        self.assertEqual(repair.deploy_workspace(self.workspace)['reason'], 'business_job_running')
        self.assertEqual(self.commands, [])
        self.assertIn('current uncommitted', (self.project / 'desktop/demo.py').read_text())

    def test_old_pending_job_requires_actual_unit_state_and_active_background_wait_stays_busy(self):
        identifier='60a75cbd-3b9c-4756-a277-ed0b010a248e'
        path=self.data / 'app/jobs' / identifier / 'status.json'
        self.put(path, '{"state":"pending","updatedAt":1}')
        for response,expected in [('LoadState=not-found\nActiveState=inactive\n',None),
                ('LoadState=loaded\nActiveState=failed\n',None),
                ('LoadState=loaded\nActiveState=active\n','business_job_running'),
                ('','business_job_running')]:
            with self.subTest(response=response),patch.object(repair,'_run',return_value=response):
                self.assertEqual(repair._busy(self.workspace),expected)
        with patch.object(repair,'_run',side_effect=RuntimeError('D-Bus unavailable')):
            self.assertEqual(repair._busy(self.workspace),'business_job_running')
        self.put(path,json.dumps({'state':'pending','updatedAt':int(repair.time.time()*1000)}))
        with patch.object(repair,'_run') as inspect:
            self.assertEqual(repair._busy(self.workspace),'business_job_running');inspect.assert_not_called()

    def test_idle_deploy_rechecks_under_hold_then_keeps_new_queued_input_and_proves_new_pid_ready(self):
        self.change_python(); self.commands.clear()
        original = repair._busy
        def busy(workspace, *, held=False):
            if held:
                self.assertTrue((self.data / 'auto-repair/deploy-hold.json').exists())
                with sqlite3.connect(self.channel) as db:
                    if not db.execute('SELECT 1 FROM incoming').fetchone(): db.execute("INSERT INTO incoming VALUES('pending')")
            return original(workspace, held=held)
        with patch.object(repair, '_busy', side_effect=busy): result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(result['restarted'], [repair.DATABASE])
        self.assertEqual((self.project / 'desktop/demo.py').read_text(), 'VALUE = "fixed"\n')
        self.assertFalse((self.data / 'auto-repair/deploy-hold.json').exists())
        self.assertTrue(any(command[0] == 'journalctl' and '_PID=12345' in command for command in self.commands))
        with sqlite3.connect(self.channel) as db: self.assertEqual(db.execute('SELECT count(*) FROM incoming').fetchone()[0], 1)

    def test_cancel_and_concurrent_production_edit_never_overwrite_or_restart(self):
        self.change_python(); self.commands.clear()
        self.put(self.incident / 'incident.json', '{"cancelRequested":true}')
        self.assertEqual(repair.deploy_workspace(self.workspace)['status'], 'blocked')
        self.put(self.incident / 'incident.json', '{}')
        self.put(self.project / 'desktop/demo.py', 'VALUE = "new user edit"\n')
        result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'conflict')
        self.assertEqual((self.project / 'desktop/demo.py').read_text(), 'VALUE = "new user edit"\n')
        self.assertEqual(self.commands, [])

    def test_restart_readiness_failure_rolls_back_source_and_restarts_original(self):
        self.change_python(); before = (self.project / 'desktop/demo.py').read_text()
        with patch.object(repair, '_wait_ready', side_effect=[RuntimeError('new worker not ready'), None]):
            result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'failed'); self.assertTrue(result['rolledBack'])
        self.assertEqual((self.project / 'desktop/demo.py').read_text(), before)
        restarts = [command for command in self.commands if command[:3] == ['systemctl', '--user', 'restart']]
        self.assertEqual(restarts, [['systemctl', '--user', 'restart', repair.DATABASE]] * 2)

    def test_container_candidate_is_copy_only_and_reader_tests_run_without_production_mounts(self):
        self.put(self.project / 'desktop/db-worker/rpc.py', 'VALUE = 1')
        self.put(self.project / 'tests/reader.test.py', '# desktop/db-worker/rpc.py\nassert True')
        self.put(self.data / 'database.json', '{"readerImage":"local/reader:current"}')
        other = repair.create_workspace(self.data / 'auto-repair/incidents/container', project=self.project, data=self.data)
        self.put(Path(other['path']) / 'desktop/db-worker/rpc.py', 'VALUE = 2')
        result = repair.validate_workspace(other)
        self.assertTrue(result['ok'], result)
        dockerfile = (Path(other['incident']) / 'container-build/Dockerfile').read_text()
        base = dockerfile.splitlines()[0].removeprefix('FROM ')
        self.assertTrue(base.startswith('local/ruanruan-reader-base:'))
        self.assertEqual(dockerfile.splitlines()[1:], ['COPY rpc.py /opt/ruanruan-reader/rpc.py'])
        self.assertIn(['docker', 'tag', 'sha256:' + 'a' * 64, base], self.commands)
        self.assertIn(['docker', 'image', 'inspect', base, '--format', '{{.Id}}'], self.commands)
        self.assertIn(['docker', 'image', 'rm', base], self.commands)
        builds = [command for command in self.commands if command[:2] == ['docker', 'build']]
        self.assertIn('--pull=false', builds[0]); self.assertIn('--network=none', builds[0])
        runs = [command for command in self.commands if command[:2] == ['docker', 'run']]
        self.assertEqual(len(runs), 1)
        for flag in ['--network=none', '--read-only', '--cap-drop=ALL', '--memory=512m']: self.assertIn(flag, runs[0])
        self.assertNotIn('--pid', runs[0]); self.assertNotIn('/var/run/docker.sock', ' '.join(runs[0]))
        self.assertIn('dst=/repair,readonly', ' '.join(runs[0]))

    def test_typescript_deploy_protects_unchanged_imports_and_publishes_only_validated_build(self):
        self.put(self.copy / 'src/demo.ts', 'export const value = 2;\n')
        self.assertTrue(repair.validate_workspace(self.workspace)['ok'])
        result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(result['restarted'], [repair.BRIDGE, repair.DATABASE])
        self.assertEqual((self.project / 'dist-desktop/src/demo.js').read_text(), 'export const value = 2;')
        stops = [command for command in self.commands if command[:3] == ['systemctl', '--user', 'stop']]
        self.assertEqual(stops, [['systemctl', '--user', 'stop', repair.DATABASE], ['systemctl', '--user', 'stop', repair.BRIDGE]])
        previous = Path(result['previousRuntime'])
        self.assertEqual((previous / 'src/demo.js').read_text(), 'export const value = 0;')

    def test_missing_compiled_import_blocks_deployment_before_services_are_stopped(self):
        self.put(self.copy / 'src/demo.ts', 'export const value = 2;\n')
        with patch.object(repair, 'complete_runtime', wraps=repair.complete_runtime):
            self.put(self.copy / 'src/thread-continuity.ts', 'export const value = 1;')
            result = repair.validate_workspace(self.workspace)
        self.assertFalse(result['ok'])
        self.assertIn('thread-continuity.js', result['error'])
        self.assertFalse(any(command[0] == 'systemctl' for command in self.commands))

    def test_complete_runtime_rejects_missing_transitive_import(self):
        self.put(self.copy / '.repair-build/src/demo.js', "export {missing} from './thread-continuity.js';")
        with self.assertRaisesRegex(RuntimeError, 'Incomplete runtime import'):
            repair.complete_runtime(self.copy / 'src', self.copy / '.repair-build/src')

    def test_atomic_runtime_swap_and_rollback_restore_all_old_files_and_remove_new_files(self):
        self.put(self.project / 'dist-desktop/src/obsolete.js', 'old-only file')
        self.put(self.copy / 'src/demo.ts', 'export const value = 2;\n')
        self.assertTrue(repair.validate_workspace(self.workspace)['ok'])
        before = repair._inventory(self.project / 'dist-desktop')
        with patch.object(repair, '_wait_ready', side_effect=[RuntimeError('new worker not ready'), None]):
            result = repair.deploy_workspace(self.workspace)
        self.assertTrue(result['rolledBack'], result)
        self.assertEqual(repair._inventory(self.project / 'dist-desktop'), before)
        self.assertEqual((self.project / 'src/demo.ts').read_text(), 'export const value = 1;\n')

    def test_process_exit_after_swap_recovers_persisted_transaction_before_retry_or_cancellation(self):
        self.put(self.copy / 'src/demo.ts', 'export const value = 2;\n')
        self.assertTrue(repair.validate_workspace(self.workspace)['ok'])
        before = repair._inventory(self.project / 'dist-desktop')
        with patch.object(repair, '_wait_ready', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): repair.deploy_workspace(self.workspace)
        self.assertEqual((self.project / 'dist-desktop/src/demo.js').read_text(), 'export const value = 2;')
        self.put(self.incident / 'incident.json', '{"cancelRequested":true}')
        result = repair.deploy_workspace(self.workspace)
        self.assertTrue(result['rolledBack'], result)
        self.assertEqual(repair._inventory(self.project / 'dist-desktop'), before)
        self.assertEqual((self.project / 'src/demo.ts').read_text(), 'export const value = 1;\n')

    def test_compiled_artifact_changes_after_validation_are_not_published(self):
        self.put(self.copy / 'src/demo.ts', 'export const value = 2;\n')
        self.assertTrue(repair.validate_workspace(self.workspace)['ok'])
        self.put(self.copy / '.repair-build/src/demo.js', 'unvalidated output')
        self.commands.clear()
        result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['reason'], 'compiled_build_changed_after_validation')
        self.assertEqual(self.commands, [])
        self.assertEqual((self.project / 'dist-desktop/src/demo.js').read_text(), 'export const value = 0;')

    def test_full_build_checks_concurrent_unchanged_and_new_source_files(self):
        self.put(self.project / 'src/unchanged.ts', 'export const unchanged = 1;')
        # A newly created workspace must record every source file in its baseline.
        other = repair.create_workspace(self.data / 'auto-repair/incidents/parallel', project=self.project, data=self.data)
        root = Path(other['path']); self.put(root / 'src/demo.ts', 'export const value = 2;')
        old_copy = self.copy; self.copy = root
        def compile_all(workspace, command, **kwargs):
            if 'node_modules/typescript/bin/tsc' in command:
                self.put(root / '.repair-build/src/demo.js', 'export const value = 2;')
                self.put(root / '.repair-build/src/unchanged.js', 'export const unchanged = 1;')
        with patch.object(repair, '_sandbox', side_effect=compile_all): self.assertTrue(repair.validate_workspace(other)['ok'])
        for name, value in [('src/unchanged.ts', 'export const unchanged = 3;'), ('src/new.ts', 'export const value = 1;')]:
            with self.subTest(name=name):
                self.put(self.project / name, value)
                result = repair.deploy_workspace(other)
                self.assertEqual(result['status'], 'conflict'); self.assertIn(name, result['paths'])
                if name == 'src/unchanged.ts': self.put(self.project / name, 'export const unchanged = 1;')
                else: (self.project / name).unlink()
        self.copy = old_copy

    def test_committed_transaction_is_reported_after_worker_restart_without_redeploy(self):
        self.change_python()
        result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'applied')
        self.commands.clear()
        self.assertEqual(repair.deploy_workspace(self.workspace), result)
        self.assertEqual(self.commands, [])

    def test_host_invariant_tests_cannot_be_edited_and_always_run_when_present(self):
        self.put(self.project / 'tests/desktop-security.test.py', 'assert True\n')
        other = repair.create_workspace(self.data / 'auto-repair/incidents/host-tests', project=self.project, data=self.data)
        root = Path(other['path']); self.put(root / 'desktop/demo.py', 'VALUE = "fixed"')
        result = repair.validate_workspace(other)
        self.assertTrue(result['ok'], result)
        self.assertIn('tests/desktop-security.test.py', result['tests'])
        self.put(root / 'tests/desktop-security.test.py', 'assert False\n')
        self.assertIn('protected path', repair.validate_workspace(other)['error'])

    def test_runtime_json_change_rebuilds_and_publishes_dynamic_json_then_restarts(self):
        self.put(self.copy / 'src/lookup.json', '{"answer":42}')
        result = repair.validate_workspace(self.workspace)
        self.assertTrue(result['ok'], result)
        self.assertTrue(result['typescript'])
        self.assertTrue(any('node_modules/typescript/bin/tsc' in command for command in self.commands))
        result = repair.deploy_workspace(self.workspace)
        self.assertEqual(result['status'], 'applied')
        self.assertEqual(result['restarted'], [repair.BRIDGE, repair.DATABASE])
        self.assertEqual(json.loads((self.project / 'dist-desktop/src/lookup.json').read_text()), {'answer': 42})


if __name__ == '__main__': unittest.main()
