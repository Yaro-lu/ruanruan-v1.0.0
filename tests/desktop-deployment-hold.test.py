"""Offline deployment hold checks; temporary files and mocked PID probes only."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
spec = importlib.util.spec_from_file_location('deployment_hold_tested', Path(__file__).resolve().parents[1] / 'desktop/deployment_hold.py')
hold = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hold)


class DeploymentHoldTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / 'deploy-hold.json'

    def write(self, value):
        self.path.write_text(json.dumps(value))

    def test_live_holder_with_future_deadline_holds(self):
        self.write({'pid': 123, 'until': 1000001})
        with patch.object(hold.time, 'time', return_value=1000), patch.object(hold.os, 'kill') as probe:
            self.assertTrue(hold.deployment_held(self.path))
            probe.assert_called_once_with(123, 0)

    def test_dead_holder_releases_and_permission_error_still_means_holder_exists(self):
        self.write({'pid': 123, 'until': 1000001})
        with patch.object(hold.time, 'time', return_value=1000):
            with patch.object(hold.os, 'kill', side_effect=ProcessLookupError):
                self.assertFalse(hold.deployment_held(self.path))
            with patch.object(hold.os, 'kill', side_effect=PermissionError):
                self.assertTrue(hold.deployment_held(self.path))
            with patch.object(hold.os, 'kill', side_effect=OverflowError):
                self.assertFalse(hold.deployment_held(self.path))

    def test_invalid_or_expired_holds_do_not_probe_a_process(self):
        values = [None, [], {}, True, 'invalid', {'pid': 0, 'until': 1000001},
                  {'pid': -1, 'until': 1000001}, {'pid': 1.5, 'until': 1000001},
                  {'pid': '123', 'until': 1000001}, {'pid': True, 'until': 1000001},
                  {'pid': 123, 'until': 1000000}, {'pid': 123, 'until': '1000001'},
                  {'pid': 123, 'until': float('nan')}, {'pid': 123, 'until': float('inf')}]
        with patch.object(hold.time, 'time', return_value=1000), patch.object(hold.os, 'kill') as probe:
            for value in values:
                with self.subTest(value=value):
                    self.write(value)
                    self.assertFalse(hold.deployment_held(self.path))
            probe.assert_not_called()

    def test_missing_or_malformed_file_releases(self):
        with patch.object(hold.os, 'kill') as probe:
            self.assertFalse(hold.deployment_held(self.path))
            self.path.write_text('{')
            self.assertFalse(hold.deployment_held(self.path))
            probe.assert_not_called()


if __name__ == '__main__':
    unittest.main()
