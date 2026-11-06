"""Offline visual recovery integration: synthetic PNGs, mocked model and transport."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import MagicMock, patch

_root = tempfile.TemporaryDirectory(prefix='desktop-model-integration-')
unittest.addModuleCleanup(_root.cleanup)
os.environ['WCB_DATA_DIR'] = str(Path(_root.name) / 'app')
os.environ['WCB_DESKTOP_DATA'] = _root.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'desktop'))
spec = importlib.util.spec_from_file_location('model_integration_driver',
    Path(__file__).resolve().parents[1] / 'desktop/database_operator.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)

# GUI fixtures do not use the host recovery journal; durable crash behavior is
# exercised with real temporary files in desktop-transport-recovery.test.py.
def setUpModule():
    for name in ('record_prepared','record_attempted','record_done'):
        fixture=patch.object(driver,name)
        fixture.start();unittest.addModuleCleanup(fixture.stop)


PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=')


class ModelIntegrationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(dir=_root.name)
        self.addCleanup(folder.cleanup)
        self.directory = Path(folder.name)
        self.screen = self.directory / 'screen.png'
        self.screen.write_bytes(PNG)
        config = self.directory / 'bridge.json'
        config.write_text(json.dumps({'contacts': []}))
        self.settings = {'uiLabel': '钓友群', 'kind': 'group', 'modelRecovery': {'enabled': True}}
        self.delivery = {'id': 'delivery', 'leaseId': 'lease', 'kind': 'text', 'text': '你好呀'}
        self.geometry = {'X': 0, 'Y': 0, 'WIDTH': 1000, 'HEIGHT': 800}
        self.send_point = (950, 775)
        self.mention_point = (400, 350)
        self.current = {'screen': str(self.screen), 'geometry': self.geometry,
            'ownerVisible': True, 'sendButtons': [self.send_point], 'capturedAt': time.monotonic(),
            'fullInspection': True, 'timing': {}}
        self.proof = {'serverId': 'confirmed-server-id', 'text': '你好呀', 'conversationUsername': 'fixture@chatroom'}
        self.member = {'username': 'target-member', 'name': '小J'}
        self.roster = [self.member, {'username': 'other-member', 'name': '小潘'}]
        self.mention = None
        self.chip = '@小J\u2005'
        self.editor = ''
        self.trace = []
        self.verify_count = 0
        self.verify_error_once = False
        self.ocr_error = False
        self.green = True
        self.model = MagicMock()
        self.model.analyze.side_effect = self.analyze
        self.reader = MagicMock()
        self.reader.call.side_effect = self.read
        self.factory = self.mock('ModelRecovery', return_value=self.model)
        self.mock('EXCHANGE', self.directory)
        self.mock('STATE', self.directory / 'state')
        self.mock('BRIDGE_CONFIG', config)
        self.mock('window_geometry', return_value=self.geometry)
        self.mock('capture_screen', side_effect=lambda *_: (str(self.screen), time.monotonic()))
        self.view = self.mock('view', return_value=self.current)
        self.control = self.mock('control', side_effect=self.act)
        self.bridge = self.mock('bridge_call', side_effect=self.transport)
        self.mock('run', side_effect=AssertionError('Unexpected real desktop command'))
        sleeper = patch.object(driver.time, 'sleep')
        sleeper.start(); self.addCleanup(sleeper.stop)
        for name in ('Popen', 'run'):
            guard = patch.object(driver.subprocess, name, side_effect=AssertionError('Unexpected process/model launch'))
            guard.start(); self.addCleanup(guard.stop)
        self.addCleanup(lambda: self.assertIsNone(driver.RECOVERY.get()))

    def mock(self, name, *args, **kwargs):
        setting = patch.object(driver, name, *args, **kwargs)
        result = setting.start(); self.addCleanup(setting.stop)
        return result

    def analyze(self, stage, screen, error, settings, geometry, **kwargs):
        self.trace.append(('model', stage, kwargs.get('attempted')))
        result = {'decision': 'retry', 'screen': 'chat', 'targetMatches': True,
            'observedText': self.settings['uiLabel'], 'point': None, 'reason': '离线识别结果'}
        if stage == 'mention':
            result.update(decision='locate', observedText='小J',
                point={'regionId': 'mention_candidates', 'x': self.mention_point[0], 'y': self.mention_point[1]})
        elif stage == 'inspect':
            result.update(decision='locate', observedText='钓友群（24）',
                point={'regionId': 'send_button', 'x': self.send_point[0], 'y': self.send_point[1]})
        return result

    def read(self, method, args=None, **_kwargs):
        self.trace.append(('reader', method))
        if method == 'blank':
            return {'blank': True}
        if method == 'prepare':
            return {'mention': self.mention, 'mentionNames': ['小J'] if self.mention else [],
                'mentionMembers': self.roster}
        if method == 'ocr':
            if self.ocr_error:
                raise RuntimeError('OCR worker RPC failed')
            return {'items': []}
        if method == 'green':
            return {'enabled': self.green}
        if method == 'verify':
            self.verify_count += 1
            if self.verify_error_once and self.verify_count == 1:
                raise RuntimeError('Transient database acknowledgement failure')
            return {'database': self.proof}
        raise AssertionError('Unexpected reader call: ' + method)

    def act(self, action, args):
        self.trace.append(('ui', action, dict(args)))
        if action == 'screenshot':
            return {'screenshot': str(self.screen)}
        if action == 'click' and (args['x'], args['y']) == self.mention_point:
            self.editor = self.chip
        elif action == 'key' and args['key'] == 'at':
            self.editor += '@'
        elif action == 'paste_text':
            self.editor += args['text']
        elif action == 'append_composer':
            self.editor += args['text']
            return {'text': self.editor}
        elif action == 'read_composer':
            return {'text': self.editor}
        elif action == 'clear_composer':
            cleared = self.editor in args['expected']
            if cleared:
                self.editor = ''
            return {'cleared': cleared}
        return {}

    def transport(self, action, args):
        self.trace.append(('bridge', action, dict(args)))
        return {'delivery': dict(self.delivery)} if action == 'extend-delivery' else {}

    def send_clicks(self):
        return [call for call in self.control.call_args_list if call.args[0] == 'click'
            and (call.args[1]['x'], call.args[1]['y']) == self.send_point]

    def receipts(self):
        return [call.args[1] for call in self.bridge.call_args_list if call.args[0] == 'receipt']

    def test_enabled_recovery_keeps_normal_delivery_model_free_and_uses_database_proof(self):
        self.assertTrue(driver.deliver(self.reader, self.settings, self.delivery))
        self.model.analyze.assert_not_called()
        self.assertEqual(len(self.send_clicks()), 1)
        self.assertEqual(self.receipts(), [{'id': 'delivery', 'leaseId': 'lease', 'status': 'sent',
            'uiLabel': '钓友群', 'database': self.proof}])
        self.assertEqual(list((self.directory / 'state').glob('**/*')), [])

    def test_missing_mention_ocr_uses_model_coordinates_and_checks_full_chip_before_body(self):
        for rpc_error in (False, True):
            with self.subTest(ocr='rpc_error' if rpc_error else 'empty_items'):
                self.ocr_error = rpc_error
                self.editor = ''
                self.model.reset_mock(); self.control.reset_mock(); self.bridge.reset_mock()
                self.mention = self.member
                self.delivery['mention'] = self.member
                self.settings['members'] = [{'username': 'stale-member', 'name': '过期名单'}]
                self.assertTrue(driver.deliver(self.reader, self.settings, self.delivery))
                self.assertEqual(self.model.analyze.call_count, 1)
                call = self.model.analyze.call_args
                self.assertEqual(call.args[0], 'mention')
                self.assertFalse(call.kwargs['attempted'])
                self.assertEqual(call.kwargs['allowed_regions'][0]['id'], 'mention_candidates')
                self.assertEqual(call.args[3]['members'], self.roster,
                    'model context must use the current prepare.mentionMembers roster')
                actions = [call.args[0] for call in self.control.call_args_list]
                self.assertLess(actions.index('read_composer'), actions.index('append_composer'))
                self.assertEqual(self.editor, '@小J\u2005你好呀')
                self.assertEqual(len(self.send_clicks()), 1)
                self.assertEqual(self.receipts()[-1]['database'], self.proof)

    def test_model_located_wrong_chip_never_receives_reply_body_or_send_click(self):
        for rpc_error in (False, True):
            with self.subTest(ocr='rpc_error' if rpc_error else 'empty_items'):
                self.ocr_error = rpc_error
                self.editor = ''
                self.model.reset_mock(); self.control.reset_mock(); self.bridge.reset_mock()
                self.mention = self.member
                self.delivery['mention'] = self.member
                self.chip = '@小潘\u2005'
                with patch.object(driver, 'review_failure', return_value=None):
                    self.assertFalse(driver.deliver(self.reader, self.settings, self.delivery))
                self.assertEqual(self.model.analyze.call_count, 1)
                self.assertTrue(any(call.args[0] == 'read_composer' for call in self.control.call_args_list))
                self.assertFalse(any(call.args[0] == 'append_composer' for call in self.control.call_args_list))
                self.assertEqual(self.send_clicks(), [])
                self.assertEqual(self.receipts()[-1]['status'], 'rejected')

    def test_visual_security_or_logout_escalates_without_ui_actions(self):
        for screen, kind in [('security', 'security'), ('logged_out', 'logout')]:
            with self.subTest(screen=screen):
                self.control.reset_mock(); self.bridge.reset_mock(); self.model.reset_mock()
                self.model.analyze.side_effect = lambda *_args, **_kwargs: {
                    'decision': 'stop', 'screen': screen, 'targetMatches': False, 'point': None,
                    'observedText': '', 'reason': '手机安全核验'}
                self.view.side_effect = RuntimeError('Local OCR unavailable')
                with self.assertRaises(driver.DesktopSecurityError) as caught:
                    driver.deliver(self.reader, self.settings, self.delivery)
                self.assertEqual(caught.exception.kind, kind)
                self.assertEqual(caught.exception.screenshot, str(self.screen))
                self.assertEqual(self.model.analyze.call_count, 1)
                self.control.assert_not_called()
                self.assertEqual(self.receipts()[-1]['status'], 'rejected')

    def test_after_send_recovery_only_rechecks_database_receipt_and_does_not_send_again(self):
        self.verify_error_once = True
        self.assertTrue(driver.deliver(self.reader, self.settings, self.delivery))
        self.assertEqual(self.verify_count, 2)
        self.model.analyze.assert_not_called()
        self.assertEqual(len(self.send_clicks()), 1)
        self.assertEqual(sum(call.args[0] == 'append_composer' for call in self.control.call_args_list), 1)
        self.assertEqual(self.receipts()[-1]['database'], self.proof)

    def test_invalid_locator_retries_same_stage_with_feedback_and_keeps_second_round_available(self):
        self.mention=self.member;self.delivery['mention']=self.member
        invalid={'ok':False,'error':{'code':'invalid_output','message':'Observed target differs from the verified address book'},'elapsedMs':1}
        calls=[]
        def analyze(*args,**kwargs):
            calls.append(args)
            return invalid if len(calls)<=2 else self.analyze(*args,**kwargs)
        self.model.analyze.side_effect=analyze
        self.assertTrue(driver.deliver(self.reader,self.settings,self.delivery))
        self.assertEqual([call[0] for call in calls],['mention','mention','mention'])
        self.assertIn('Observed target differs',calls[1][2])
        self.assertEqual(len(self.send_clicks()),1)
        self.assertEqual(self.receipts()[-1]['status'],'sent')

    def test_four_failed_targeted_calls_stop_and_quota_failure_is_not_retried(self):
        self.mention=self.member;self.delivery['mention']=self.member
        for code,expected in [('invalid_output',4),('quota_exhausted',1)]:
            with self.subTest(code=code):
                self.editor='';self.model.reset_mock();self.control.reset_mock();self.bridge.reset_mock()
                self.model.analyze.side_effect=lambda *args,**kwargs:{'ok':False,'error':{'code':code,'message':'fixture failure'},'elapsedMs':1}
                self.assertFalse(driver.deliver(self.reader,self.settings,self.delivery))
                self.assertEqual(self.model.analyze.call_count,expected)
                self.assertEqual(self.send_clicks(),[])
                self.assertEqual(self.receipts()[-1]['status'],'rejected')

    def test_fourth_locator_can_succeed_and_ellipsized_name_is_verified_before_body(self):
        self.mention=self.member;self.delivery['mention']=self.member
        calls=[]
        def analyze(*args,**kwargs):
            calls.append(args)
            if len(calls)<4:return {'ok':False,'error':{'code':'invalid_output','message':'invalid coordinates'},'elapsedMs':1}
            return {**self.analyze(*args,**kwargs),'observedText':'小...'}
        self.model.analyze.side_effect=analyze
        self.assertTrue(driver.deliver(self.reader,self.settings,self.delivery))
        self.assertEqual([call[0] for call in calls],['mention']*4)
        self.assertEqual(len(self.send_clicks()),1)
        actions=[call.args[0] for call in self.control.call_args_list]
        self.assertLess(actions.index('read_composer'),actions.index('append_composer'))

    def test_model_recovers_missing_title_and_send_point_but_green_and_receipt_are_still_required(self):
        self.view.side_effect = [self.current, RuntimeError('OCR inspection failed')]
        self.assertTrue(driver.deliver(self.reader, self.settings, self.delivery))
        self.assertEqual(self.model.analyze.call_count, 1)
        self.assertEqual(self.model.analyze.call_args.args[0], 'inspect')
        self.assertEqual(self.model.analyze.call_args.kwargs['allowed_regions'][0]['id'], 'send_button')
        self.assertEqual(len(self.send_clicks()), 1)
        green = next(i for i, row in enumerate(self.trace) if row[:2] == ('reader', 'green'))
        sent = next(i for i, row in enumerate(self.trace) if row[:2] == ('ui', 'click')
            and (row[2]['x'], row[2]['y']) == self.send_point)
        verify = next(i for i, row in enumerate(self.trace) if row[:2] == ('reader', 'verify'))
        self.assertLess(green, sent); self.assertLess(sent, verify)
        self.assertEqual(self.receipts()[-1]['database'], self.proof)

    def test_model_coordinates_do_not_override_disabled_send_button(self):
        self.green = False
        self.view.side_effect = [self.current, RuntimeError('OCR inspection failed')]
        with patch.object(driver, 'review_failure', return_value=None):
            self.assertFalse(driver.deliver(self.reader, self.settings, self.delivery))
        self.assertEqual(self.model.analyze.call_count, 1)
        self.assertEqual(self.send_clicks(), [])
        self.assertEqual(self.verify_count, 0)
        self.assertEqual(self.receipts()[-1]['status'], 'rejected')


if __name__ == '__main__':
    unittest.main()
