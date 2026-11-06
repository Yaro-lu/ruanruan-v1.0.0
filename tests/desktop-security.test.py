"""Offline account-dialog and notification routing tests; never contacts WeChat."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
import security_notify as notices
import database_operator as driver

class SecurityTests(unittest.TestCase):
    def setUp(self):
        root=tempfile.TemporaryDirectory();self.addCleanup(root.cleanup)
        self.config={'accountId':'control','outboxDirectory':root.name}

    def test_blocking_account_notices_are_detected_but_chat_mentions_are_not(self):
        geometry={'X':0,'Y':0,'WIDTH':1000,'HEIGHT':700}
        def item(text,y=250):return {'text':text,'score':.99,'box':[[300,y],[700,y],[700,y+30],[300,y+30]]}
        for reason in ('安全核验','账号涉嫌违规，已被限制','请填写验证码','客服申请','账号申诉','为了你的账号安全'):
            self.assertEqual(notices.detect_notice([item(reason),item('确定',420)],geometry)['kind'],'security')
            self.assertIsNone(notices.detect_notice([item('他说：'+reason)],geometry))
        self.assertEqual(notices.detect_notice([item('需在手机上完成登录')],geometry)['kind'],'logout')

    def test_alert_uses_separate_control_sender_and_does_not_click_the_personal_account(self):
        sender=Mock();sender.send.return_value={'accepted':True};sender.revision.return_value='revision'
        value={'id':'123','reason':'安全核验','detectedAt':'2026-11-04T20:00:00+08:00','screenshotPath':'/local/evidence.png'}
        with patch.object(notices,'control_sender',return_value=sender) as factory:
            result=notices.notify_control(value,self.config)
            factory.assert_called_once_with(self.config)
            self.assertEqual(result['status'],'accepted');self.assertEqual(result['channel'],'外部通知通道')
            text,client=sender.send.call_args.args
            self.assertIn('阮阮微信账号提醒',text);self.assertIn('安全核验',text);self.assertEqual(client,'wechat-account-alert-123')

    def test_missing_adapter_retains_notice_without_importing_or_sending(self):
        with patch.object(notices.importlib.util,'spec_from_file_location') as load:
            result=notices.notify_runtime({'id':'no-adapter','reason':'offline test','detectedAt':'now'},self.config)
        load.assert_not_called()
        self.assertEqual(result['status'],'unavailable')
        self.assertIn('未配置',result['error'])
        record=json.loads(Path(result['outboxPath']).read_text())
        self.assertEqual(record['clientId'],'wechat-runtime-alert-no-adapter')
        self.assertNotIn('attemptedAt',record)

    def test_explicit_file_adapter_recovers_retained_notice_and_uses_configured_label(self):
        value={'id':'adapter','reason':'offline test','detectedAt':'now'}
        initial=notices.notify_runtime(value,self.config)
        self.assertEqual(initial['status'],'unavailable')
        root=Path(self.config['outboxDirectory']);adapter=root/'offline_sender.py';receipt=root/'offline-receipt.txt'
        adapter.write_text('''from pathlib import Path
def create_sender(config):
    class Sender:
        def revision(self): return "offline-revision"
        def send(self, text, client_id):
            Path(config["testReceiptPath"]).write_text(client_id + "\\n" + text)
            return {"accepted": True}
    return Sender()
''')
        configured={**self.config,'senderAdapterPath':str(adapter),'channelLabel':'Offline notifications','testReceiptPath':str(receipt)}
        summary=notices.retry_notifications(configured)
        self.assertEqual(summary,{'accepted':1})
        self.assertIn('wechat-runtime-alert-adapter',receipt.read_text())
        result=notices.notify_runtime(value,configured)
        self.assertEqual(result['channel'],'Offline notifications')
        self.assertEqual(result['status'],'accepted')

    def test_disabled_sender_does_not_load_an_adapter(self):
        configured={**self.config,'enabled':False,'senderAdapterPath':'/not-opened.py'}
        with patch.object(notices.importlib.util,'spec_from_file_location') as load:
            result=notices.notify_runtime({'id':'disabled','reason':'test','detectedAt':'now'},configured)
        load.assert_not_called();self.assertEqual(result['status'],'unavailable')

    def test_notice_is_sent_even_if_transport_pause_record_fails(self):
        with tempfile.TemporaryDirectory() as directory,patch.object(driver,'STATE',Path(directory)),\
             patch.object(driver,'bridge_call',side_effect=RuntimeError('bridge stopped')),\
             patch.object(driver,'control') as control,patch.object(driver,'notify_control',return_value={'status':'accepted'}) as notify:
            driver.alert(driver.DesktopSecurityError('安全核验','security','/saved.png'),{'securityNotifications':{'accountId':'control'}})
            control.assert_not_called();notify.assert_called_once()
            stored=json.loads((Path(directory)/'alert.json').read_text())
            self.assertEqual(stored['notification']['status'],'accepted');self.assertEqual(stored['kind'],'security')

    def test_runtime_notice_uses_control_entry_without_claiming_account_shutdown(self):
        sender=Mock();sender.send.return_value={'accepted':True};sender.revision.return_value='revision'
        with patch.object(notices,'control_sender',return_value=sender):
            receipt=notices.notify_runtime({'id':'job','jobId':'job','reason':'review timeout',
                'detectedAt':'2026-11-05T01:00:00+08:00'},self.config)
        self.assertEqual(receipt['status'],'accepted')
        text,client=sender.send.call_args.args
        self.assertIn('阮阮对话处理提醒',text);self.assertIn('review timeout',text)
        self.assertNotIn('已停止相关微信自动操作',text)
        self.assertEqual(client,'wechat-runtime-alert-job')

    def test_persist_before_send_and_do_not_replay_accepted_after_restart(self):
        sender=Mock();sender.revision.return_value='revision'
        value={'id':'once','reason':'test','detectedAt':'now'}
        def send(text,client):
            files=list(Path(self.config['outboxDirectory']).glob('*.json'))
            saved=json.loads(files[0].read_text())
            self.assertEqual(saved['status'],'sending');self.assertEqual(saved['clientId'],client)
            return {'accepted':True}
        sender.send.side_effect=send
        with patch.object(notices,'control_sender',return_value=sender):
            notices.notify_runtime(value,self.config)
            notices.notify_runtime(value,self.config)
            summary=notices.retry_notifications(self.config)
        self.assertEqual(sender.send.call_count,1)
        self.assertEqual(summary,{'accepted':1})

    def test_missing_credentials_retry_after_recovery_with_same_id(self):
        sender=Mock();sender.revision.return_value='revision';sender.send.return_value={'accepted':True}
        value={'id':'recover','reason':'test','detectedAt':'now'}
        with patch.object(notices,'control_sender',side_effect=PermissionError()):
            result=notices.notify_runtime(value,self.config)
        self.assertEqual(result['status'],'retry')
        with patch.object(notices,'control_sender',return_value=sender):
            summary=notices.retry_notifications(self.config)
        self.assertEqual(summary,{'accepted':1})
        self.assertEqual(sender.send.call_args.args[1],'wechat-runtime-alert-recover')

    def test_unknown_send_and_crash_after_attempt_are_never_replayed(self):
        sender=Mock();sender.revision.return_value='revision';sender.send.side_effect=TimeoutError()
        with patch.object(notices,'control_sender',return_value=sender):
            result=notices.notify_runtime({'id':'uncertain','reason':'test','detectedAt':'now'},self.config)
            self.assertEqual(result['status'],'uncertain')
            path=Path(result['outboxPath']);record=json.loads(path.read_text())
            record['status']='sending';notices._save(path,record)
            notices.retry_notifications(self.config)
            notices.retry_notifications(self.config)
        self.assertEqual(sender.send.call_count,1)
        self.assertEqual(json.loads(path.read_text())['status'],'uncertain')

    def test_context_rejection_waits_for_updated_context(self):
        class Rejected(Exception):
            uncertain=False;wait_for_context=True
        sender=Mock();sender.revision.return_value='old';sender.send.side_effect=Rejected('context expired')
        with patch.object(notices,'control_sender',return_value=sender):
            result=notices.notify_runtime({'id':'context','reason':'test','detectedAt':'now'},self.config)
            self.assertEqual(result['status'],'waiting_context')
            notices.retry_notifications(self.config)
            self.assertEqual(sender.send.call_count,1)
            sender.revision.return_value='new';sender.send.side_effect=None;sender.send.return_value={'accepted':True}
            notices.retry_notifications(self.config)
        self.assertEqual(sender.send.call_count,2)

    def test_changed_account_does_not_reroute_retained_notice(self):
        value={'id':'binding','reason':'test','detectedAt':'now'}
        notices.notify_runtime(value,self.config,attempt=False)
        with patch.object(notices,'control_sender') as factory:
            summary=notices.retry_notifications(dict(self.config,accountId='other'))
        factory.assert_not_called();self.assertEqual(summary,{'blocked':1})

    def test_retained_source_recovers_pre_notifier_gap_but_not_legacy_failed_send(self):
        root=Path(self.config['outboxDirectory']);app=root/'app/runtime-notices';app.mkdir(parents=True)
        (root/'app/runtime-notifications.json').write_text(json.dumps({'enabled':True,'settingsPath':str(root/'database.json')}))
        value={'id':'gap','reason':'test','detectedAt':'now','notificationDeliveryVersion':1,'notification':{'status':'queued'}}
        (app/'gap.json').write_text(json.dumps(value))
        (app/'old.json').write_text(json.dumps(dict(value,id='old',notificationDeliveryVersion=0)))
        with patch.object(notices,'control_sender') as sender:
            notices.recover_retained(root/'database.json',self.config)
        sender.assert_not_called()
        rows=[json.loads(p.read_text()) for p in root.glob('*.json')]
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['clientId'],'wechat-runtime-alert-gap')

if __name__=='__main__':unittest.main()
