"""Offline takeover-to-sender handoff checks; no desktop or model calls."""
from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
spec=importlib.util.spec_from_file_location('manual_resume_driver',ROOT/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)


class ManualResumeTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.directory=Path(folder.name);self.path=self.directory/'manual-control.json'
        self.write_manual('new',100)
        self.health={'last':time.monotonic(),'failures':0,'manualRevision':'old:99'}
        self.status={'receivePaused':False,'sendPaused':False,'manualControl':{'revision':'new:100'},
                     'outgoing':[{'status':'queued','count':1}]}
        self.events=[];self.on_lock=None;self.available=True;self.check_error=None
        self.delivery={'id':'queued'}
        def bridge(action,args):
            self.events.append(action)
            if action=='status':return self.status
            if action=='next-delivery':return {'delivery':self.delivery}
            raise AssertionError(action)
        @contextmanager
        def ui_session(blocking=False):
            self.events.append('lock')
            if self.on_lock:self.on_lock()
            yield self.available
        def inspect(*args,**kwargs):
            self.events.append('full-check');self.assertTrue(kwargs['full'])
            if self.check_error:raise self.check_error
            kwargs['health']['last']=time.monotonic()
            return {'fullInspection':True}
        def deliver(*args):self.events.append('deliver');return True
        for name,value in [('DATA',self.directory),('deployment_held',lambda:False),
                           ('bridge_call',bridge),('ui_session',ui_session),
                           ('inspected_view',inspect),('deliver',deliver)]:
            changed=patch.object(driver,name,value);changed.start();self.addCleanup(changed.stop)

    def write_manual(self,session,ended,active=False):
        self.path.write_text(json.dumps({'active':active,'sessionId':session,'endedAt':ended}))

    def cycle(self):return driver.send_cycle(None,{},self.health)

    def test_queued_reply_gets_full_check_before_claim_or_any_delivery_actions(self):
        self.assertEqual(self.cycle(),0)
        self.assertEqual(self.events,['status','lock','full-check','next-delivery','deliver'])
        self.assertEqual(self.health['manualRevision'],'new:100')

    def test_short_takeover_between_status_and_lock_is_detected_from_disk(self):
        self.status['manualControl']['revision']='old:99';self.write_manual('old',99)
        self.on_lock=lambda:self.write_manual('brief-takeover',101)
        self.cycle()
        self.assertEqual(self.events,['status','lock','full-check','next-delivery','deliver'])
        self.assertEqual(self.health['manualRevision'],'brief-takeover:101')

    def test_security_notice_stops_before_claim_and_preserves_existing_pause_path(self):
        self.check_error=driver.DesktopSecurityError('verification required')
        with self.assertRaises(driver.DesktopSecurityError):self.cycle()
        self.assertEqual(self.events,['status','lock','full-check'])
        self.assertEqual(self.health['manualRevision'],'old:99')

    def test_failed_check_is_repeated_before_the_next_delivery(self):
        self.check_error=RuntimeError('OCR unavailable')
        with self.assertRaisesRegex(RuntimeError,'OCR unavailable'):self.cycle()
        self.assertNotIn('next-delivery',self.events);self.assertEqual(self.health['last'],0)
        self.check_error=None;self.events.clear();self.cycle()
        self.assertEqual(self.events,['status','lock','full-check','next-delivery','deliver'])
        self.assertEqual(self.health['manualRevision'],'new:100')

    def test_completed_revision_does_not_repeat_full_check_or_add_bridge_rpc(self):
        self.health['manualRevision']='new:100';self.cycle()
        self.assertEqual(self.events,['status','lock','next-delivery','deliver'])

    def test_durable_active_hold_overrides_stale_unpaused_status(self):
        self.on_lock=lambda:self.write_manual('interrupted-takeover',102,active=True)
        self.assertEqual(self.cycle(),.5)
        self.assertEqual(self.events,['status','lock'])

    def test_invalid_manual_state_never_allows_queued_delivery(self):
        self.path.write_text('{"active":false}')
        with self.assertRaisesRegex(RuntimeError,'takeover state is invalid'):self.cycle()
        self.assertEqual(self.events,['status','lock'])


if __name__=='__main__':unittest.main()
