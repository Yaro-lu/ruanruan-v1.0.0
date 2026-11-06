"""Offline stdio fault injection using local pipes; no worker or model starts."""
import importlib.util
import json
import os
from pathlib import Path
import selectors
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
spec=importlib.util.spec_from_file_location('private_reader_driver',ROOT/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)


class PrivateReaderTests(unittest.TestCase):
    def reader(self):
        request_read,request_write=os.pipe();response_read,response_write=os.pipe()
        streams=[os.fdopen(fd,mode,buffering=0) for fd,mode in (
            (request_read,'rb'),(request_write,'wb'),(response_read,'rb'),(response_write,'wb'))]
        for stream in streams:self.addCleanup(stream.close)
        reader=driver.PrivateReader.__new__(driver.PrivateReader)
        reader.process=SimpleNamespace(stdin=streams[1],stdout=streams[2])
        reader.queue=driver.ReaderQueue();reader.sequence=0;reader.buffer=b'';reader.broken=False
        reader.selector=selectors.DefaultSelector();self.addCleanup(reader.selector.close)
        reader.selector.register(streams[2],selectors.EVENT_READ)
        return reader,streams[0],streams[3]

    def reply(self,stream,value):
        stream.write((json.dumps(value)+'\n').encode())

    def assert_refused_without_io(self,reader):
        sequence=reader.sequence
        with patch.object(driver.os,'write') as write,patch.object(driver.os,'read') as read:
            with self.assertRaisesRegex(RuntimeError,'connection is invalid; restart required'):
                reader.call('verify',timeout=.05)
        write.assert_not_called();read.assert_not_called()
        self.assertEqual(reader.sequence,sequence)

    def test_short_writes_complete_the_original_request_once(self):
        reader,requests,replies=self.reader();self.reply(replies,{'id':1,'result':{'ok':True}})
        write=os.write
        with patch.object(driver.os,'write',side_effect=lambda fd,data:write(fd,data[:3])):
            self.assertTrue(reader.call('poll') ['ok'])
        self.assertEqual(json.loads(requests.read(65536)),{'id':1,'method':'poll','args':{}})
        self.assertFalse(reader.broken)

    def test_partial_request_then_write_failure_invalidates_connection(self):
        reader,requests,_=self.reader();write=os.write;calls=0
        def partial(fd,data):
            nonlocal calls
            calls+=1
            if calls==1:return write(fd,data[:5])
            raise BrokenPipeError('injected broken input')
        with patch.object(driver.os,'write',side_effect=partial):
            with self.assertRaises(BrokenPipeError):reader.call('prepare')
        self.assertEqual(requests.read(65536),b'{"id"');self.assertTrue(reader.broken)
        self.assert_refused_without_io(reader)

    def test_zero_length_write_is_failure_not_a_busy_loop(self):
        reader,_,_=self.reader()
        with patch.object(driver.os,'write',return_value=0) as write:
            with self.assertRaisesRegex(BrokenPipeError,'input stopped'):reader.call('poll')
        write.assert_called_once();self.assert_refused_without_io(reader)

    def test_timeout_cannot_consume_late_response_in_a_new_request(self):
        reader,requests,replies=self.reader()
        with self.assertRaisesRegex(RuntimeError,'worker timed out'):reader.call('verify',timeout=.01)
        self.reply(replies,{'id':1,'result':{'database':{'serverId':'old'}}})
        self.assert_refused_without_io(reader)
        self.assertEqual(json.loads(requests.read(65536))['id'],1)

    def test_partial_response_timeout_also_invalidates_connection(self):
        reader,_,replies=self.reader();replies.write(b'{"id":1,"result":')
        with self.assertRaisesRegex(RuntimeError,'worker timed out'):reader.call('poll',timeout=.01)
        self.assertTrue(reader.buffer);replies.write(b'{}}\n')
        self.assert_refused_without_io(reader)

    def test_invalid_frames_are_never_treated_as_business_errors(self):
        for frame in (b'not-json\n',b'[]\n',b'{"id":2,"result":{}}\n',
                      b'{"id":true,"result":{}}\n',b'{"id":1}\n',
                      b'{"id":1,"error":"broken"}\n',
                      b'{"id":1,"error":{"type":"Error","message":"bad"},"result":{}}\n'):
            with self.subTest(frame=frame):
                reader,_,replies=self.reader();replies.write(frame)
                with self.assertRaises((RuntimeError,ValueError)):reader.call('poll')
                self.assert_refused_without_io(reader)

    def test_eof_invalidates_connection(self):
        reader,_,replies=self.reader();replies.close()
        with self.assertRaisesRegex(RuntimeError,'worker stopped'):reader.call('poll')
        self.assert_refused_without_io(reader)

    def test_complete_business_error_allows_the_next_request(self):
        reader,requests,replies=self.reader()
        self.reply(replies,{'id':1,'error':{'type':'ValueError','message':'member not found'}})
        with self.assertRaisesRegex(RuntimeError,'Read-only worker: ValueError: member not found'):
            reader.call('prepare')
        self.assertFalse(reader.broken)
        self.reply(replies,{'id':2,'result':{'events':[]}})
        self.assertEqual(reader.call('poll')['events'],[])
        self.assertEqual([json.loads(line)['id'] for line in requests.read(65536).splitlines()],[1,2])

    def test_queue_timeout_before_starting_does_not_invalidate_connection(self):
        reader,requests,replies=self.reader()
        with reader.queue.acquire(0,1):
            with self.assertRaisesRegex(TimeoutError,'before starting'):reader.call('poll',timeout=.01)
        self.assertFalse(reader.broken);self.assertEqual(reader.sequence,0)
        self.reply(replies,{'id':1,'result':{}});reader.call('poll')
        self.assertEqual(json.loads(requests.read(65536))['id'],1)


if __name__=='__main__':unittest.main()
