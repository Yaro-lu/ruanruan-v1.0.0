"""Lease recovery regressions; no client/database/network/model operations."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
spec=importlib.util.spec_from_file_location('recovery_driver',Path(__file__).resolve().parents[1]/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)

# GUI fixtures do not use the host recovery journal; durable crash behavior is
# exercised with real temporary files in desktop-transport-recovery.test.py.
def setUpModule():
    for name in ('record_prepared','record_attempted','record_done'):
        fixture=patch.object(driver,name)
        fixture.start();unittest.addModuleCleanup(fixture.stop)



class DeliveryRecoveryTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        config=Path(folder.name)/'bridge.json';config.write_text('{"contacts":[]}')
        setting=patch.object(driver,'BRIDGE_CONFIG',config);setting.start();self.addCleanup(setting.stop)

    def test_bounded_extension_precedes_screenshot_recheck(self):
        calls=[]
        def bridge(action,args):
            calls.append(action);return {}
        def inspect(*_):calls.append('screenshot');return None
        with patch.object(driver,'ensure_owner',side_effect=RuntimeError('temporary geometry error')),\
             patch.object(driver,'bridge_call',side_effect=bridge),patch.object(driver,'review_failure',side_effect=inspect):
            self.assertFalse(driver.deliver(None,{'uiLabel':'群'},{'id':'d','leaseId':'lease','kind':'text','text':'hello'}))
        self.assertEqual(calls,['extend-delivery','screenshot','receipt'])

    def test_ui_access_denied_before_click_does_not_become_an_uncertain_send(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        calls=[];receipts=[]
        def control(action,args):
            calls.append((action,args))
            if action=='click' and args['x']==907:raise RuntimeError('Desktop lease expired or was cancelled')
            return {'text':'hello'}
        def bridge(action,args):
            if action=='receipt':receipts.append(args)
            return {}
        reader=type('Reader',(),{'call':lambda *_:{'enabled':True}})()
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'inspected_view',return_value=screen),\
             patch.object(driver,'compose_is_empty',return_value=True),patch.object(driver,'review_failure',return_value=None),\
             patch.object(driver,'control',side_effect=control),patch.object(driver,'bridge_call',side_effect=bridge):
            self.assertFalse(driver.deliver(reader,{'uiLabel':'群'},{'id':'d','leaseId':'lease','kind':'text','text':'hello'}))
        self.assertEqual(receipts[-1]['status'],'rejected')
        self.assertEqual(sum(action=='click' and args['x']==907 for action,args in calls),1)


if __name__=='__main__':unittest.main()
