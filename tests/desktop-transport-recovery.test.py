"""Offline crash, timeout and reconciliation injection. No real WeChat/model."""
import importlib.util
import json
import os
from pathlib import Path
import queue
import selectors
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch,Mock
from contextlib import nullcontext

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
spec=importlib.util.spec_from_file_location('recovery_transport_driver',ROOT/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
from transport_recovery import RecoveryBackoff,TransportHealth,durable_json
import wechat_gui


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.folder=tempfile.TemporaryDirectory();self.addCleanup(self.folder.cleanup)
        self.state=Path(self.folder.name)
        changed=patch.object(driver,'STATE',self.state);changed.start();self.addCleanup(changed.stop)
        self.delivery={'id':'delivery','leaseId':'lease','uiLabel':'Group','kind':'text','text':'reviewed'}
        self.checkpoint={'version':1,'startedAt':time.time()-1,'target':'room'}

    def test_pre_click_journal_is_durable_and_read_only_recovery_consumes_it(self):
        driver.record_prepared(self.delivery,{'verification':self.checkpoint})
        path=self.state/'deliveries/delivery.json'
        self.assertEqual(path.stat().st_mode&0o777,0o600)
        self.assertEqual(json.loads(path.read_text())['phase'],'prepared')
        driver.record_attempted(self.delivery)
        checkpoint=json.loads(path.read_text())
        self.assertEqual(checkpoint['phase'],'attempted')
        self.assertIn('attemptedAt',checkpoint['verification'])
        reader=Mock();reader.call.return_value={'database':{'serverId':'123'}}
        def bridge(action,args):return {'deliveries':[self.delivery]} if action=='pending-reconciliation' else {}
        with patch.object(driver,'bridge_call',side_effect=bridge) as bridge,patch.object(driver,'control') as control:
            self.assertEqual(driver.reconcile_deliveries(reader),1)
        self.assertEqual(reader.call.call_args.args[0],'reconcile')
        self.assertEqual(bridge.call_args.args[0],'reconcile-receipt')
        control.assert_not_called();self.assertFalse(path.exists())

    def test_missing_checkpoint_or_lease_change_never_guesses_or_resends(self):
        reader=Mock()
        with patch.object(driver,'bridge_call',return_value={'deliveries':[self.delivery]}),patch.object(driver,'control') as control:
            driver.reconcile_deliveries(reader)
            driver.record_prepared(self.delivery,{'verification':self.checkpoint})
            driver.reconcile_deliveries(reader)  # prepared, not attempted
            driver.record_attempted(self.delivery)
            self.delivery['leaseId']='other'
            driver.reconcile_deliveries(reader)
        reader.call.assert_not_called();control.assert_not_called()

    def test_pending_or_rejected_recovery_proof_retains_journal(self):
        driver.record_prepared(self.delivery,{'verification':self.checkpoint});driver.record_attempted(self.delivery)
        for result in ({'pending':True},{'database':{'serverId':'wrong'}}):
            reader=Mock();reader.call.return_value=result
            def bridge(action,args):
                if action=='pending-reconciliation':return {'deliveries':[self.delivery]}
                raise ValueError('Invalid database proof')
            with patch.object(driver,'bridge_call',side_effect=bridge),patch.object(driver,'control') as control:
                self.assertEqual(driver.reconcile_deliveries(reader),0)
            self.assertTrue((self.state/'deliveries/delivery.json').exists());control.assert_not_called()

    def test_corrupt_journal_isolated_from_other_reconciliation(self):
        path=self.state/'deliveries/delivery.json';path.parent.mkdir();path.write_text('{')
        reader=Mock()
        with patch.object(driver,'bridge_call',return_value={'deliveries':[self.delivery]}):
            self.assertEqual(driver.reconcile_deliveries(reader),0)
        reader.call.assert_not_called()

    def test_uncertainty_holds_only_sending_even_if_screenshot_fails(self):
        issue=driver.UncertainDelivery('receipt unknown');issue.delivery_id='delivery'
        with patch.object(driver,'bridge_call',return_value={'hold':{'id':'hold'}}) as bridge,\
             patch.object(driver,'control',side_effect=RuntimeError('screenshot failed')),patch.object(driver,'notify_control') as notify:
            driver.alert(issue,{})
        bridge.assert_called_once_with('hold-sending',{'reason':'receipt unknown','kind':'failure','deliveryId':'delivery'})
        notify.assert_not_called();self.assertEqual(json.loads((self.state/'alert.json').read_text())['kind'],'failure')

    def test_security_pause_is_committed_before_screenshot_and_not_a_technical_hold(self):
        calls=[]
        def bridge(action,args):calls.append(action);return {}
        def screen(*_):calls.append('screenshot');raise RuntimeError('failed')
        with patch.object(driver,'bridge_call',side_effect=bridge),patch.object(driver,'control',side_effect=screen),\
             patch.object(driver,'notify_control',return_value={'status':'accepted'}):
            driver.alert(driver.DesktopSecurityError('verification'),{'securityNotifications':{}})
        self.assertEqual(calls,['pause','screenshot'])

    def test_send_hold_does_not_request_gui_or_delivery(self):
        with patch.object(driver,'bridge_call',return_value={'sendPaused':True,'receivePaused':False}) as bridge,\
             patch.object(driver,'ui_session') as gui:
            self.assertEqual(driver.send_cycle(None,{},{}),.5)
        gui.assert_not_called();bridge.assert_called_once_with('status',{})

    def test_empty_polls_still_advance_progress(self):
        stop=threading.Event();failures=queue.Queue();progress=Mock();count=0
        def ingest(*_):
            nonlocal count
            count+=1
            if count==2:stop.set()
            return 0
        with patch.object(driver,'ingest',side_effect=ingest),patch.object(driver,'ingest_media'),patch.object(stop,'wait',return_value=False):
            driver.receive_loop(None,{},stop,failures,progress)
        self.assertEqual(progress.polled.call_count,2);self.assertTrue(failures.empty())

    def test_receive_crash_reports_failure_and_preserves_checkpoint(self):
        path=self.state/'cursor.json';durable_json(path,{'watermark':42})
        stop=threading.Event();failures=queue.Queue()
        with patch.object(driver,'ingest',side_effect=RuntimeError('worker exited')):
            driver.receive_loop(None,{},stop,failures)
        self.assertTrue(stop.is_set());self.assertIsInstance(failures.get_nowait(),RuntimeError)
        self.assertEqual(json.loads(path.read_text()),{'watermark':42})

    def test_watchdog_uses_progress_not_message_arrivals_and_respects_safety_pause(self):
        health=TransportHealth(self.state/'health.json',exit_process=Mock())
        clock=[10.]
        with patch('transport_recovery.time.monotonic',side_effect=lambda:clock[0]):
            health.ready();health.begin('sending',720)
            for now in (20,50,100,150):
                clock[0]=now;health.polled();self.assertIsNone(health.stalled())
            clock[0]=241;self.assertIn('polling',health.stalled())
            health.update(phase='paused');self.assertIsNone(health.stalled())
        health.flush();value=json.loads(health.path.read_text())
        self.assertGreater(value['lastPollAt'],0);self.assertIn('startedAt',value);self.assertIn('pid',value)

    def test_restart_backoff_persists_repeated_failure_and_resets_after_stability(self):
        path=self.state/'retry.json'
        with patch('transport_recovery.time.sleep') as sleep:
            first=RecoveryBackoff(path);first.wait();first.failed('first')
            second=RecoveryBackoff(path);second.wait();second.failed('second')
            third=RecoveryBackoff(path);third.wait();self.assertEqual(sleep.call_args.args,(10,))
            third.healthy()
            self.assertEqual(json.loads(path.read_text())['failures'],0)
            third.failed('after stable')
            self.assertEqual(json.loads(path.read_text())['failures'],1)
        # A hard-killed process without finally is also counted next startup.
        durable_json(path,{'running':True,'failures':2})
        self.assertEqual(RecoveryBackoff(path).failures,3)

    def test_planned_stop_does_not_increment_crash_count(self):
        path=self.state/'retry.json'
        durable_json(path,{'running':False,'failures':1})
        retry=RecoveryBackoff(path)
        with patch('transport_recovery.time.sleep'):retry.wait()
        retry.stopped()
        self.assertEqual(RecoveryBackoff(path).failures,1)

    def run_main(self,receive,send):
        settings=self.state/'database.json';settings.write_text(json.dumps({'enabled':True}))
        config=self.state/'bridge.json';binding={'accountDirectory':'account','selfUsername':'self','ownerUsername':'owner'}
        config.write_text(json.dumps({'database':binding}))
        durable_json(self.state/'cursor.json',{'watermark':42})
        first=Mock();second=Mock();vision=Mock()
        for reader in (first,second):reader.call.return_value={'binding':binding,'cursor':{'watermark':42},'routes':[]}
        databases=iter((first,second))
        class Thread:
            def __init__(self,target,args,**kw):self.target=target;self.args=args
            def start(self):self.target(*self.args)
            def join(self,**kw):pass
        with patch.object(driver,'DATA',self.state),patch.object(driver,'SETTINGS',settings),             patch.object(driver,'BRIDGE_CONFIG',config),patch.object(sys,'argv',['database_operator.py']),             patch.object(driver.subprocess,'run',return_value=Mock(returncode=1)),             patch.object(driver,'TransportHealth',return_value=Mock()),patch.object(driver,'RecoveryBackoff',return_value=Mock()),             patch.object(driver,'PrivateReader',side_effect=lambda settings,purpose='database':vision if purpose=='vision' else next(databases)),             patch.object(driver,'bridge_call',return_value={'receivePaused':False,'sendPaused':False}),             patch.object(driver,'register_routes'),patch.object(driver,'accept_events'),             patch.object(driver,'reconcile_deliveries'),patch.object(driver.threading,'Thread',Thread),             patch.object(driver,'receive_loop',side_effect=receive),patch.object(driver,'send_cycle',side_effect=send) as sender,             patch.object(driver,'alert') as alert,patch.object(driver.time,'sleep'):
            driver.main()
        return first,second,sender,alert

    def test_main_rebuilds_crashed_receiver_from_original_cursor_without_ocr(self):
        calls=[]
        def receive(reader,settings,stopped,failures,progress):
            calls.append(reader)
            if len(calls)==1:failures.put(RuntimeError('reader crashed'));stopped.set()
        with patch.object(driver,'review_failure') as ocr:
            first,second,sender,alert=self.run_main(receive,[None])
        self.assertEqual(len(calls),2)
        for reader in (first,second):
            self.assertEqual(reader.call.call_args.args,('init',{'settings':{'enabled':True},'cursor':{'watermark':42}}))
        ocr.assert_not_called();alert.assert_not_called()

    def test_main_uncertain_send_keeps_receiver_running_and_reaches_next_cycle(self):
        receive=Mock();issue=driver.UncertainDelivery('unknown');issue.delivery_id='delivery'
        first,second,sender,alert=self.run_main(receive,[issue,None])
        self.assertEqual(receive.call_count,1);self.assertEqual(sender.call_count,2)
        alert.assert_called_once_with(issue,{'enabled':True})
        second.call.assert_not_called()

    def test_worker_not_reading_stdin_has_bounded_write_timeout(self):
        reader=driver.PrivateReader.__new__(driver.PrivateReader)
        reader.process=subprocess.Popen([sys.executable,'-c','import time;time.sleep(5)'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,bufsize=0)
        reader.sequence=0;reader.buffer=b'';reader.selector=selectors.DefaultSelector()
        reader.selector.register(reader.process.stdout,selectors.EVENT_READ)
        try:
            started=time.monotonic()
            with self.assertRaisesRegex(TimeoutError,'input timed out'):
                reader._call('poll',{'large':'x'*1000000},timeout=.05)
            self.assertLess(time.monotonic()-started,1)
        finally:reader.close()

    def test_broken_bridge_is_discarded_without_replaying_failed_mutation(self):
        bad=Mock();bad.call.side_effect=RuntimeError('response lost')
        new=Mock();new.call.return_value={'ok':True}
        local=threading.local();local.client=bad
        with patch.object(wechat_gui,'_bridge_local',local),patch.object(wechat_gui,'BridgeClient',return_value=new):
            with self.assertRaises(RuntimeError):wechat_gui.bridge_call('incoming-batch',{'messages':[]})
            self.assertEqual(wechat_gui.bridge_call('status',{}),{'ok':True})
        bad.call.assert_called_once();new.call.assert_called_once_with('status',{});bad.close.assert_called_once()


if __name__=='__main__':unittest.main()
