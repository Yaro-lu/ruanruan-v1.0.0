"""Synthetic local transport tests. Never reads WeChat, invokes models or sends."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'desktop'))
spec=importlib.util.spec_from_file_location('database_operator',Path(__file__).resolve().parents[1]/'desktop/database_operator.py')
driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)

# GUI fixtures do not use the host recovery journal; durable crash behavior is
# exercised with real temporary files in desktop-transport-recovery.test.py.
def setUpModule():
    folder=tempfile.TemporaryDirectory();unittest.addModuleCleanup(folder.cleanup)
    data=patch.object(driver,'DATA',Path(folder.name))
    data.start();unittest.addModuleCleanup(data.stop)
    for name in ('record_prepared','record_attempted','record_done'):
        fixture=patch.object(driver,name)
        fixture.start();unittest.addModuleCleanup(fixture.stop)



class TransportTests(unittest.TestCase):
    def setUp(self):
        inspection=patch.object(driver,'review_failure',return_value=None)
        inspection.start();self.addCleanup(inspection.stop)

    def test_failed_mention_records_actual_ocr_scores_and_roster_before_cleanup(self):
        member={'username':'ling','name':'🌸玲~'}
        observed=[{'text':'玲~','score':.77,'box':[[20,20],[100,20],[100,40],[20,40]]},
                  {'text':'其他候选','score':.72,'box':[[20,60],[100,60],[100,80],[20,80]]}]
        reader=type('Reader',(),{'call':lambda *_:{'items':observed}})()
        with tempfile.TemporaryDirectory() as directory,patch.object(driver,'EXCHANGE',Path(directory)),\
             patch.object(driver,'control'),patch.object(driver.time,'sleep'),\
             patch.object(driver,'ask_recovery',return_value=None) as recovery:
            screen=Path(directory)/'screen.png';screen.write_bytes(b'fixture')
            current={'screen':str(screen),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
            with self.assertRaisesRegex(RuntimeError,'Exact @ member'):
                driver.select_mention(reader,current,member,'lease',members=[member])
            evidence=recovery.call_args.kwargs['observations']
            self.assertEqual(evidence['ocrItems'],observed)
            self.assertEqual(evidence['members'],[member])
            self.assertEqual(evidence['renderNames'],['🌸玲~'])
            self.assertTrue(evidence['beforeScreenshot'].endswith('mention-before-lease.png'))
            self.assertFalse(list(Path(directory).glob('mention-before-*.png')))
    def test_success_receipt_uses_database_proof_without_screenshot_or_invented_visual_evidence(self):
        proof={'serverId':'123','localId':42,'text':'actual database content'}
        for kind in ('text','image'):
            reader=type('Reader',(),{'call':lambda *_:{'database':proof}})()
            with self.subTest(kind=kind),patch.object(driver,'control') as control,patch.object(driver,'bridge_call') as bridge:
                driver.confirm_delivery(reader,{'uiLabel':'群'},
                    {'id':'d','leaseId':'l','kind':kind,'text':'requested reply'},12)
                control.assert_not_called()
                bridge.assert_called_once_with('receipt',{'id':'d','leaseId':'l','status':'sent','uiLabel':'群','database':proof})

    def test_screenshot_recovery_reuses_the_verified_draft_and_clicks_send_once(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        class Reader:
            def __init__(self):self.green_checks=0
            def call(self,method,*_):
                if method=='green':
                    self.green_checks+=1;return {'enabled':self.green_checks>1}
                if method=='verify':return {'database':{'serverId':'123'}}
                return {}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'view',return_value=screen),\
             patch.object(driver,'compose_is_empty',return_value=True),patch.object(driver,'review_failure',return_value=screen) as inspect,\
             patch.object(driver,'bridge_call',return_value={}) as bridge,\
             patch.object(driver,'control',side_effect=lambda action,args:{'text':'hello'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control:
            self.assertTrue(driver.deliver(Reader(),{'uiLabel':'管理者'},{'id':'d','leaseId':'l','kind':'text','text':'hello'}))
            inspect.assert_called_once()
            self.assertEqual(sum(c.args[0]=='append_composer' for c in control.call_args_list),1)
            self.assertEqual(sum(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list),1)
            self.assertEqual(bridge.call_args.args[1]['status'],'sent')

    def test_recovery_after_send_only_checks_the_receipt_without_clicking_again(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        class Reader:
            def __init__(self):self.checks=0
            def call(self,method,*_):
                if method=='verify':
                    self.checks+=1
                    if self.checks==1:raise RuntimeError('transient reader failure')
                    return {'database':{'serverId':'123'}}
                return {'enabled':True}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'view',return_value=screen),\
             patch.object(driver,'compose_is_empty',return_value=True),patch.object(driver,'review_failure',return_value=screen),\
             patch.object(driver,'bridge_call',return_value={}) as bridge,\
             patch.object(driver,'control',side_effect=lambda action,args:{'text':'hello'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control:
            self.assertTrue(driver.deliver(Reader(),{'uiLabel':'管理者'},{'id':'d','leaseId':'l','kind':'text','text':'hello'}))
            self.assertEqual(sum(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list),1)
            self.assertEqual(bridge.call_args.args[1]['status'],'sent')

    def test_security_stops_without_retry_and_preserves_error_for_immediate_notification(self):
        issue=driver.DesktopSecurityError('安全核验','security','saved.png')
        with patch.object(driver,'ensure_owner',side_effect=issue),patch.object(driver,'bridge_call'),patch.object(driver,'control') as control:
            with self.assertRaises(driver.DesktopSecurityError):driver.deliver(None,{'uiLabel':'群'},{'id':'d','leaseId':'l','kind':'text','text':'hello'})
            control.assert_not_called();driver.review_failure.assert_not_called()
    def test_decorative_nickname_ocr_requires_a_unique_member_and_exact_native_chip(self):
        name='wangyh8216ᯤ⁶ᴳ';member={'username':'wang','name':name,'mentionNames':[name]}
        item={'text':'wangyh8216=6G','score':.95,'box':[[20,20],[100,20],[100,40],[20,40]]}
        reader=type('Reader',(),{'call':lambda *_:{'items':[item]}})()
        cases=[([member],'@'+name+'\u2005',True),([member],'@someoneelse\u2005',False),
            ([member,{'username':'other','name':'wangyh8216=6G'}],'@'+name+'\u2005',True),
            (None,'@'+name+'\u2005',False)]
        for members,copied,accepted in cases:
            with self.subTest(members=members,copied=copied),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action in ('read_composer','append_composer') else {'screenshot':'screen'}):
                before=Path(directory)/'screen.png';before.write_bytes(b'screenshot')
                current={'screen':str(before),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                if accepted:
                    self.assertEqual(driver.select_mention(reader,current,member,'lease',members=members),copied)
                else:
                    with self.assertRaises(RuntimeError):driver.select_mention(reader,current,member,'lease',members=members)
        self.assertNotEqual(driver.mention_key('Alice'),driver.mention_key('Alice2'))

    def test_incomplete_decorative_suffix_can_locate_only_one_member_and_one_popup_row(self):
        name='wangyh8216ᯤ⁶ᴳ';member={'username':'wang','name':name}
        item={'text':'wangyh8216=6','score':.95,'box':[[20,20],[100,20],[100,40],[20,40]]}
        for members,items,accepted in [([member],[item],True),
            ([member,{'username':'other','name':'wangyh82160'}],[item],True),([member],[item,item],False)]:
            with self.subTest(members=members,items=items),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':'@'+name+'\u2005'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control:
                reader=type('Reader',(),{'call':lambda *_:{'items':items}})()
                before=Path(directory)/'screen.png';before.write_bytes(b'screenshot')
                current={'screen':str(before),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                if accepted:
                    self.assertEqual(driver.select_mention(reader,current,member,'lease',members=members),'@'+name+'\u2005')
                    actions=[c.args[0] for c in control.call_args_list]
                    self.assertEqual(actions[:3],['click','screenshot','click'])
                else:
                    with self.assertRaises(RuntimeError):driver.select_mention(reader,current,member,'lease',members=members)

    def test_select_mention_clicks_only_an_exact_popup_member_and_preserves_native_chip(self):
        name='Alice';box=[[20,20],[100,20],[100,40],[20,40]]
        reader=type('Reader',(),{'call':lambda *_:{'items':[{'text':name,'score':.99,'box':box}]}})()
        with tempfile.TemporaryDirectory() as directory,patch.object(driver,'EXCHANGE',Path(directory)),\
             patch.object(driver.time,'sleep'),patch.object(driver,'control',side_effect=lambda action,args:
                 {'text':'\u2005@Alice\u2005'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control:
            before=Path(directory)/'screen.png';before.write_bytes(b'synthetic screenshot')
            current={'screen':str(before),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
            self.assertEqual(driver.select_mention(reader,current,{'username':'alice','name':name},'lease'),'@Alice\u2005')
            self.assertFalse((Path(directory)/'mention-before-lease.png').exists())
            self.assertFalse(any(action=='key' and args['key']=='Return' for action,args in (c.args for c in control.call_args_list)))

    def test_missing_or_duplicate_mention_candidates_do_not_select_or_send(self):
        for names in (['Alice2'],['Alice','Alice'],[]):
            with self.subTest(names=names),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',return_value={'screenshot':'screen'}) as control:
                reader=type('Reader',(),{'call':lambda *_:{'items':[{'text':n,'score':.99,'box':[]} for n in names]}})()
                before=Path(directory)/'screen.png';before.write_bytes(b'synthetic screenshot')
                current={'screen':str(before),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                with self.assertRaisesRegex(RuntimeError,'missing or ambiguous'):
                    driver.select_mention(reader,current,{'username':'alice','name':'Alice'},'lease')
                self.assertEqual(sum(c.args[0]=='click' for c in control.call_args_list),2,'Only baseline dismissal and editor focus are allowed')

    def test_short_mixed_script_popup_keeps_stable_identity_when_ocr_omits_one_latin_character(self):
        member={'username':'citysky9420','name':'小J'}
        # Captured from the saved recovery screenshot, without another UI action.
        item={'text':'小','score':.9999234676361084,'box':[[248,393],[275,393],[275,411],[248,411]]}
        self.assertTrue(driver.mention_candidate([item],member,[member])['requiresChipCheck'])
        roster=[member,{'username':'other','name':'小潘'},{'username':'third','name':'小西师傅'}]
        self.assertTrue(driver.mention_candidate([item],member,roster)['requiresChipCheck'])
        for roster,items in [
            ([member,{'username':'other','name':'小J'}],[{**item,'text':'小J'}]),
            ([member,{'username':'other','name':'小J'}],[item]),
            ([member],[item,item]),
        ]:
            with self.subTest(roster=roster,items=items),self.assertRaisesRegex(RuntimeError,'missing or ambiguous'):
                driver.mention_candidate(items,member,roster)
        for observed in [{**item,'score':.01},{**item,'text':'大'}]:
            self.assertTrue(driver.mention_candidate([observed],member,[member])['exactNativeName'])

    def test_short_name_ocr_fallback_still_requires_the_complete_selected_native_chip(self):
        member={'username':'citysky9420','name':'小J'}
        item={'text':'小','score':.9999,'box':[[248,393],[275,393],[275,411],[248,411]]}
        roster=[member,{'username':'other','name':'小潘'},{'username':'third','name':'小西师傅'}]
        for copied,accepted in [('@小J\u2005',True),('@小\u2005',False),('@小潘\u2005',False),('@小潘\u2005手工修改',False)]:
            with self.subTest(copied=copied),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action=='read_composer' else {'screenshot':'screen'}):
                screen=Path(directory)/'screen.png';screen.write_bytes(b'fixture')
                current={'screen':str(screen),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                reader=type('Reader',(),{'call':lambda *_:{'items':[item]}})()
                owned=driver.OwnedDraft()
                if accepted:self.assertEqual(driver.select_mention(reader,current,member,'lease',members=roster,verify=False,draft=owned),copied)
                else:
                    with self.assertRaisesRegex(RuntimeError,'could not be confirmed'):
                        driver.select_mention(reader,current,member,'lease',members=roster,verify=False,draft=owned)
                    self.assertEqual(copied in owned.expected,copied=='@小潘\u2005')

    def test_unreadable_unicode_rows_require_exact_native_chip_and_unique_full_name(self):
        separator=chr(0x2005)
        names=['🌸玲~','🚬ঞৣঁ᭄俗人💰爱财ঞৣ᭄','👩🏽‍💻','𝓐𝓵𝓲𝓬𝓮⁶ᴳ','Á小鱼','💫⭐️']
        box=[[20,20],[100,20],[100,40],[20,40]]
        for name in names:
            member={'username':'target','name':name}
            roster=[member,{'username':'other','name':'🍁玲~' if name=='🌸玲~' else '其他人'}]
            cases=[(separator+'@'+name+separator,True),('@'+name,False),('@'+name+'    ',False),
                   ('@'+name+separator+'手工修改',False),('@'+roster[1]['name']+separator,False)]
            for copied,accepted in cases:
                with self.subTest(name=name,copied=copied),tempfile.TemporaryDirectory() as directory,\
                     patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                     patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action=='read_composer' else {'screenshot':'screen'}) as control:
                    screen=Path(directory)/'screen.png';screen.write_bytes(b'fixture')
                    current={'screen':str(screen),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                    reader=type('Reader',(),{'call':lambda *_:{'items':[{'text':'???','score':.01,'box':box}]}})()
                    if accepted:
                        self.assertEqual(driver.select_mention(reader,current,member,'lease',members=roster,verify=False),'@'+name+separator)
                    else:
                        with self.assertRaisesRegex(RuntimeError,'could not be confirmed'):
                            driver.select_mention(reader,current,member,'lease',members=roster,verify=False)
                    self.assertIn('read_composer',[c.args[0] for c in control.call_args_list])
                    self.assertFalse(any(c.args[0]=='key' and c.args[1]['key']=='Return' for c in control.call_args_list))

    def test_raw_native_name_can_distinguish_symbols_but_duplicate_full_names_cannot(self):
        member={'username':'target','name':'🌸玲~'}
        item={'text':'玲','score':.01,'box':[[20,20],[100,20],[100,40],[20,40]]}
        self.assertTrue(driver.mention_candidate([item],member,[member,{'username':'other','name':'🍁玲~'}])['exactNativeName'])
        for roster,items in [([member,{'username':'other','name':'🌸玲~'}],[item]),
                ([member,{'username':'other','name':'别的名字','mentionNames':['🌸玲~']}],[item]),
                ([member],[item,item]),([member],[]),([member],[{**item,'box':[[0,0]]*4}])]:
            with self.subTest(roster=roster,items=items),self.assertRaises(RuntimeError):
                driver.mention_candidate(items,member,roster)

    def test_native_chip_can_use_the_selected_members_nickname_instead_of_the_picker_remark(self):
        reader=type('Reader',(),{'call':lambda *_:{'items':[{'text':'Manager','score':.99,'box':[[20,20],[100,20],[100,40],[20,40]]}]}})()
        for copied,accepted in [('\u2005@Alice\u2005',True),('@Bob\u2005',False),('@Alice2\u2005',False),('@Alice\u2005extra',False)]:
            with self.subTest(copied=copied),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action in ('read_composer','append_composer') else {'screenshot':'screen'}):
                before=Path(directory)/'screen.png';before.write_bytes(b'screenshot')
                current={'screen':str(before),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                if accepted:
                    self.assertEqual(driver.select_mention(reader,current,{'username':'alice','name':'Manager'},'lease',['Manager','Alice']),'@Alice\u2005')
                else:
                    with self.assertRaisesRegex(RuntimeError,'could not be confirmed'):
                        driver.select_mention(reader,current,{'username':'alice','name':'Manager'},'lease',['Manager','Alice'])

    def test_group_draft_must_contain_both_native_mention_and_reviewed_reply_before_send(self):
        mention={'username':'alice','name':'Alice'}
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        class Reader:
            def call(self,method,*_):return {'mention':mention} if method=='prepare' else {'enabled':True}
        for copied in ('hello','@Bob\u2005hello','@Alice\u2005changed'):
            with self.subTest(copied=copied),patch.object(driver,'ensure_owner',return_value=screen),\
                 patch.object(driver,'compose_is_empty',return_value=True),patch.object(driver,'select_mention',return_value='@Alice\u2005'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control,\
                 patch.object(driver,'bridge_call',return_value={}) as bridge:
                self.assertFalse(driver.deliver(Reader(),{'uiLabel':'群','kind':'group'},
                    {'id':'d','leaseId':'l','kind':'text','text':'hello','mention':mention}))
                self.assertFalse(any(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list))
                self.assertEqual(bridge.call_args.args[1]['status'],'rejected')

    def test_badwindow_during_search_is_retried_before_taking_the_screenshot(self):
        class Reader:
            def call(self,*_):return {'items':[]}
        geometry=b'X=72\nY=64\nWIDTH=880\nHEIGHT=640\n'
        with patch.object(driver,'run',side_effect=[RuntimeError('BadWindow (invalid Window parameter)'),b'123\n',geometry]) as run,\
             patch.object(driver.time,'sleep') as sleep,patch.object(driver,'control',return_value={'screenshot':'screen'}) as control:
            current=driver.view(Reader(),{'uiLabel':'管理者'})
            self.assertEqual(current['geometry'],{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640})
            self.assertEqual(run.call_count,3);sleep.assert_called_once_with(.1)
            control.assert_called_once_with('screenshot',{})

    def test_badwindow_during_geometry_lookup_discovers_a_fresh_window_id(self):
        with patch.object(driver,'run',side_effect=[b'123\n',RuntimeError('BadWindow (invalid Window parameter)'),
             b'456\n',b'X=72\nY=64\nWIDTH=880\nHEIGHT=640\n']) as run,patch.object(driver.time,'sleep'):
            self.assertEqual(driver.window_geometry()['WIDTH'],880)
            self.assertEqual(run.call_args.args[0][-1],'456')
            self.assertEqual(run.call_count,4)

    def test_persistent_badwindow_still_fails_after_three_attempts(self):
        with patch.object(driver,'run',side_effect=RuntimeError('BadWindow (invalid Window parameter)')) as run,\
             patch.object(driver.time,'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError,'BadWindow'):driver.window_geometry()
            self.assertEqual(run.call_count,3);self.assertEqual(sleep.call_count,2)

    def test_other_errors_and_ambiguous_windows_are_not_retried(self):
        for result in (RuntimeError('Cannot open display'),b'123\n456\n',b''):
            with self.subTest(result=result),patch.object(driver,'run',side_effect=[result]) as run,\
                 patch.object(driver.time,'sleep') as sleep:
                with self.assertRaises(RuntimeError):driver.window_geometry()
                run.assert_called_once();sleep.assert_not_called()

    def test_checkpoint_commits_after_ingestion_and_is_not_advanced_on_failure(self):
        class Reader:
            def call(self,*_):return {'events':[{'sourceMessageId':'one','kind':'text','text':'hi','database':{}}], 'cursor':{'watermarks':{'0':1}}}
        settings={'ownerPeerId':'owner','uiLabel':'管理者'}
        with tempfile.TemporaryDirectory() as directory,patch.object(driver,'STATE',Path(directory)):
            with patch.object(driver,'bridge_call',side_effect=RuntimeError('queue failed')):
                with self.assertRaisesRegex(RuntimeError,'queue failed'):driver.ingest(Reader(),settings)
                self.assertFalse((Path(directory)/'cursor.json').exists())
            with patch.object(driver,'bridge_call',return_value={}):
                self.assertEqual(driver.ingest(Reader(),settings),1)
                self.assertEqual(json.loads((Path(directory)/'cursor.json').read_text()),{'watermarks':{'0':1}})

    def test_missing_image_is_recorded_as_unavailable_without_blocking_other_chats(self):
        class Reader:
            def call(self,*_):return {'events':[{'unavailable':'original missing','kind':'image','text':'','database':{},'sourceMessageId':'one'}], 'cursor':{'done':1}}
        with patch.object(driver,'bridge_call',return_value={}) as bridge,patch.object(driver,'save_json') as save:
            self.assertEqual(driver.ingest(Reader(),{'ownerPeerId':'owner','uiLabel':'管理者'}),1)
            message=next(c.args[1]['messages'][0] for c in bridge.call_args_list if c.args[0]=='incoming-batch')
            self.assertEqual(message['unavailableMedia'],'image')
            self.assertNotIn('attachment',message);save.assert_called_once()

    def test_group_search_selects_the_local_group_below_its_section_not_online_suggestions(self):
        def item(text,y):return {'text':text,'score':.99,'box':[[20,y],[120,y],[120,y+20],[20,y+20]]}
        class Reader:
            def call(self,*args):return {'items':[item('搜索网络结果',0),item('离线测试群',40),item('群聊',180),item('离线测试群',220)]}
        screen={'ownerVisible':False,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
        with patch.object(driver,'view',side_effect=[screen,{**screen,'ownerVisible':True}]),patch.object(driver,'control') as control:
            driver.ensure_owner(Reader(),{'uiLabel':'离线测试群','kind':'group'},'lease')
            action,args=control.call_args.args
            self.assertEqual(action,'click');self.assertEqual(args['y'],374)

    def test_internal_group_id_is_not_used_as_a_gui_search_query(self):
        with patch.object(driver,'control') as control,patch.object(driver,'view') as view:
            with self.assertRaisesRegex(RuntimeError,'Group display title'):
                driver.ensure_owner(None,{'uiLabel':'123@chatroom','kind':'group'},'lease')
            control.assert_not_called();view.assert_not_called()

    def test_group_title_ocr_omissions_and_search_ellipsis_require_one_known_room(self):
        label='漫步者-徐、🌸玲~'
        target={'kind':'group','username':'room@chatroom','uiLabel':label}
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'bridge.json'
            config.write_text(json.dumps({'contacts':[target]}))
            with patch.object(driver,'BRIDGE_CONFIG',config):
                self.assertTrue(driver.conversation_label_matches('漫步者-徐、玲~(3)',target))
                self.assertTrue(driver.conversation_label_matches('漫步者-徐、…',target,search=True))
                self.assertFalse(driver.conversation_label_matches('漫步者-徐、…',target))
                self.assertFalse(driver.conversation_label_matches('漫步者-徐、其他人',target,search=True))
                config.write_text(json.dumps({'contacts':[target,{**target,'username':'other@chatroom','uiLabel':'漫步者-徐、🍁玲~'}]}))
                self.assertFalse(driver.conversation_label_matches('漫步者-徐、玲~(3)',target))
                self.assertFalse(driver.conversation_label_matches('漫步者-徐、…',target,search=True))

    def test_unnamed_group_search_opens_unique_truncated_local_result_then_checks_full_title(self):
        def item(text,y):return {'text':text,'score':.99,'box':[[20,y],[280,y],[280,y+20],[20,y+20]]}
        target={'kind':'group','username':'room@chatroom','uiLabel':'漫步者-徐、🌸玲~'}
        reader=type('Reader',(),{'call':lambda *_:{'items':[item('搜索网络结果',0),item(target['uiLabel'],40),item('群聊',100),item('漫步者-徐、…',140)]}})()
        screen={'ownerVisible':False,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
        with tempfile.TemporaryDirectory() as directory:
            config=Path(directory)/'bridge.json';config.write_text(json.dumps({'contacts':[target]}))
            with patch.object(driver,'BRIDGE_CONFIG',config),patch.object(driver,'view',side_effect=[screen,{**screen,'ownerVisible':True}]),patch.object(driver,'control') as control:
                driver.ensure_owner(reader,target,'lease')
                self.assertEqual(control.call_args.args[1]['y'],294)
                self.assertIn(('paste_text',{'capture':False,'text':target['uiLabel'],'leaseId':'lease'}),[c.args for c in control.call_args_list])

    def test_web_suggestion_after_contact_heading_is_not_a_second_contact(self):
        def item(text,y):return {'text':text,'score':.99,'box':[[20,y],[120,y],[120,y+20],[20,y+20]]}
        class Reader:
            def call(self,*args):return {'items':[item('联系人',0),item('管理者_fixture_owner',48),item('搜索网络结果',99),item('管理者_fixture_owner',129)]}
        screen={'ownerVisible':False,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
        with patch.object(driver,'view',side_effect=[screen,{**screen,'ownerVisible':True}]),patch.object(driver,'control') as control:
            driver.ensure_owner(Reader(),{'uiLabel':'管理者_fixture_owner'},'lease')
            action,args=control.call_args.args
            self.assertEqual(action,'click');self.assertEqual(args['y'],202)

    def test_uncertain_database_confirmation_never_repeats_a_send(self):
        class Reader:
            def call(self,method,*_):
                if method=='verify':raise RuntimeError('confirmation timed out')
                return {'enabled':True}
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        delivery={'id':'d','leaseId':'l','kind':'text','text':'hello'}
        controls=[];receipts=[]
        def control(action,args):
            controls.append((action,args));return {'text':'hello'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'compose_is_empty',return_value=True),\
             patch.object(driver,'view',return_value=screen),patch.object(driver,'control',side_effect=control),\
             patch.object(driver,'bridge_call',side_effect=lambda a,b:receipts.append((a,b))):
            with self.assertRaisesRegex(RuntimeError,'confirmation timed out'):driver.deliver(Reader(),{'uiLabel':'管理者'},delivery)
        sends=[args for action,args in controls if action=='click' and args.get('x')==907]
        self.assertEqual(len(sends),1);self.assertEqual(receipts[-1][1]['status'],'uncertain')

    def test_existing_draft_is_preserved_and_never_overwritten(self):
        screen={'ownerVisible':True,'geometry':{}}
        delivery={'id':'d','leaseId':'l','kind':'text','text':'hello'}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'compose_is_empty',return_value=False),\
             patch.object(driver,'control') as control,patch.object(driver,'bridge_call',return_value={}) as bridge:
            self.assertFalse(driver.deliver(None,{'uiLabel':'管理者'},delivery))
            control.assert_not_called();self.assertEqual(bridge.call_args.args[1]['status'],'rejected')

    def test_delayed_server_confirmation_uses_the_existing_lease_and_never_clicks_send_twice(self):
        clock={'now':0}
        class Reader:
            def __init__(self):self.checks=0
            def call(self,method,*_):
                if method=='verify':
                    self.checks+=1
                    clock['now']=35 if self.checks==1 else 40
                    return {'pending':True} if self.checks==1 else {'database':{'serverId':'123'}}
                return {'enabled':True}
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'compose_is_empty',return_value=True),\
             patch.object(driver,'view',return_value=screen),patch.object(driver,'bridge_call') as bridge,\
             patch.object(driver,'control',side_effect=lambda action,args:{'text':'hello'} if action in ('read_composer','append_composer') else {'screenshot':'screen'}) as control,\
             patch.object(driver.time,'time',return_value=21),patch.object(driver.time,'sleep'),\
             patch.object(driver.time,'monotonic',side_effect=lambda:clock['now']):
            driver.deliver(Reader(),{'uiLabel':'管理者'},{'id':'d','leaseId':'l','leaseUntil':90000,'kind':'text','text':'hello'})
            self.assertEqual(bridge.call_args.args[1]['status'],'sent')
            self.assertEqual(sum(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list),1)


class IndependentReceiverTests(unittest.TestCase):
    def test_vision_and_database_calls_have_independent_services(self):
        calls=[]
        class Service:
            def __init__(self,name):self.name=name
            def call(self,method,args,timeout):calls.append((self.name,method));return {}
        services=driver.ReaderServices(Service('database'),Service('vision'))
        for method in ('poll','ocr','prepare','green','verify'):services.call(method)
        self.assertEqual(calls,[('database','poll'),('vision','ocr'),('database','prepare'),('vision','green'),('database','verify')])

    def test_receiver_keeps_reading_while_ui_is_busy(self):
        import threading,queue
        state=threading.Event()
        class Stop:
            def is_set(self):return state.is_set()
            def set(self):state.set()
            def wait(self,timeout):return state.wait(min(timeout,.005))
        reads=[]
        def ingest(*_):
            reads.append(len(reads))
            if len(reads)==3:state.set()
            return 0
        with patch.object(driver,'ingest',side_effect=ingest),patch.object(driver,'ingest_media'):
            worker=threading.Thread(target=driver.receive_loop,args=(object(),{},Stop(),queue.Queue()))
            worker.start()
            # Represents an independent foreground UI operation waiting on OCR.
            worker.join(timeout=.3)
        self.assertFalse(worker.is_alive());self.assertEqual(len(reads),3)


class GroupDraftRegressionTests(unittest.TestCase):
    def test_ellipsized_chinese_picker_label_requires_unique_identity_and_full_native_chip(self):
        name='漫步者-飞利浦-联想-惠普影音-徐'
        member={'username':'target','name':name}
        box=[[20,20],[180,20],[180,40],[20,40]]
        for label,members,copied,accepted in [
            ('漫步者-飞利浦-联...',[member],'@'+name+'\u2005',True),
            ('漫步者-飞利浦-联…',[member],'@'+name+'\u2005',True),
            ('漫步者-飞利浦-联...',[member,{'username':'other','name':'漫步者-飞利浦-联想-另一个人'}],'@'+name+'\u2005',True),
            ('漫步者-飞利浦-联...',[member],'@另一个人\u2005',False),
            ('漫步者-飞利浦-联',[member],'@'+name+'\u2005',True),
            ('漫步...',[member],'@'+name+'\u2005',True),
        ]:
            with self.subTest(label=label,members=members,copied=copied),tempfile.TemporaryDirectory() as directory,\
                 patch.object(driver,'EXCHANGE',Path(directory)),patch.object(driver.time,'sleep'),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':copied} if action=='read_composer' else {'screenshot':'screen'}):
                image=Path(directory)/'screen.png';image.write_bytes(b'fixture')
                current={'screen':str(image),'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}}
                reader=type('Reader',(),{'call':lambda *_:{'items':[{'text':label,'score':.99,'box':box}]}})()
                if accepted:self.assertEqual(driver.select_mention(reader,current,member,'lease',members=members),copied)
                else:
                    with self.assertRaises(RuntimeError):driver.select_mention(reader,current,member,'lease',members=members)

    def test_failed_picker_removes_only_its_own_exact_input_and_preserves_changed_text(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        mention={'username':'target','name':'长昵称'}
        for edited in (False,True):
            state={'text':''};actions=[]
            def select(*args,**kwargs):
                kwargs['draft'].expect(['@长昵称'])
                state['text']='人工补充的草稿' if edited else '@长昵称'
                raise RuntimeError('Exact @ member candidate is missing or ambiguous')
            def control(action,args):
                actions.append(action)
                if action=='clear_composer':
                    matches=state['text'] in args['expected']
                    if matches:state['text']=''
                    return {'text':state['text'],'cleared':matches}
                return {}
            reader=type('Reader',(),{'call':lambda *_:{'mention':mention}})()
            with self.subTest(edited=edited),patch.object(driver,'ensure_owner',return_value=screen),\
                 patch.object(driver,'compose_is_empty',side_effect=lambda *_:not state['text']),\
                 patch.object(driver,'select_mention',side_effect=select),patch.object(driver,'control',side_effect=control),\
                 patch.object(driver,'review_failure',return_value=screen),patch.object(driver,'bridge_call',return_value={}) as bridge:
                self.assertFalse(driver.deliver(reader,{'uiLabel':'群','kind':'group'},
                    {'id':'d','leaseId':'l','kind':'text','text':'已经审核的回复','mention':mention}))
            self.assertEqual(state['text'],'人工补充的草稿' if edited else '')
            self.assertNotIn('append_composer',actions)
            self.assertEqual(bridge.call_args.args[1]['status'],'rejected')

    def test_group_sends_after_one_final_combined_native_chip_and_text_verification(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        mention={'username':'alice','name':'Manager'}
        class Reader:
            def call(self,method,*_):
                if method=='prepare':return {'mention':mention,'mentionNames':['Manager','Alice']}
                if method=='verify':return {'database':{'serverId':'123'}}
                return {'enabled':True}
        with patch.object(driver,'ensure_owner',return_value=screen),patch.object(driver,'compose_is_empty',return_value=True),\
             patch.object(driver,'view',return_value=screen),patch.object(driver,'select_mention') as select,\
             patch.object(driver,'bridge_call',return_value={}) as bridge,\
             patch.object(driver,'control',side_effect=lambda action,args:{'text':'\u2005@Alice\u2005hello'} if action=='append_composer' else {'screenshot':'screen'}) as control:
            self.assertTrue(driver.deliver(Reader(),{'uiLabel':'群','kind':'group'},
                {'id':'d','leaseId':'l','kind':'text','text':'hello','mention':mention}))
        self.assertFalse(select.call_args.kwargs['verify'])
        self.assertEqual(sum(c.args[0]=='append_composer' for c in control.call_args_list),1)
        self.assertEqual(sum(c.args[0]=='read_composer' for c in control.call_args_list),0)
        self.assertEqual(sum(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list),1)
        self.assertEqual(bridge.call_args.args[1]['status'],'sent')

    def test_delivery_uses_renamed_member_from_prepare_but_rejects_a_different_account(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        requested={'username':'alice','name':'Old long name'}
        for username,accepted in [('alice',True),('bob',False)]:
            mention={'username':username,'name':'小J'};roster=[mention]
            class Reader:
                def call(self,method,*_):
                    if method=='prepare':return {'mention':mention,'mentionNames':['小J'],'mentionMembers':roster}
                    if method=='verify':return {'database':{'serverId':'123'}}
                    return {'enabled':True}
            with self.subTest(username=username),patch.object(driver,'ensure_owner',return_value=screen),\
                 patch.object(driver,'compose_is_empty',return_value=True),patch.object(driver,'view',return_value=screen),\
                 patch.object(driver,'select_mention') as select,patch.object(driver,'bridge_call',return_value={}),\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':'@小J\u2005hello'} if action=='append_composer' else {'screenshot':'screen'}) as control:
                self.assertEqual(driver.deliver(Reader(),{'uiLabel':'群','kind':'group'},
                    {'id':'d','leaseId':'l','kind':'text','text':'hello','mention':requested}),accepted)
                if accepted:
                    self.assertEqual(select.call_args.args[2],mention)
                    self.assertEqual(select.call_args.args[5],roster)
                else:select.assert_not_called()
                self.assertEqual(sum(c.args[0]=='click' and c.args[1].get('x')==907 for c in control.call_args_list),int(accepted))

    def test_ready_queue_drains_without_fixed_sleep_or_duplicate_health_scan(self):
        from contextlib import nullcontext
        health={'last':0,'failures':0};delivery={'id':'d'}
        def send(_reader,_settings,_delivery,state):
            self.assertIs(state,health)
            state['last']=100
            return True
        with patch.object(driver,'bridge_call',side_effect=[{'outgoing':[{'status':'queued','count':2}]},{'delivery':delivery}]),\
             patch.object(driver,'ui_session',return_value=nullcontext(True)),patch.object(driver,'deliver',side_effect=send),\
             patch.object(driver,'view') as view,patch.object(driver.time,'monotonic',return_value=100):
            self.assertEqual(driver.send_cycle(None,{},health),0)
        view.assert_not_called()

    def test_idle_security_check_starts_early_and_uses_capture_time_not_ocr_finish(self):
        from contextlib import nullcontext
        health={'last':100,'failures':0}
        with patch.object(driver,'bridge_call',return_value={'outgoing':[]}),\
             patch.object(driver,'ui_session',side_effect=lambda **_:nullcontext(True)),\
             patch.object(driver,'view',return_value={'fullInspection':True,'capturedAt':120,'timing':{'fullOcrMs':8000}}) as view,\
             patch.object(driver.time,'monotonic',return_value=119):
            self.assertEqual(driver.send_cycle(None,{},health),.2);view.assert_not_called()
            with patch.object(driver.time,'monotonic',return_value=128):driver.send_cycle(None,{},health)
        view.assert_called_once_with(None,{},full=True)
        self.assertEqual(health['last'],120)

    def test_target_lookup_uses_only_header_and_does_not_ocr_another_chats_full_history(self):
        calls=[]
        class Reader:
            def call(self,method,args):
                calls.append(args)
                return {'items':[{'text':'另一个群','score':.99,'box':[[5,5],[105,5],[105,25],[5,25]]}],
                    'cacheHit':True,'elapsedMs':0.2,'_rpcTiming':{'lockWaitMs':2,'rpcMs':3}}
        with patch.object(driver,'window_geometry',return_value={'X':72,'Y':64,'WIDTH':880,'HEIGHT':640}),\
             patch.object(driver,'control',return_value={'screenshot':'screen'}):
            result=driver.view(Reader(),{'uiLabel':'目标群','kind':'group'},header_only=True)
        self.assertFalse(result['ownerVisible']);self.assertFalse(result['fullInspection'])
        self.assertEqual(len(calls),1);self.assertIn('rect',calls[0])
        self.assertEqual(result['timing']['ocrCacheHits'],1)
        self.assertEqual(result['timing']['ocrLockWaitMs'],2)

    def test_send_reuses_fresh_security_result_and_expired_result_still_requires_full_check(self):
        screen={'ownerVisible':True,'geometry':{'X':72,'Y':64,'WIDTH':880,'HEIGHT':640},'sendButtons':[(907,673)]}
        class Reader:
            def call(self,*_):return {'enabled':True}
        for checked,full in [(110,False),(99,True)]:
            health={'last':checked,'failures':0}
            with self.subTest(checked=checked),patch.object(driver,'ensure_owner',return_value=screen),\
                 patch.object(driver,'compose_is_empty',return_value=True),\
                 patch.object(driver,'view',return_value={**screen,'fullInspection':full,'capturedAt':130}) as view,\
                 patch.object(driver,'control',side_effect=lambda action,args:{'text':'hello'} if action=='append_composer' else {}),\
                 patch.object(driver,'confirm_delivery',return_value={'verifyChecks':1}),\
                 patch.object(driver.time,'monotonic',return_value=130):
                self.assertTrue(driver.deliver(Reader(),{'uiLabel':'群'},
                    {'id':'d','leaseId':'l','kind':'text','text':'hello'},health))
                if full:view.assert_called_once_with(unittest.mock.ANY,{'uiLabel':'群'},full=True)
                else:view.assert_called_once_with(unittest.mock.ANY,{'uiLabel':'群'})
                self.assertEqual(health['last'],130 if full else checked)


class ClipboardRegressionTests(unittest.TestCase):
    def execute_composer(self,action,composer,clipboard,**args):
        # Execute the actual embedded script with fake X11 commands. An empty
        # selection deliberately leaves the clipboard unchanged, as WeChat does.
        import ast,io,types
        from contextlib import redirect_stdout
        tree=ast.parse((Path(__file__).resolve().parents[1]/'desktop/wechat_gui.py').read_text())
        source=next(node.value.value for node in ast.walk(tree) if isinstance(node,ast.Assign)
            and isinstance(node.value,ast.Constant) and isinstance(node.value.value,str)
            and "sentinel='ruanruan-composer-'" in node.value.value)
        state={'composer':composer,'clipboard':clipboard,'owner':None}
        class Owner:
            def __init__(self,*_,**__):
                previous=state['owner']
                if previous and previous.alive:raise AssertionError('Clipboard owners overlapped')
                self.alive=True;state['owner']=self
                self.stdin=types.SimpleNamespace(write=lambda value:state.update(clipboard=value.decode()),close=lambda:None)
            def poll(self):return None if self.alive else 0
            def terminate(self):self.alive=False
            def wait(self,**_):return 0
        def run(command,**_):
            for key in command[3:]:
                if key=='ctrl+c' and state['composer']:
                    state['clipboard']=state['composer'];state['owner'].alive=False
                elif key=='ctrl+v':state['composer']+=state['clipboard']
                elif key=='BackSpace':state['composer']=''
        subprocess=types.SimpleNamespace(Popen=Owner,run=run,PIPE=-1,DEVNULL=-2,
            check_output=lambda *_,**__:state['clipboard'].encode())
        output=io.StringIO()
        request={'action':action,'text':'','expected':[],**args}
        with patch.dict(sys.modules,{'subprocess':subprocess,'time':types.SimpleNamespace(sleep=lambda _:None)}),\
             patch.object(sys,'stdin',io.StringIO(json.dumps(request))),redirect_stdout(output):
            exec(compile(source,'composer-fixture','exec'),{})
        self.assertFalse(state['owner'].alive)
        return json.loads(output.getvalue()),state['composer']

    def test_empty_composer_does_not_reuse_previous_clipboard_text(self):
        result,text=self.execute_composer('read_composer','','stale previous draft')
        self.assertEqual(result,{'text':''});self.assertEqual(text,'')

    def test_clear_confirms_empty_even_when_copy_empty_does_not_change_clipboard(self):
        result,text=self.execute_composer('clear_composer','@本次昵称','stale',expected=['@本次昵称'])
        self.assertEqual(result,{'text':'','cleared':True});self.assertEqual(text,'')

    def test_foreign_draft_is_read_exactly_and_not_cleared(self):
        result,text=self.execute_composer('clear_composer','人工改过的草稿','@本次昵称',expected=['@本次昵称'])
        self.assertEqual(result,{'text':'人工改过的草稿','cleared':False});self.assertEqual(text,'人工改过的草稿')

    def test_paste_owner_finishes_before_sentinel_copy_owner_is_created(self):
        result,text=self.execute_composer('append_composer','@Alice\u2005','old clipboard',text='你好')
        self.assertEqual(result,{'text':'@Alice\u2005你好'});self.assertEqual(text,'@Alice\u2005你好')


if __name__=='__main__':unittest.main()
