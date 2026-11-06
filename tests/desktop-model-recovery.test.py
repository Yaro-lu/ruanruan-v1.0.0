"""Model recovery contract tests: only mocked subprocesses, no API or GUI."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
spec = importlib.util.spec_from_file_location('model_recovery', Path(__file__).resolve().parents[1] / 'desktop/model_recovery.py')
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


class ModelRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.screen = Path(self.folder.name) / 'original.png'
        self.screen.write_bytes(b'saved screenshot fixture')
        self.geometry = {'X': 72, 'Y': 64, 'WIDTH': 880, 'HEIGHT': 640}
        self.region = {'id': 'mention_candidates', 'x': 132, 'y': 144, 'width': 820, 'height': 420}
        self.delivery = {'id': 'delivery', 'leaseId': 'lease', 'uiLabel': '目标群', 'status': 'ready',
                         'kind':'text', 'text':'已审核的正文', 'mention': {'username': 'stable-user', 'name': '小J'}}
        self.settings = {'uiLabel': '目标群', 'kind':'group', 'members': [{'username': 'stable-user', 'name': '小J', 'mentionNames': ['小J', '旧昵称']}]}

    def response(self, **changes):
        return {'ok': True, 'decision': 'locate', 'screen': 'chat', 'targetMatches': True,
                'point': {'regionId': 'mention_candidates', 'x': 400, 'y': 540},
                'observedText': '小J', 'reason': '完整名字的唯一候选', 'elapsedMs': 100,
                'model':'gpt-6.1-sol', 'provider':'configured-api', **changes}

    def bridge(self, _action, _args):
        return {'delivery': {**self.delivery, 'leaseUntil': 999999}}

    @staticmethod
    def process(value):
        return types.SimpleNamespace(returncode=0, stdout=json.dumps(value).encode(), stderr=b'')

    def analyze(self, instance=None, **options):
        return (instance or recovery.ModelRecovery()).analyze('mention', self.screen, 'OCR mismatch',
            self.settings, self.geometry, self.delivery, [self.region], **options)

    def test_private_snapshot_environment_active_lease_and_cleanup(self):
        snapshots = []
        def subprocess_call(command, **options):
            data = json.loads(options['input']);snapshot = Path(data['screenshotPath']);snapshots.append(snapshot)
            self.assertNotEqual(snapshot, self.screen)
            self.assertEqual(snapshot.read_bytes(), self.screen.read_bytes())
            self.assertEqual(snapshot.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            self.assertEqual(data['geometry'], {'x': 72, 'y': 64, 'width': 880, 'height': 640})
            self.assertEqual(data['target']['mention']['aliases'], ['小J', '旧昵称'])
            self.assertEqual(data['target']['kind'], 'group')
            self.assertEqual(data['delivery'], {'kind':'text','text':'已审核的正文','sendAttempted':False})
            self.assertEqual(command, ['node', str(recovery.PROJECT / 'dist-desktop/src/desktop/recovery-cli.js')])
            self.assertEqual(options['timeout'], 125)
            self.assertEqual(options['env']['WCB_CODEX_EPHEMERAL'], '1')
            self.assertEqual(options['env']['WCB_DATA_DIR'], str(recovery.DATA / 'app'))
            self.assertEqual(options['env']['WCB_CODEX_RUNTIME_SOCKET'], str(recovery.DATA / 'app/codex-runtime.sock'))
            self.assertEqual(options['env']['HTTP_PROXY'], 'existing-model-proxy')
            return self.process(self.response())
        with patch.dict(os.environ, {'HTTP_PROXY': 'existing-model-proxy'}),\
             patch.object(recovery, 'bridge_call', side_effect=self.bridge) as bridge,\
             patch.object(recovery.subprocess, 'run', side_effect=subprocess_call):
            self.assertEqual(self.analyze()['point']['x'], 400)
        self.assertEqual([call.args[0] for call in bridge.call_args_list], ['extend-delivery', 'active-delivery', 'active-delivery'])
        self.assertEqual(self.delivery['leaseUntil'], 999999)
        self.assertTrue(all(not path.parent.exists() for path in snapshots))
        self.assertEqual(self.screen.read_bytes(), b'saved screenshot fixture')

    def test_budget_is_shared_across_calls_and_timeout_also_consumes_one(self):
        planner = recovery.ModelRecovery(max_calls=2);snapshots = []
        def timeout(command, **options):
            snapshots.append(Path(json.loads(options['input'])['screenshotPath']))
            raise subprocess.TimeoutExpired(command, 125)
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge),\
             patch.object(recovery.subprocess, 'run', side_effect=timeout) as process:
            self.assertIsNone(self.analyze(planner));self.assertEqual(planner.last_error, 'planner_timeout')
            self.assertIsNone(self.analyze(planner))
            self.assertIsNone(self.analyze(planner));self.assertEqual(planner.last_error, 'call_budget_exhausted')
        self.assertEqual(process.call_count, 2)
        self.assertTrue(all(not path.parent.exists() for path in snapshots))

    def test_expired_or_changed_delivery_cannot_locate(self):
        with patch.object(recovery, 'bridge_call', side_effect=RuntimeError('lease expired')),\
             patch.object(recovery.subprocess, 'run') as process:
            self.assertIsNone(self.analyze());process.assert_not_called()
        for active in ({**self.delivery, 'id': 'different'}, {**self.delivery, 'status': 'sent'}):
            with self.subTest(active=active),patch.object(recovery, 'bridge_call', side_effect=[self.bridge(None,None), self.bridge(None,None), {'delivery':active}]),\
                 patch.object(recovery.subprocess, 'run', return_value=self.process(self.response())):
                self.assertIsNone(self.analyze())

    def test_default_budget_allows_four_calls_but_never_a_fifth(self):
        planner=recovery.ModelRecovery(max_calls=99)
        with patch.object(recovery,'bridge_call',side_effect=self.bridge),\
             patch.object(recovery.subprocess,'run',return_value=self.process(self.response())) as process:
            for _ in range(4):self.assertIsNotNone(self.analyze(planner))
            self.assertIsNone(self.analyze(planner))
            self.assertEqual(planner.last_error,'call_budget_exhausted')
            self.assertEqual(process.call_count,4)

    def test_truncated_native_candidate_still_requires_same_target_prefix_and_allowed_coordinates(self):
        self.delivery['mention']['name']='漫步者-飞利浦-联想-惠普影音-徐'
        self.settings['members'][0]['name']=self.delivery['mention']['name']
        self.settings['members'][0]['mentionNames']=[]
        with patch.object(recovery,'bridge_call',side_effect=self.bridge):
            for label,accepted in [('漫步者-飞利浦-联...',True),('另一个人...',False),('漫步者-飞利浦-联',False)]:
                with self.subTest(label=label),patch.object(recovery.subprocess,'run',return_value=self.process(self.response(observedText=label))):
                    result=self.analyze()
                    self.assertEqual(result is not None,accepted)

    def test_local_schema_rejects_bad_coordinates_actions_and_injected_fields(self):
        invalid = [
            self.response(point={'regionId':'mention_candidates','x':True,'y':540}),
            self.response(point={'regionId':'mention_candidates','x':400,'y':564}),
            self.response(point={'regionId':'other','x':400,'y':540}),
            self.response(point={'regionId':'mention_candidates','x':float('nan'),'y':540}),
            self.response(decision='retry'), self.response(targetMatches=False),
            self.response(screen='security'), self.response(extra='execute shell'),
            self.response(observedText='另一人'), self.response(model={'command':'ignored'}),
            self.response(usage={'inputTokens':-1}),self.response(usage={'command':'click'}),
        ]
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge):
            for value in invalid:
                with self.subTest(value=value),patch.object(recovery.subprocess, 'run', return_value=self.process(value)):
                    self.assertIsNone(self.analyze())

    def test_usage_facts_survive_the_python_boundary(self):
        value=self.response(usage={'inputTokens':100,'cachedInputTokens':60,'outputTokens':10},usageId='12345678-1234-1234-1234-123456789abc')
        with patch.object(recovery,'bridge_call',side_effect=self.bridge),patch.object(recovery.subprocess,'run',return_value=self.process(value)):
            result=self.analyze()
        self.assertEqual(result['usage'],value['usage'])

    def test_no_lease_allows_inspection_but_never_coordinates(self):
        stop = self.response(decision='stop', screen='security', point=None, targetMatches=False)
        with patch.object(recovery, 'bridge_call') as bridge,patch.object(recovery.subprocess, 'run', return_value=self.process(stop)) as process:
            result = recovery.ModelRecovery().analyze('inspect', self.screen, 'unknown dialog', self.settings, self.geometry)
            self.assertEqual(result['screen'], 'security')
            self.assertEqual(json.loads(process.call_args.kwargs['input'])['allowedRegions'], [])
            bridge.assert_not_called()
        with patch.object(recovery.subprocess, 'run') as process:
            self.assertIsNone(recovery.ModelRecovery().analyze('mention', self.screen, 'error', self.settings, self.geometry))
            process.assert_not_called()

    def test_attempted_send_becomes_receipt_only_and_cannot_return_a_point(self):
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge),\
             patch.object(recovery.subprocess, 'run', return_value=self.process(self.response())) as process:
            self.assertIsNone(self.analyze(attempted=True))
            data = json.loads(process.call_args.kwargs['input'])
            self.assertEqual(data['stage'], 'receipt');self.assertEqual(data['allowedRegions'], [])
            self.assertTrue(data['delivery']['sendAttempted'])

    def test_inspect_can_only_locate_send_button_and_error_output_is_data(self):
        region = {**self.region, 'id':'send_button'}
        valid = self.response(point={'regionId':'send_button','x':400,'y':540}, observedText='目标群(27)')
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge),\
             patch.object(recovery.subprocess, 'run', return_value=self.process(valid)):
            result = recovery.ModelRecovery().analyze('inspect',self.screen,'button OCR failed',self.settings,self.geometry,self.delivery,[region])
            self.assertEqual(result['point']['regionId'], 'send_button')
        error = {'ok':False,'error':{'code':'MODEL_UNAVAILABLE','message':'temporarily unavailable'},'elapsedMs':10}
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge),\
             patch.object(recovery.subprocess, 'run', return_value=self.process(error)):
            self.assertEqual(self.analyze(), error)

    def test_read_only_retry_accepts_another_visible_chat_without_authorizing_location(self):
        value = self.response(decision='retry', point=None, targetMatches=False, observedText='当前另一个群(4)')
        with patch.object(recovery, 'bridge_call', side_effect=self.bridge):
            for stage in ('recover', 'receipt', 'conversation', 'mention', 'inspect'):
                with self.subTest(stage=stage),patch.object(recovery.subprocess, 'run', return_value=self.process(value)):
                    result = recovery.ModelRecovery().analyze(stage,self.screen,'read-only retry',self.settings,
                        self.geometry,self.delivery,[self.region])
                    if stage in ('recover', 'receipt'):self.assertEqual(result, value)
                    else:self.assertIsNone(result)
            for stage in ('recover', 'receipt'):
                with self.subTest(stage=stage),patch.object(recovery.subprocess, 'run', return_value=self.process(self.response())):
                    self.assertIsNone(recovery.ModelRecovery().analyze(stage,self.screen,'no second send',self.settings,
                        self.geometry,self.delivery,[self.region]))


if __name__ == '__main__':unittest.main()
