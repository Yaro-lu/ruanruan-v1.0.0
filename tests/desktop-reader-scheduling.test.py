"""Offline stdio scheduling and media handoff; no desktop or source database."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
spec=importlib.util.spec_from_file_location('scheduled_reader',Path(__file__).resolve().parents[1]/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)


class ReaderSchedulingTests(unittest.TestCase):
    def test_waiting_send_check_precedes_poll_and_media_without_overlapping_stdio(self):
        reader=driver.PrivateReader.__new__(driver.PrivateReader)
        reader.queue=driver.ReaderQueue()
        order=[];results=[];errors=[];active=0;maximum=0
        def exchange(method,args,timeout):
            nonlocal active,maximum
            active+=1;maximum=max(maximum,active)
            order.append(method);time.sleep(.002);active-=1
            return {'method':method}
        reader._call=exchange
        def run(method):
            try:results.append(reader.call(method,timeout=2))
            except Exception as error:errors.append(error)
        threads=[]
        with reader.queue.acquire(1,2):
            for method in ('poll-media','poll','verify'):
                thread=threading.Thread(target=run,args=(method,));threads.append(thread);thread.start()
                deadline=time.monotonic()+1
                while len(reader.queue.waiting)<len(threads) and time.monotonic()<deadline:time.sleep(.001)
                self.assertEqual(len(reader.queue.waiting),len(threads))
        for thread in threads:thread.join(2)
        self.assertFalse(errors);self.assertTrue(all(not t.is_alive() for t in threads))
        self.assertEqual(order,['verify','poll','poll-media']);self.assertEqual(maximum,1)
        for result in results:
            self.assertGreaterEqual(result['_rpcTiming']['lockWaitMs'],0)
            self.assertGreater(result['_rpcTiming']['rpcMs'],0)

    def test_queue_timeout_does_not_write_a_request_or_leave_a_blocking_ticket(self):
        reader=driver.PrivateReader.__new__(driver.PrivateReader);reader.queue=driver.ReaderQueue()
        calls=[]
        reader._call=lambda method,*_:calls.append(method) or {}
        with reader.queue.acquire(1,1):
            with self.assertRaisesRegex(TimeoutError,'before starting'):
                reader.call('poll-media',timeout=.001)
            self.assertEqual(reader.queue.waiting,[])
        self.assertEqual(calls,[])
        reader.call('verify');self.assertEqual(calls,['verify'])

    def test_incoming_metadata_is_accepted_and_checkpointed_without_media_decoding(self):
        calls=[];events=[{'sourceMessageId':'new-message'}]
        class Reader:
            def call(self,method,*_):
                calls.append(method)
                return {'events':events,'cursor':{'pendingMedia':{'new-message':{'attempts':0}}}}
        with tempfile.TemporaryDirectory() as directory,patch.object(driver,'STATE',Path(directory)),\
             patch.object(driver,'register_routes'),patch.object(driver,'accept_events') as accept,\
             patch.object(driver,'bridge_call') as bridge:
            self.assertEqual(driver.ingest(Reader(),{}),1)
            self.assertEqual(calls,['poll']);accept.assert_called_once_with(events,{})
            bridge.assert_not_called()
            self.assertIn('new-message',(Path(directory)/'cursor.json').read_text())

    def test_one_requested_media_per_pass_leaves_other_requests_pending(self):
        calls=[]
        class Reader:
            def call(self,method,args):calls.append((method,args));return {'sourceMessageId':args['source']}
        def bridge(action,args):
            return {'sources':['first','second','third']} if action=='media-requests' else {}
        with patch.object(driver,'bridge_call',side_effect=bridge) as transport,patch.object(driver,'accept_events') as accept:
            driver.ingest_media(Reader(),{})
            self.assertEqual(calls,[('resolve-media',{'source':'first'})])
            accept.assert_called_once_with([{'sourceMessageId':'first'}],{})
            completed=[c.args[1]['source'] for c in transport.call_args_list if c.args[0]=='media-request-finished']
            self.assertEqual(completed,['first'])

    def test_background_media_update_is_accepted_before_its_checkpoint(self):
        events=[{'sourceMessageId':'resolved'}];steps=[]
        class Reader:
            def call(self,method):
                self.method=method;return {'events':events,'cursor':{'pendingMedia':{}}}
        reader=Reader()
        with patch.object(driver,'bridge_call',return_value={'sources':[]}),\
             patch.object(driver,'accept_events',side_effect=lambda *_:steps.append('accepted')),\
             patch.object(driver,'save_json',side_effect=lambda *_:steps.append('checkpoint')):
            driver.ingest_media(reader,{})
        self.assertEqual(reader.method,'poll-media');self.assertEqual(steps,['accepted','checkpoint'])

    def test_confirmation_reports_queue_rpc_and_receipt_cost_without_screenshot(self):
        replies=iter([
            {'pending':True,'verifyQueryMs':1,'_rpcTiming':{'lockWaitMs':3,'rpcMs':10}},
            {'database':{'serverId':'12'},'verifyQueryMs':2,'_rpcTiming':{'lockWaitMs':4,'rpcMs':20}},
        ])
        class Reader:
            def call(self,*_):return next(replies)
        with patch.object(driver.time,'sleep'),patch.object(driver,'bridge_call'),patch.object(driver,'control') as control:
            timing=driver.confirm_delivery(Reader(),{'uiLabel':'群'},{'id':'d','leaseId':'l'},10)
        self.assertEqual(timing['verifyChecks'],2)
        self.assertEqual(timing['verifyLockWaitMs'],7)
        self.assertEqual(timing['verifyRpcMs'],30)
        self.assertEqual(timing['verifyQueryMs'],3)
        self.assertIn('receiptMs',timing);control.assert_not_called()


if __name__=='__main__':unittest.main()
