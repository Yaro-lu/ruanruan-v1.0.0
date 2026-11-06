"""Offline first-install checks: mocked readers, no Docker, OCR, or model calls."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'desktop'))
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,ROOT/'desktop'/file)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result)
    return result
driver=module('bootstrap_driver','database_operator.py')
installer=module('bootstrap_installer','install_database_transport.py')


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.data=Path(folder.name);self.state=self.data/'database-state';self.state.mkdir()
        self.config=self.data/'bridge.json';self.cursor=self.state/'cursor.json'
        self.binding={'accountDirectory':'wxid_self_abc','selfUsername':'wxid_self','ownerUsername':'wxid_owner'}
        self.settings={'enabled':False,'ownerPeerId':'owner-test','uiLabel':'owner'}
        self.config.write_text(json.dumps({'enabled':False,'contacts':[],'ownerPeerId':'owner-test'}))
        self.result={'binding':self.binding,
            'cursor':{'version':2,'binding':self.binding,'since':100,'multiSince':100,
                      'watermarks':{'room/message_0':17},'contextRooms':['room@chatroom']},
            'routes':[{'peerId':'owner-test','uiLabel':'owner','username':'wxid_owner','kind':'private'}],
            'baselineEvents':[{'sourceMessageId':'old-room-row','contextOnly':True}]}
        self.reader=Mock();self.reader.call.side_effect=lambda *a,**kw:copy.deepcopy(self.result)
        for name,value in [('DATA',self.data),('STATE',self.state),('BRIDGE_CONFIG',self.config)]:
            handle=patch.object(driver,name,value);handle.start();self.addCleanup(handle.stop)

    def test_first_prepare_keeps_bridge_disabled_and_defers_group_background(self):
        settings_path=self.data/'database.json';settings_path.write_text(json.dumps(self.settings))
        def bridge(action,args):
            if action=='status':return {'receivePaused':False}
            if action=='sync-identities':return {}
            raise AssertionError('Preparation must not enter incoming/sending: '+action)
        vision=Mock()
        with patch.object(driver,'SETTINGS',settings_path),patch.object(sys,'argv',['database_operator.py','--prepare']),\
             patch.object(driver.subprocess,'run',return_value=Mock(returncode=1)),\
             patch.object(driver,'PrivateReader',side_effect=[self.reader,vision]),\
             patch.object(driver,'TransportHealth',return_value=Mock()),patch.object(driver,'RecoveryBackoff',return_value=Mock()),\
             patch.object(driver,'bridge_call',side_effect=bridge),patch.object(driver,'view',return_value={'ownerVisible':True}) as view,\
             patch.object(driver,'accept_events',side_effect=AssertionError('No inbound baseline during preparation')):
            driver.main()
        config=json.loads(self.config.read_text());cursor=json.loads(self.cursor.read_text())
        self.assertFalse(config['enabled']);self.assertEqual(config['database'],self.binding)
        self.assertEqual(cursor['watermarks'],{'room/message_0':17})
        self.assertEqual(cursor['contextRooms'],[])
        self.assertTrue(json.loads((self.state/'readiness.json').read_text())['prepared'])
        view.assert_called_once();self.reader.close.assert_called_once();vision.close.assert_called_once()

    def test_prepare_preserves_previously_committed_room_seeds_only(self):
        previous={**self.result['cursor'],'contextRooms':['old-room@chatroom']}
        self.cursor.write_text(json.dumps(previous))
        self.result['cursor']['contextRooms']=['old-room@chatroom','room@chatroom']
        with patch.object(driver,'register_routes'),patch.object(driver,'accept_events') as accept:
            driver.initialize_reader(self.reader,self.settings,self.cursor,prepare=True)
        accept.assert_not_called()
        self.assertEqual(json.loads(self.cursor.read_text())['contextRooms'],['old-room@chatroom'])
        self.assertEqual(self.reader.call.call_args.args[1]['cursor'],previous)

    def test_enabled_startup_still_imports_background_and_preserves_live_watermark(self):
        prepared={**self.result['cursor'],'contextRooms':[]}
        self.cursor.write_text(json.dumps(prepared))
        with patch.object(driver,'register_routes'),patch.object(driver,'accept_events') as accept:
            driver.initialize_reader(self.reader,{**self.settings,'enabled':True},self.cursor,self.binding)
        self.assertEqual(self.reader.call.call_args.args[1]['cursor'],prepared)
        accept.assert_called_once_with(self.result['baselineEvents'],{**self.settings,'enabled':True})
        self.assertEqual(json.loads(self.cursor.read_text()),self.result['cursor'])

    def test_normal_startup_checks_binding_and_does_not_checkpoint_rejected_background(self):
        with patch.object(driver,'register_routes') as routes,patch.object(driver,'accept_events') as accept:
            with self.assertRaises(driver.DesktopSecurityError):
                driver.initialize_reader(self.reader,self.settings,self.cursor,{'selfUsername':'wrong'})
        routes.assert_not_called();accept.assert_not_called();self.assertFalse(self.cursor.exists())
        with patch.object(driver,'register_routes'),patch.object(driver,'accept_events',side_effect=RuntimeError('disabled gate')):
            with self.assertRaisesRegex(RuntimeError,'disabled gate'):
                driver.initialize_reader(self.reader,self.settings,self.cursor,self.binding)
        self.assertFalse(self.cursor.exists())

    def test_installer_places_both_reader_modules_in_fresh_build_context(self):
        vendor=self.data/'vendor/wechat-ai';(vendor/'src').mkdir(parents=True)
        (vendor/'src/fixture.py').write_text('# upstream fixture\n');(vendor/'LICENSE').write_text('fixture license')
        self.config.write_text(json.dumps({'enabled':False,'ownerPeerId':'owner-test',
            'contacts':[{'peerId':'owner-test','uiLabel':'owner'}]}))
        checked=[]
        def execute(command,**kwargs):
            self.assertEqual(command[:2],['docker','build'])
            context=Path(command[-1]);checked.append(context)
            for name in ['rpc.py','live_database.py']:
                self.assertEqual((context/name).read_bytes(),(ROOT/'desktop/db-worker'/name).read_bytes())
            return Mock(returncode=0)
        with patch.object(installer,'DATA',self.data),patch.object(installer,'EXCHANGE',self.data/'exchange'),\
             patch.object(installer,'PROJECT',ROOT),patch.object(installer,'run',return_value=b'["wxid_self_abc"]'),\
             patch.object(installer.subprocess,'check_output',return_value=installer.REVISION+'\n'),\
             patch.object(installer.subprocess,'run',side_effect=execute),\
             patch.object(sys,'argv',['install_database_transport.py','--account-wechat-id','self','--owner-wechat-id','owner']):
            installer.main()
        self.assertEqual(len(checked),1)
        self.assertFalse(json.loads((self.data/'database.json').read_text())['enabled'])


if __name__=='__main__':unittest.main()
