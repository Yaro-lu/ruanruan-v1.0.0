"""Offline scheduling and cancellation checks; no model or service is started."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
import background_budget as budget


class BudgetTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name); self.app = self.root / 'app'
        self.directory = self.app / 'jobs/job'; self.directory.mkdir(parents=True)
        self.put('status.json', {'state': 'pending', 'updatedAt': 1000})
        self.put('job.json', {'kind': 'life'})
        paths = patch.object(budget, 'budget_paths', return_value=(self.root / 'budget.lock', [self.app]))
        memory = patch.object(budget, 'memory_available', return_value=600 * 1024 * 1024)
        paths.start(); memory.start(); self.addCleanup(paths.stop); self.addCleanup(memory.stop)

    def put(self, name, value): (self.directory / name).write_text(json.dumps(value))

    def test_only_one_background_holder_and_release_after_error(self):
        with self.assertRaises(RuntimeError):
            with budget.background_slot() as first:
                self.assertIsNotNone(first)
                with budget.background_slot() as second: self.assertIsNone(second)
                raise RuntimeError('worker error')
        with budget.background_slot() as next_slot: self.assertIsNotNone(next_slot)

    def test_low_memory_and_active_foreground_defer_but_old_failed_job_does_not(self):
        with patch.object(budget, 'memory_available', return_value=100 * 1024 * 1024):
            with budget.background_slot() as slot: self.assertIsNone(slot)
        self.put('job.json', {'kind': 'codex'})
        self.put('status.json', {'state': 'running', 'updatedAt': int(budget.time.time() * 1000)})
        with budget.background_slot() as slot: self.assertIsNone(slot)
        self.put('status.json', {'state': 'running', 'updatedAt': 1000})
        with budget.background_slot() as slot: self.assertIsNotNone(slot)

    def test_pending_stop_is_consumed_without_launching_worker(self):
        (self.directory / 'stop').touch()
        with patch.object(budget.subprocess, 'call') as child:
            self.assertEqual(budget.run_job(self.directory, ['never-start']), 0)
            child.assert_not_called()
        self.assertEqual(json.loads((self.directory / 'status.json').read_text())['state'], 'stopped')

    def test_child_runs_under_shared_lock_and_propagates_return_code(self):
        def child(_command, **options):
            self.assertEqual(len(options['pass_fds']), 1)
            with budget.background_slot() as slot: self.assertIsNone(slot)
            return 7
        with patch.object(budget.subprocess, 'call', side_effect=child):
            self.assertEqual(budget.run_job(self.directory, ['offline-fixture']), 7)


if __name__ == '__main__': unittest.main()
