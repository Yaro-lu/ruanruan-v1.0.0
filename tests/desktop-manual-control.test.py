import io,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
import manual_control

class ManualControlTests(unittest.TestCase):
 def test_session_marks_ready_only_after_exclusion_and_releases_on_disconnect(self):
  with tempfile.TemporaryDirectory() as root:
   folder=Path(root);output=io.StringIO()
   class Input:
    def __iter__(self):
     state=json.loads((folder/'manual-control.json').read_text())
     self_outer.assertTrue(state['active']);self_outer.assertEqual(output.getvalue(),'RR_CONTROL_READY\n')
     return iter([])
   self_outer=self
   with patch.object(manual_control,'bridge_call',return_value={'uiBusy':False}):manual_control.takeover(folder,Input(),output)
   self.assertFalse(json.loads((folder/'manual-control.json').read_text())['active'])
   self.assertIn('RR_CONTROL_RELEASED',output.getvalue())
 def test_live_delivery_never_grants_human_control(self):
  with tempfile.TemporaryDirectory() as root:
   folder=Path(root);output=io.StringIO()
   with patch.object(manual_control,'bridge_call',return_value={'uiBusy':True}):
    with self.assertRaises(RuntimeError):manual_control.takeover(folder,io.StringIO(),output)
   self.assertEqual(output.getvalue(),'');self.assertFalse((folder/'manual-control.json').exists())
 def test_manual_release_does_not_remove_other_channel_latches(self):
  with tempfile.TemporaryDirectory() as root:
   folder=Path(root);safety=folder/'channel_pause';safety.write_text('security')
   manual_control.release(folder)
   self.assertEqual(safety.read_text(),'security');self.assertFalse(json.loads((folder/'manual-control.json').read_text())['active'])
 def test_disconnect_before_ready_does_not_leave_a_manual_hold(self):
  with tempfile.TemporaryDirectory() as root:
   folder=Path(root)
   class Disconnected:
    def write(self,_):raise BrokenPipeError()
   with patch.object(manual_control,'bridge_call',return_value={'uiBusy':False}):
    with self.assertRaises(BrokenPipeError):
     manual_control.takeover(folder,io.StringIO(),Disconnected(),announce_release=False)
   self.assertFalse(json.loads((folder/'manual-control.json').read_text())['active'])
if __name__=='__main__':unittest.main()
