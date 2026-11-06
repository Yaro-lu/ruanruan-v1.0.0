"""Offline Moments contract tests. No WeChat, model, or publication is invoked."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
import moments
import wechat_gui
import database_operator


class MomentsTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        (self.root/'database.json').write_text('{}')
        self.receipts=moments.Receipts(self.root/'receipts')
        for module,name,value in [(moments,'DATA',self.root),(moments,'EXCHANGE',self.root/'exchange'),
                                  (wechat_gui,'DATA',self.root)]:
            p=patch.object(module,name,value);p.start();self.addCleanup(p.stop)
        p=patch.object(moments,'bridge_call',return_value={'enabled':True,'paused':False,'uiBusy':False})
        self.bridge=p.start();self.addCleanup(p.stop)
        self.ui=Mock(last_screen='evidence.png')
        self.ui.prepare.return_value={'screenshot':'draft.png'}
        self.ui.publish.return_value={'screenshot':'posted.png'}
        self.factory=Mock(return_value=self.ui)
        self.reader=Mock()

    def execute(self,**changes):
        return moments.execute({'requestId':'one','text':'笑一个',**changes},self.receipts,
                               reader_factory=lambda:self.reader,ui_factory=self.factory)

    def test_preview_then_publish_and_duplicate_request_never_clicks_twice(self):
        self.assertEqual(self.execute()['status'],'preview')
        self.ui.publish.assert_not_called()
        posted=self.execute(publish=True)
        self.assertTrue(posted['published'])
        self.assertEqual(posted['receipt'],'visible_own_post')
        self.assertEqual(self.execute(publish=True)['status'],'published')
        self.ui.publish.assert_called_once()
        self.assertEqual(self.factory.call_count,2)

    def test_uncertain_publish_is_persisted_and_not_retried(self):
        self.ui.publish.side_effect=RuntimeError('No visible receipt')
        self.assertEqual(self.execute(publish=True)['status'],'uncertain')
        self.assertEqual(self.execute(publish=True)['status'],'uncertain')
        self.ui.publish.assert_called_once()

    def test_explicit_client_rejection_is_not_reported_as_published_or_retried(self):
        self.ui.publish.side_effect=moments.MomentsNotSent('照片未发送')
        first=self.execute(publish=True)
        self.assertEqual(first['status'],'not_sent');self.assertFalse(first['published'])
        self.assertEqual(self.execute(publish=True)['status'],'not_sent')
        self.ui.publish.assert_called_once()

    def test_failed_photo_toast_is_recognized_without_waiting_for_a_timeout(self):
        ui=moments.MomentsUI(Mock(),self.root/'evidence')
        ui.geometry={'X':292,'Y':104,'WIDTH':440,'HEIGHT':560}
        screen={'items':[{'text':'照片未发送','score':.99,
                          'box':[[470,450],[570,450],[570,475],[470,475]]}],
                'windows':{'朋友圈':ui.geometry},'screenshot':'failure.png'}
        with patch.object(ui,'click_label') as click,patch.object(ui,'observe',return_value=screen) as observe:
            with self.assertRaises(moments.MomentsNotSent):ui.publish(screen,'笑一个')
        click.assert_called_once();observe.assert_called_once()

    def test_a_process_killed_after_marking_publishing_cannot_replay(self):
        request,content,fingerprint,_=moments.payload({'requestId':'one','text':'笑一个'})
        self.receipts.save({'requestId':request,'fingerprint':fingerprint,'status':'publishing'})
        self.assertEqual(self.execute(publish=True)['status'],'uncertain')
        self.factory.assert_not_called()

    def test_request_id_cannot_be_rebound_to_changed_content(self):
        self.execute()
        with self.assertRaisesRegex(ValueError,'different content'):self.execute(text='另一条')
        self.ui.publish.assert_not_called()

    def test_security_notice_notifies_control_and_leaves_the_dialog_untouched(self):
        self.ui.prepare.side_effect=database_operator.DesktopSecurityError('账号安全核验')
        with patch.object(moments,'alert') as alert:
            self.assertEqual(self.execute(publish=True)['status'],'blocked')
            alert.assert_called_once()
        self.ui.publish.assert_not_called();self.ui.close.assert_not_called()
        self.reader.close.assert_called_once()

    def test_active_chat_lease_and_pause_do_not_open_the_client(self):
        for status,wanted in [({'enabled':True,'paused':True},'paused'),
                              ({'enabled':True,'paused':False,'uiBusy':True},'busy')]:
            self.bridge.return_value=status
            self.assertEqual(self.execute(publish=True)['status'],wanted)
        self.factory.assert_not_called()

    def test_whole_workflow_lock_is_reentrant_and_excludes_another_process(self):
        code=('import fcntl,sys\nf=open(sys.argv[1],"a")\n'
              'try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n'
              'except BlockingIOError: sys.exit(7)\n')
        with wechat_gui.ui_session() as outer:
            with wechat_gui.ui_session(blocking=False) as inner:
                self.assertTrue(outer and inner)
                result=subprocess.run([sys.executable,'-c',code,str(self.root/'ui.lock')])
                self.assertEqual(result.returncode,7)
        self.assertEqual(subprocess.run([sys.executable,'-c',code,str(self.root/'ui.lock')]).returncode,0)

    def test_cleanup_failure_keeps_a_verified_publication_and_stops_ui_automation(self):
        self.ui.close.side_effect=RuntimeError('Unresolved popup')
        with patch.object(moments,'alert') as alert:
            result=self.execute(publish=True)
        self.assertEqual(result['status'],'published')
        self.assertIn('cleanupError',result)
        alert.assert_called_once()

    def test_publish_flag_is_not_coerced_from_a_string(self):
        with self.assertRaisesRegex(ValueError,'boolean'):self.execute(publish='false')
        self.factory.assert_not_called()


class SecurityRegression(unittest.TestCase):
    def test_small_security_window_is_classified_before_layout_error(self):
        def item(text,x,y):
            return {'text':text,'score':.99,'box':[[x-20,y-8],[x+20,y-8],[x+20,y+8],[x-20,y+8]]}
        geometry={'X':371,'Y':193,'WIDTH':280,'HEIGHT':380}
        reader=Mock()
        reader.call.return_value={'items':[item('为了你的账号安全，请重新登录。',510,372),
                                           item('我知道了',510,420)]}
        with patch.object(database_operator,'window_geometry',return_value=geometry),\
             patch.object(database_operator,'control',return_value={'screenshot':'screen.png'}):
            with self.assertRaises(database_operator.DesktopSecurityError) as caught:
                database_operator.view(reader,{'uiLabel':'owner'},full=True)
        self.assertEqual(caught.exception.kind,'security')
        self.assertIn('账号安全',str(caught.exception))
        reader.call.assert_called_once_with('ocr',{'path':'/exchange/desktop.png'})


if __name__=='__main__':unittest.main()
