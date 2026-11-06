"""Synthetic database rows only: no WeChat process, source database or models."""
import importlib.util
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import patch, Mock
try:
    from PIL import Image, ImageDraw
    import numpy
    HAS_IMAGE_DEPS=True
except ImportError:
    HAS_IMAGE_DEPS=False

# Reader dependencies are private-container packages. Stub their import boundary;
# exercise our actual routing, checkpoint and mention parser with fake DB rows.
modules={}
for name in ['wechat_ai_bot.models','wechat_ai_bot.services.core.linux_database_service',
             'wechat_ai_bot.weixin.message_content','wechat_ai_bot.rpa.rpa_action','wechat_ai_bot.rpa.send_verifier']:
    modules[name]=types.ModuleType(name)
modules['wechat_ai_bot.models'].UserInfo=lambda **kw:types.SimpleNamespace(**kw)
modules['wechat_ai_bot.services.core.linux_database_service'].LinuxDatabaseService=object
modules['live_database']=types.ModuleType('live_database')
modules['live_database'].LiveDatabaseService=object
modules['wechat_ai_bot.weixin.message_content'].message_content_text=lambda value,*_:value.decode() if isinstance(value,bytes) else (value or '')
modules['wechat_ai_bot.weixin.message_content'].chat_message_text=lambda value,*_,**kw:value
modules['wechat_ai_bot.rpa.rpa_action'].RPAActionType=types.SimpleNamespace(SEND_TEXT_MESSAGE=1,SEND_FILE=2)
class StubSendVerifier:
    def verify(self,action):
        matches=[row for row in self.rows if self._matches(action,row)]
        row=matches[0]
        return {'server_id':str(row[1]),'local_id':int(row[0])}
    def _matches(self,action,row):return row[12]==action.content
modules['wechat_ai_bot.rpa.send_verifier'].SendVerifier=StubSendVerifier
spec=importlib.util.spec_from_file_location('private_reader',Path(__file__).resolve().parents[1]/'desktop/db-worker/rpc.py')
reader_module=importlib.util.module_from_spec(spec)
with patch.dict(sys.modules,modules):spec.loader.exec_module(reader_module)

class ReaderTests(unittest.TestCase):
    def setUp(self):
        # The upstream parser lives only in the reader image. Individual voice
        # fixtures supply its result; all other fake media has no transcript.
        parser=patch.object(reader_module,'native_voice_transcript',return_value='')
        parser.start();self.addCleanup(parser.stop)

    def test_recovery_restores_exact_watermark_without_prepare_or_ui_action(self):
        r=reader_module.Reader();r.binding=lambda:{'selfUsername':'self'}
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),
            get_contact_by_username=lambda target:types.SimpleNamespace(username=target))
        checkpoint={'version':1,'binding':r.binding(),'target':'room@chatroom','sender':'self',
            'kind':'text','text':'original','mention':{'username':'alice','name':'Alice'},
            'mentionNames':['Alice'],'watermarks':{'original.db':41},'startedAt':100,'attemptedAt':101,'fileMd5':''}
        verifier=Mock();r.verify=Mock(return_value={'database':{'serverId':'123'}})
        with patch.object(reader_module,'DesktopSendVerifier',return_value=verifier):
            self.assertEqual(r.reconcile(checkpoint),{'database':{'serverId':'123'}})
        verifier.prepare.assert_not_called()
        self.assertEqual(verifier.watermarks,{'original.db':41})
        self.assertEqual(verifier.started_at,100);self.assertEqual(verifier.latest_at,221)
        self.assertEqual(r.action.content,'original');self.assertEqual(r.action.at_user_username,'alice')
        r.verify.assert_called_once_with(wait=False)

    def test_recovery_rejects_changed_binding_sender_or_missing_original_watermark(self):
        r=reader_module.Reader();r.binding=lambda:{'selfUsername':'self'}
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),get_contact_by_username=lambda _:object())
        checkpoint={'version':1,'binding':r.binding(),'target':'room','sender':'self','kind':'text',
            'text':'hi','watermarks':{'original.db':3},'startedAt':100,'attemptedAt':101,'mentionNames':[]}
        for changes in ({'binding':{}},{'sender':'other'},{'watermarks':None},
                        {'watermarks':{'original.db':-1}},{'attemptedAt':99},{'startedAt':float('nan')},
                        {'kind':'image','fileMd5':''},{'mention':{'name':'Alice'}}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):r.reconcile({**checkpoint,**changes})

    def audio_reader(self):
        r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'}
        r.db=Mock();r.db.get_all_db_files.return_value=[Path('/data/db_storage/message/media_0.db'),Path('/data/db_storage/message/message_0.db')]
        row=[None]*18;row[0]=12;row[1]=123;row[2]=34;row[5]=1000
        proof={'serverId':'123','conversationUsername':'room@chatroom','shard':'message/message_0.db','text':'voice XML'}
        return r,row,proof

    def test_native_voice_transcript_uses_original_source_without_audio_decode(self):
        r,row,proof=self.audio_reader()
        with patch.object(reader_module,'native_voice_transcript',return_value='别转给小张'),patch.object(reader_module,'decode_voice') as decode:
            result=r.audio_content(row,proof)
        self.assertEqual(result['media']['status'],'available')
        transcript=result['media']['transcript'];self.assertEqual(transcript['rawText'],'别转给小张')
        self.assertEqual(transcript['source'],'wechat');self.assertIsNone(transcript['confidence'])
        self.assertEqual(transcript['sourceId'],'db:self_abcd:room@chatroom:message/message_0.db:12')
        decode.assert_not_called();r.db.execute_query.assert_not_called()

    def test_voice_bytes_are_bound_to_original_conversation_server_id_and_time(self):
        r,row,proof=self.audio_reader();r.db.execute_query.return_value=[(b'original silk',)]
        with patch.object(reader_module,'native_voice_transcript',return_value=''),             patch.object(reader_module.Path,'exists',return_value=False),patch.object(reader_module,'decode_voice',return_value=12.5) as decode:
            result=r.audio_content(row,proof)
        query=r.db.execute_query.call_args
        self.assertEqual(query.args[2],('123','room@chatroom',1000,10*1024*1024))
        self.assertIn('n.rowid=v.chat_name_id',query.args[1]);self.assertIn("v.data_index='0'",query.args[1])
        decode.assert_called_once();self.assertEqual(decode.call_args.args[0],b'original silk')
        self.assertEqual(result['media']['durationSeconds'],12.5)
        self.assertEqual(result['media']['localPath'],result['attachmentPath'])
        self.assertEqual(result['kind'],'audio')

    def test_missing_or_ambiguous_original_voice_never_picks_another_record(self):
        r,row,proof=self.audio_reader()
        with patch.object(reader_module,'native_voice_transcript',return_value=''),patch.object(reader_module,'decode_voice') as decode:
            r.db.execute_query.return_value=[]
            self.assertEqual(r.audio_content(row,proof)['media']['status'],'pending')
            r.db.execute_query.return_value=[(b'first',),(b'different',)]
            with self.assertRaisesRegex(RuntimeError,'Ambiguous'):r.audio_content(row,proof)
        decode.assert_not_called()

    def test_voice_decoder_uses_bounded_local_child_and_validates_wav_duration(self):
        import io,wave
        with tempfile.TemporaryDirectory() as directory:
            output=Path(directory)/'voice.wav'
            def decode(command,**kw):
                self.assertEqual(kw['timeout'],10);self.assertTrue(kw['check'])
                self.assertEqual(command[-2].endswith('voice.silk'),True)
                Path(command[-1]).write_bytes(b'\0\0'*16000)
                return Mock(returncode=0)
            with patch('subprocess.run',side_effect=decode) as command:
                self.assertEqual(reader_module.decode_voice(b'\x02#!SILK_V3fixture',output),1)
            with wave.open(str(output)) as stream:
                self.assertEqual(stream.getframerate(),16000);self.assertEqual(stream.getnchannels(),1)
            self.assertFalse(list(Path(directory).glob('voice-decode-*')))
            with self.assertRaisesRegex(ValueError,'Unsupported'):reader_module.decode_voice(b'unknown',output)

    def test_restart_does_not_seed_new_group_messages_as_background(self):
        own=types.SimpleNamespace(username='self',alias='role')
        owner=types.SimpleNamespace(username='owner',alias='ownerid',remark='测试哥',is_chatroom=False)
        group=types.SimpleNamespace(username='room@chatroom',is_chatroom=True)
        settings={'accountDirectory':'self_abcd','accountWechatId':'role','ownerWechatId':'ownerid','uiLabel':'测试哥'}
        path=Path('/fake/message.db')
        def row(n):
            value=[None]*18;value[0]=n;value[17]=path;return value
        db=types.SimpleNamespace(setup=lambda:None,is_available=True,user_info=types.SimpleNamespace(account='self'),
            get_contact_by_username=lambda _:own,_contact_by_username={'owner':owner},
            get_messages_by_username=lambda *a,**k:[row(6),row(5)],_max_local_id=lambda *a:6)
        r=reader_module.Reader();r.shards=lambda _:[(path,'messages')];r.shard_name=lambda _:'message.db'
        def refresh():r.chats={'room@chatroom':group};r.routes={}
        r.refresh_routes=refresh;r.make_event=lambda value,chat,baseline=False:{'localId':value[0],'contextOnly':baseline}
        binding={**{k:settings[k] for k in ('accountDirectory','accountWechatId','ownerWechatId')},'selfUsername':'self','ownerUsername':'owner'}
        cursor={'version':2,'binding':binding,'since':1000,'multiSince':1000,'watermarks':{'room@chatroom:message.db':5},'contextRooms':[]}
        with patch.object(reader_module,'LinuxDatabaseService',return_value=db):
            result=r.initialize(settings,cursor)
            self.assertEqual(result['baselineEvents'],[{'localId':5,'contextOnly':True}])
            self.assertEqual(result['cursor']['watermarks']['room@chatroom:message.db'],5)
            initial=reader_module.Reader();initial.shards=r.shards;initial.shard_name=r.shard_name
            initial.refresh_routes=lambda:(setattr(initial,'chats',{'room@chatroom':group}),setattr(initial,'routes',{}))
            initial.make_event=r.make_event
            first=initial.initialize(settings)
            self.assertEqual([e['localId'] for e in first['baselineEvents']],[5,6])
            self.assertEqual(first['cursor']['watermarks']['room@chatroom:message.db'],6)

    def test_native_red_packet_keeps_greeting_but_does_not_claim_receipt_or_expose_payment_urls(self):
        from xml.etree import ElementTree
        card=ElementTree.fromstring('''<appmsg><type>2001</type><title>微信红包</title><wcpayinfo>
          <receivertitle>恭喜发财，大吉大利</receivertitle><receiverdes>领取红包</receiverdes>
          <nativeurl>secret-payment-url</nativeurl><paymsgid>secret-payment-id</paymsgid>
          <total_fee>9999</total_fee></wcpayinfo></appmsg>''')
        result=reader_module.payment_card(card)
        self.assertEqual(result['payment']['kind'],'red_packet')
        self.assertEqual(result['payment']['receipt'],'unconfirmed')
        self.assertIsNone(result['payment']['amountText'])
        self.assertIn('恭喜发财，大吉大利',result['displayText'])
        self.assertIn('领取结果未确认，金额未知',result['displayText'])
        self.assertNotIn('secret-',str(result));self.assertNotIn('9999',str(result))

    def test_payment_type_is_not_inferred_from_words_or_links_and_transfers_stay_separate(self):
        from xml.etree import ElementTree
        for xml in ['<appmsg><type>5</type><title>微信红包</title></appmsg>',
                    '<appmsg><type>2001</type><title>微信红包</title></appmsg>']:
            self.assertIsNone(reader_module.payment_card(ElementTree.fromstring(xml)))
        transfer=reader_module.payment_card(ElementTree.fromstring(
            '<appmsg><type>2000</type><wcpayinfo><feedesc>￥10.00</feedesc></wcpayinfo></appmsg>'))
        self.assertEqual(transfer['payment']['kind'],'transfer')
        self.assertEqual(transfer['payment']['amountText'],'￥10.00')
        self.assertIn('收款结果未确认',transfer['displayText'])

    def test_real_card_shape_survives_private_and_group_event_conversion(self):
        r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'};r.owner=types.SimpleNamespace(username='owner')
        actor=types.SimpleNamespace(username='alice',display_name='Alice')
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),get_contact_by_sender_id=lambda *_:actor,get_contact_in_room=lambda *_:actor)
        r.shard_name=lambda _:'message/message_0.db';r.route=lambda _:{}
        row=[None]*18;row[0]=12;row[1]=567;row[2]=(2001<<32)|49;row[4]=1;row[5]=1000;row[11]='';row[17]='path'
        row[12]='<msg><appmsg><type><![CDATA[2001]]></type><title>微信红包</title><wcpayinfo><receivertitle>谢谢啦</receivertitle></wcpayinfo></appmsg></msg>'
        for group in (False,True):
            chat=types.SimpleNamespace(username='room@chatroom' if group else 'alice',display_name='Alice',is_chatroom=group)
            event=r.make_event(row,chat)
            self.assertEqual(event['kind'],'text');self.assertEqual(event['database']['payment']['kind'],'red_packet')
            self.assertIn('谢谢啦',event['text']);self.assertTrue(event['sourceMessageId'].endswith(':12'))

    def test_bad_image_is_recorded_as_unknown_without_stopping_the_next_text(self):
        r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'}
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),get_contact_in_room=lambda *_:None)
        r.route=lambda *_:{}
        r.proof=lambda row,*_:{'senderUsername':'alice','conversationUsername':'r@chatroom','serverId':str(row[0]+10),'shard':'message_0.db','text':'hello'}
        r.media=Mock(side_effect=RuntimeError('WXGF conversion requires ffmpeg'))
        chat=types.SimpleNamespace(username='r@chatroom',is_chatroom=True)
        image=r.make_event([1,None,3],chat);text=r.make_event([2,None,1],chat)
        self.assertIn('unavailable',image);self.assertEqual(text['text'],'hello');self.assertNotIn('unavailable',text)
        self.assertEqual(image['media']['status'],'pending')
        r.media.assert_not_called()
        self.assertIn(image['sourceMessageId'],r.pending_media)

    def test_quote_preserves_original_identity_and_uses_picture_label_instead_of_xml(self):
        r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'};r.owner=types.SimpleNamespace(username='owner')
        actor=types.SimpleNamespace(username='alice',display_name='Alice')
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),get_contact_by_sender_id=lambda *_:actor,get_contact_in_room=lambda *_:actor)
        r.shard_name=lambda _:'message/message_0.db';r.route=lambda _:{}
        row=[None]*18;row[0]=12;row[1]=567;row[2]=49;row[4]=1;row[5]=1000;row[11]='';row[17]='path'
        row[12]='<msg><appmsg><title>看看这张图</title><refermsg><type>3</type><svrid>123</svrid><fromusr>room@chatroom</fromusr><chatusr>alice</chatusr><displayname>Alice</displayname><content>&lt;img secret="hidden"/&gt;</content></refermsg></appmsg></msg>'
        original=list(row);original[0]=1;original[1]=123;original[2]=3;original[12]='<img secret="hidden"/>'
        r.find_message=Mock(return_value=original);r.media=Mock(return_value={})
        chat=types.SimpleNamespace(username='room@chatroom',is_chatroom=True)
        event=r.make_event(row,chat);ref=event['replyTo']
        self.assertEqual(event['text'],'看看这张图');self.assertEqual(ref['text'],'[图片]')
        self.assertEqual(ref['serverId'],'123');self.assertEqual(ref['actorId'],'alice')
        self.assertTrue(ref['sourceId'].endswith(':1'));self.assertEqual(ref['media']['status'],'pending')
        self.assertEqual(ref['sourceId'],ref['media']['sourceId']);r.media.assert_not_called()
        self.assertIn(event['sourceMessageId'],r.pending_media)
        r.find_message.assert_called_once_with('room@chatroom',server_id='123')
        r.find_message.return_value=None
        self.assertEqual(r.make_event(row,chat)['replyTo']['media']['status'],'pending')

    def test_media_resolution_is_bound_to_account_conversation_and_original_occurrence(self):
        r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'};r.chats={'room@chatroom':object()}
        r.find_message=Mock(return_value=['original']);r.make_event=Mock(return_value={'sourceMessageId':'same'})
        source='db:self_abcd:room@chatroom:message/message_0.db:12'
        self.assertEqual(r.resolve_media(source),{'sourceMessageId':'same'})
        r.find_message.assert_called_once_with('room@chatroom',local_id='12',shard='message/message_0.db')
        for invalid in (source.replace('self_abcd','other'),source.replace('room@chatroom','other@chatroom')):
            with self.assertRaises(ValueError):r.resolve_media(invalid)

    def test_broken_original_uses_real_thumbnail_and_group_cache_identity(self):
        decrypt=types.ModuleType('wechat_ai_bot.services.core.wechat_dat')
        derive=types.ModuleType('wechat_ai_bot.services.core.wechat_dat_key_discovery')
        present=types.ModuleType('wechat_ai_bot.services.core.wechat_image')
        decrypt.decrypt_dat_file=Mock(side_effect=[RuntimeError('original pending'),b'actual thumbnail'])
        derive.derive_dat_key_for_file=Mock(return_value=None)
        present.present_dat_image=lambda data:types.SimpleNamespace(data=data,extension='.png')
        r=reader_module.Reader()
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(data_dir='/data'),get_image=Mock(side_effect=['original.dat','thumb.dat']))
        with tempfile.TemporaryDirectory() as directory,patch.dict(sys.modules,{decrypt.__name__:decrypt,derive.__name__:derive,present.__name__:present}),\
             patch.object(reader_module,'Path',side_effect=lambda value:Path(directory) if value=='/exchange/incoming' else Path(value)):
            result=r.media([12,None,3,None,None,1000],{'text':'<img/>','conversationUsername':'room@chatroom'},'image')
            self.assertEqual(result['media']['quality'],'thumbnail')
            self.assertEqual(Path(result['attachmentPath']).read_bytes(),b'actual thumbnail')
            self.assertTrue(all(c.kwargs['sender_wxid']=='room@chatroom' for c in r.db.get_image.call_args_list))

    def test_packed_image_filename_supports_current_and_legacy_metadata(self):
        package=types.ModuleType('wechat_ai_bot.weixin.parser.util.protocbuf')
        def current():return types.SimpleNamespace(ParseFromString=lambda _:None,imageInfo=types.SimpleNamespace(filename=' "local-cache-image" '))
        def legacy():return types.SimpleNamespace(ParseFromString=lambda _:None,filename='legacy-name')
        package.packed_info_data_img2_pb2=types.SimpleNamespace(PackedInfoDataImg2=current)
        package.packed_info_data_img_pb2=types.SimpleNamespace(PackedInfoDataImg=legacy)
        with patch.dict(sys.modules,{package.__name__:package}):
            self.assertEqual(reader_module.image_filename(b'packed'),'local-cache-image')
            package.packed_info_data_img2_pb2.PackedInfoDataImg2=lambda:types.SimpleNamespace(ParseFromString=lambda _:None)
            self.assertEqual(reader_module.image_filename(b'packed'),'legacy-name')

    def member_reader(self):
        r=reader_module.Reader();r.db=object();r.refresh_routes=Mock();r.binding=lambda:{}
        r.routes={'alice':{'kind':'group','uiLabel':'群','username':'room@chatroom','actorUsername':'alice','actorName':'Alice','members':[{'username':'alice','name':'Alice'}]}}
        return r

    def test_standalone_native_mentions_match_trimmed_rows_only_with_exact_recipient_metadata(self):
        verifier=reader_module.DesktopSendVerifier();verifier.username='room@chatroom';verifier.sender='self'
        action=types.SimpleNamespace(action_type=1,at_user_name='Alice',at_user_username='alice',content='')
        for text,users,expected in [('@Alice',['alice'],True),('\u2005@Alice\u2005',['alice'],True),
                ('@Alice2',['alice'],False),('@Alice hi',['alice'],False),('@Alice',[],False),
                ('@Alice',['bob'],False),('@Alice',['alice','bob'],False)]:
            row=[None]*18;row[2]=1;row[11]='<msgsource><atuserlist>'+','.join(users)+'</atuserlist></msgsource>';row[12]=text
            self.assertEqual(verifier._matches(action,row),expected)

    def test_prepare_binds_group_mention_to_fresh_address_book(self):
        r=self.member_reader()
        delivery={'peerId':'alice','uiLabel':'群','kind':'text','text':'hi','mention':{'username':'alice','name':'Alice'}}
        with patch.object(reader_module,'DesktopSendVerifier',return_value=Mock()) as factory:
            self.assertEqual(r.prepare(delivery)['mention'],delivery['mention'])
            self.assertEqual(r.action.at_user_name,'Alice')
            self.assertEqual(r.action.content,'hi')
            self.assertEqual(r.prepare({**delivery,'mention':{'username':'alice','name':'Old name'}})['mention'],delivery['mention'])
            r.routes['alice']['members'][0]={'username':'alice','name':'小J','mentionNames':['小J','Alice']}
            prepared=r.prepare(delivery)
            self.assertEqual(prepared['mention'],{'username':'alice','name':'小J'})
            self.assertEqual(prepared['mentionNames'],['小J','Alice'])
            self.assertEqual(r.action.at_user_username,'alice')
            self.assertEqual(r.action.at_user_name,'小J')
            r.refresh_routes.assert_called_with(force=True)
            with self.assertRaisesRegex(RuntimeError,'@ member'):
                r.prepare({**delivery,'mention':{'username':'missing','name':'小J'}})
            # Same display name remains two identities. Return the current
            # roster so the native picker can refuse an ambiguous visible row.
            r.routes['alice']['members'].append({'username':'bob','name':'小J'})
            self.assertEqual(len(r.prepare(delivery)['mentionMembers']),2)
            r.routes['alice']['members'].append({'username':'alice','name':'duplicate record'})
            with self.assertRaisesRegex(RuntimeError,'ambiguous'):r.prepare(delivery)
            r.routes['alice']['members']=[{'username':'alice','name':'Alice'}]
            self.assertIsNone(r.prepare({**delivery,'mention':None})['mention'])

    def test_picker_remark_and_native_nickname_still_require_the_same_actual_member_and_reply(self):
        r=self.member_reader();r.routes['alice']['members'][0]['mentionNames']=['Alice','小艾']
        delivery={'peerId':'alice','uiLabel':'群','kind':'text','text':'你好','mention':{'username':'alice','name':'Alice'}}
        with patch.object(reader_module,'DesktopSendVerifier',return_value=Mock()):
            self.assertEqual(r.prepare(delivery)['mentionNames'],['Alice','小艾'])
        verifier=reader_module.DesktopSendVerifier();verifier.username='room@chatroom';verifier.sender='self'
        for text,users,expected in [('@小艾\u2005你好',['alice'],True),('@Alice\u2005你好',['alice'],True),
                ('@小艾\u2005你好',['bob'],False),('@小艾\u2005你好',[],False),('@Bob\u2005你好',['alice'],False),
                ('@小艾\u2005变了',['alice'],False)]:
            row=[None]*18;row[2]=1;row[11]='<msgsource><atuserlist>'+','.join(users)+'</atuserlist></msgsource>';row[12]=text
            self.assertEqual(verifier._matches(r.action,row),expected)

    def test_verify_rejects_plain_text_mentions_and_mentions_of_other_people(self):
        r=self.member_reader();r.target='room@chatroom';r.action=object()
        r.mention={'username':'alice','name':'Alice'}
        row=[1,101];db=Mock();db.get_messages_by_username.return_value=[row];r.db=db
        for members in ([],['bob'],['alice','bob'],['alice']):
            r.verifier=Mock(file_md5='');r.verifier.verify.return_value={'server_id':'101','local_id':1,'matchedRow':row,'senderUsername':'self'}
            r.proof=lambda *_,**kw:{'atUsernames':members}
            if members==['alice']:self.assertTrue(r.verify()['verified'])
            else:
                with self.assertRaisesRegex(RuntimeError,'exactly the intended'):r.verify()
        db.get_messages_by_username.assert_not_called()

    def test_verifier_preserves_first_matched_row_and_proof_reuses_verified_sender(self):
        verifier=reader_module.DesktopSendVerifier();verifier.username='room@chatroom';verifier.sender='self';verifier.file_md5=''
        action=types.SimpleNamespace(action_type=1,at_user_name=None,content='hello')
        first=[None]*18;first[0]=1;first[1]=101;first[2]=1;first[4]=7;first[5]=2000;first[11]='';first[12]='hello';first[17]='first.db'
        last=list(first);last[0]=2;last[1]=102;last[17]='last.db'
        verifier.rows=[first,last]
        r=reader_module.Reader();r.db=Mock();r.db.user_info.account='self';r.owner=types.SimpleNamespace(username='owner')
        r.settings={'accountDirectory':'self_abcd'};r.shard_name=lambda value:value
        r.verifier=verifier;r.target='room@chatroom';r.action=action
        result=r.verify(wait=False)
        self.assertEqual(result['database']['localId'],1)
        self.assertEqual(result['database']['shard'],'first.db')
        self.assertEqual(result['database']['senderUsername'],'self')
        self.assertEqual(result['database']['text'],'hello')
        r.db.get_messages_by_username.assert_not_called();r.db.get_contact_by_sender_id.assert_not_called()
        verifier.rows=[last]
        self.assertIs(verifier.verify(action)['matchedRow'],last)
        self.assertEqual(len(verifier.matched_rows),1)

    def test_poll_media_decodes_one_due_item_and_keeps_pending_retry(self):
        r=reader_module.Reader();r.cursor=lambda:{'pendingMedia':dict(r.pending_media)}
        r.pending_media={'old':{'next':0,'attempts':0,'baseline':True},
                         'new':{'next':0,'attempts':0,'baseline':False},
                         'later':{'next':10000,'attempts':0,'baseline':False}}
        r.resolve_media=Mock(return_value={'sourceMessageId':'new','media':{'status':'pending'}})
        with patch.object(reader_module.time,'monotonic',return_value=100):
            result=r.poll_media()
            r.resolve_media.assert_called_once_with('new')
            self.assertEqual(len(result['events']),1)
            self.assertEqual(r.pending_media['new']['attempts'],1)
            self.assertEqual(r.pending_media['new']['next'],106)
            self.assertIn('new',result['cursor']['pendingMedia'])
            r.resolve_media.reset_mock();r.resolve_media.return_value={'sourceMessageId':'old','media':{'status':'available'}}
            self.assertEqual(len(r.poll_media()['events']),1)
            r.resolve_media.assert_called_once_with('old')
            self.assertNotIn('old',r.pending_media)
            r.resolve_media.reset_mock()
            self.assertEqual(r.poll_media()['events'],[]);r.resolve_media.assert_not_called()

    def test_delayed_audio_and_video_stay_pending_until_an_actual_file_exists(self):
        for kind in (34,43):
            r=reader_module.Reader();r.settings={'accountDirectory':'self_abcd'}
            r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),get_contact_in_room=lambda *_:None)
            r.route=lambda *_:{}
            r.proof=lambda row,*_:{'senderUsername':'alice','conversationUsername':'r@chatroom','serverId':'101',
                'shard':'message_0.db','text':'media description'}
            chat=types.SimpleNamespace(username='r@chatroom',is_chatroom=True)
            r.media=Mock(side_effect=[{'unavailable':'File not downloaded'}, {'attachmentPath':'/exchange/actual-file'}])
            pending=r.make_event([1,None,kind],chat,True,decode_media=True)
            self.assertTrue(r.has_pending_media(pending));self.assertIn('sourceId',pending['media'])
            ready=r.make_event([1,None,kind],chat,True,decode_media=True)
            self.assertFalse(r.has_pending_media(ready));self.assertEqual(ready['attachmentPath'],'/exchange/actual-file')

    def test_media_queue_survives_restart_without_replaying_old_chat(self):
        own=types.SimpleNamespace(username='self',alias='role')
        owner=types.SimpleNamespace(username='owner',alias='ownerid',remark='测试哥',is_chatroom=False)
        group=types.SimpleNamespace(username='room@chatroom',is_chatroom=True)
        settings={'accountDirectory':'self_abcd','accountWechatId':'role','ownerWechatId':'ownerid','uiLabel':'测试哥'}
        db=types.SimpleNamespace(setup=lambda:None,is_available=True,user_info=types.SimpleNamespace(account='self'),
            get_contact_by_username=lambda _:own,_contact_by_username={'owner':owner})
        r=reader_module.Reader();r.settings=settings;r.db=db;r.owner=owner;r.since=r.multi_since=1000
        r.watermarks={'room@chatroom:message/message_0.db':12};r.context_rooms={'room@chatroom'}
        source='db:self_abcd:room@chatroom:message/message_0.db:12'
        r.pending_media={source:{'next':105,'attempts':2,'baseline':False}}
        with patch.object(reader_module.time,'monotonic',return_value=100),patch.object(reader_module.time,'time',return_value=1000):
            cursor=r.cursor()
        self.assertEqual(cursor['pendingMedia'][source]['nextAt'],1005)
        restored=reader_module.Reader()
        restored.refresh_routes=lambda:(setattr(restored,'chats',{'room@chatroom':group}),setattr(restored,'routes',{}))
        with patch.object(reader_module,'LinuxDatabaseService',return_value=db),\
             patch.object(reader_module.time,'monotonic',return_value=200),patch.object(reader_module.time,'time',return_value=1007):
            result=restored.initialize(settings,cursor)
        self.assertEqual(result['baselineEvents'],[])
        self.assertEqual(restored.pending_media[source],{'next':200,'attempts':2,'baseline':False})
        self.assertEqual(restored.watermarks,r.watermarks)

    def test_routes_rebuild_only_when_names_membership_or_eligibility_change(self):
        def person(username,name,**extra):
            return types.SimpleNamespace(username=username,display_name=name,alias='',nick_name=name,room_remark='',remark='',
                is_chatroom=username.endswith('@chatroom'),delete_flag=0,verify_flag=0,flag=1,**extra)
        owner=person('owner','测试哥');group=person('room@chatroom','群');member=person('alice','Alice')
        room=types.SimpleNamespace(ext_buffer=b'members-v1')
        r=reader_module.Reader();r.owner=owner
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),refresh_contact_metadata=Mock(),
            _contact_by_username={'owner':owner,'room@chatroom':group,'alice':member},_chat_rooms={'room@chatroom':room})
        r.route=Mock(side_effect=lambda chat:{'peerId':chat.username,'username':chat.username})
        r.refresh_routes();self.assertEqual(r.route.call_count,3)
        r.refresh_routes();self.assertEqual(r.route.call_count,3)
        member.nick_name='新昵称';r.refresh_routes();self.assertEqual(r.route.call_count,6)
        room.ext_buffer=b'members-same-but-room-nickname-v2';r.refresh_routes();self.assertEqual(r.route.call_count,9)
        member.delete_flag=1;r.refresh_routes();self.assertEqual(r.route.call_count,11)

    def test_roster_time_renews_only_after_real_metadata_refresh_not_cached_polls(self):
        def person(username,name):
            return types.SimpleNamespace(username=username,display_name=name,alias='',nick_name=name,room_remark='',remark='',
                is_chatroom=username.endswith('@chatroom'),delete_flag=0,verify_flag=0,flag=1)
        owner=person('owner','测试哥');group=person('room@chatroom','群');member=person('alice','Alice')
        room=types.SimpleNamespace(ext_buffer=b'members-v1',parsed_member_list=['alice'])
        r=reader_module.Reader();r.owner=owner;r.settings={'ownerPeerId':'owner'}
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),_last_contact_refresh=0,
            refresh_contact_metadata=Mock(side_effect=lambda **_:setattr(r.db,'_last_contact_refresh',10)),
            _db=lambda _:Path('/fixture/contact.db'),_contact_by_username={'owner':owner,'room@chatroom':group,'alice':member},
            _chat_rooms={'room@chatroom':room},get_contact_in_room=lambda *_:member)
        with patch.object(reader_module.time,'time',return_value=1000):r.refresh_routes()
        route=r._routes_by_username['room@chatroom'];self.assertEqual(route['rosterObservedAt'],1_000_000)
        with patch.object(reader_module.time,'time',return_value=1005):r.refresh_routes()
        self.assertEqual(route['rosterObservedAt'],1_000_000,'cached metadata does not refresh authorization')
        r.db.refresh_contact_metadata.side_effect=lambda **_:setattr(r.db,'_last_contact_refresh',20)
        with patch.object(reader_module.time,'time',return_value=1010):r.refresh_routes()
        self.assertIs(r._routes_by_username['room@chatroom'],route,'same roster need not rebuild routes')
        self.assertEqual(route['rosterObservedAt'],1_010_000)
        r.db._db=lambda _:None
        r.db.refresh_contact_metadata.side_effect=lambda **_:setattr(r.db,'_last_contact_refresh',30)
        with patch.object(reader_module.time,'time',return_value=1020):r.refresh_routes()
        self.assertEqual(route['rosterObservedAt'],1_010_000,'missing source cannot prolong a stale roster')

    def test_group_without_decoded_member_table_has_no_freshness_claim(self):
        r=reader_module.Reader();r._roster_observed_at=1000
        group=types.SimpleNamespace(username='room@chatroom',display_name='群',is_chatroom=True)
        r.db=types.SimpleNamespace(_chat_rooms={})
        value=r.route(group)
        self.assertNotIn('rosterObservedAt',value);self.assertEqual(value['members'],[])

    def test_unnamed_room_uses_member_title_and_retains_immutable_room_identity(self):
        r=reader_module.Reader()
        group=types.SimpleNamespace(username='new@chatroom',display_name='new@chatroom',is_chatroom=True)
        people={name:types.SimpleNamespace(display_name=label) for name,label in
                [('alice','漫步者-徐'),('ling','🌸玲~'),('self','阮阮')]}
        room=types.SimpleNamespace(parsed_member_list=['alice','ling','self'])
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),_chat_rooms={group.username:room},
            get_contact_in_room=lambda room,username:people.get(username))
        route=r.route(group)
        self.assertEqual(route['uiLabel'],'漫步者-徐、🌸玲~')
        self.assertEqual(route['username'],'new@chatroom')
        self.assertEqual([m['username'] for m in route['members']],['alice','ling','self'])
        people['alice'].display_name='小J'
        self.assertEqual(r.conversation_label(group),'小J、🌸玲~')
        group.display_name='新群名'
        self.assertEqual(r.conversation_label(group),'新群名')

    def test_same_generated_room_titles_are_not_registered_as_distinct_searchable_targets(self):
        def person(username,name):
            return types.SimpleNamespace(username=username,display_name=name,alias='',nick_name=name,room_remark='',remark='',
                is_chatroom=username.endswith('@chatroom'),delete_flag=0,verify_flag=0,flag=1)
        owner=person('owner','测试哥');alice=person('alice','Alice');bob=person('bob','Bob')
        groups=[person(name,name) for name in ['one@chatroom','two@chatroom']]
        r=reader_module.Reader();r.owner=owner;r.settings={'ownerPeerId':'owner'}
        r.db=types.SimpleNamespace(user_info=types.SimpleNamespace(account='self'),refresh_contact_metadata=Mock(),
            _contact_by_username={p.username:p for p in [owner,alice,bob,*groups]},
            _chat_rooms={g.username:types.SimpleNamespace(ext_buffer=b'same',parsed_member_list=['alice','bob','self']) for g in groups},
            get_contact_in_room=lambda room,username:{'alice':alice,'bob':bob}.get(username))
        r.refresh_routes()
        self.assertNotIn('one@chatroom',r.chats);self.assertNotIn('two@chatroom',r.chats)
        groups[1].display_name='另一个群';groups[1].nick_name='另一个群'
        r.refresh_routes()
        self.assertEqual(r._routes_by_username['one@chatroom']['uiLabel'],'Alice、Bob')
        self.assertEqual(r._routes_by_username['two@chatroom']['uiLabel'],'另一个群')

    @unittest.skipUnless(HAS_IMAGE_DEPS,'Pillow/numpy are provided by the private reader image')
    def test_popup_ocr_uses_difference_crop_and_restores_rect_coordinates(self):
        r=reader_module.Reader();r.ocr=Mock(return_value=([
            ([[16,16],[56,16],[56,36],[16,36]],'Alice',.99),
            ([[0,0],[8,0],[8,8],[0,8]],'unchanged background',.99)],None))
        before=Image.new('RGB',(300,200),'white');after=before.copy()
        ImageDraw.Draw(after).rectangle((100,80,139,99),fill='black')
        def open_image(path):return before.copy() if Path(path).name=='before.png' else after.copy()
        with patch.object(Image,'open',side_effect=open_image):
            result=r.recognize('/exchange/after.png',rect=[20,30,200,120],beforePath='/exchange/before.png')
            self.assertEqual(r.ocr.call_args.args[0].shape,(52,72,3))
            self.assertEqual(result['items'],[{'box':[[80.0,50.0],[120.0,50.0],[120.0,70.0],[80.0,70.0]],'text':'Alice','score':.99}])
            self.assertFalse(result['cacheHit']);self.assertIn('elapsedMs',result)
            cached=r.recognize('/exchange/after.png',rect=[20,30,200,120],beforePath='/exchange/before.png')
            self.assertTrue(cached['cacheHit']);r.ocr.assert_called_once()

    @unittest.skipUnless(HAS_IMAGE_DEPS,'Pillow/numpy are provided by the private reader image')
    def test_popup_without_changes_skips_ocr_and_geometry_mismatch_still_fails(self):
        r=reader_module.Reader();r.ocr=Mock()
        with patch.object(Image,'open',side_effect=lambda _:Image.new('RGB',(100,100),'white')):
            self.assertEqual(r.recognize('/exchange/after.png',beforePath='/exchange/before.png')['items'],[])
            r.ocr.assert_not_called()
        with patch.object(Image,'open',side_effect=[Image.new('RGB',(100,100)),Image.new('RGB',(120,100))]):
            with self.assertRaisesRegex(RuntimeError,'geometry changed'):
                r.recognize('/exchange/after.png',beforePath='/exchange/before.png')

    @unittest.skipUnless(HAS_IMAGE_DEPS,'Pillow/numpy are provided by the private reader image')
    def test_unreadable_popup_rows_are_retained_without_weakening_other_ocr(self):
        r=reader_module.Reader();seen=[]
        detector=types.SimpleNamespace(limit_type='min')
        def ocr(image):
            seen.append(r.ocr.text_score)
            return [([[1,1],[20,1],[20,18],[1,18]],'???',.01)],None
        r.ocr=Mock(side_effect=ocr);r.ocr.text_det=detector;r.ocr.text_score=.5
        def screenshot(path):
            name=Path(path).name
            return Image.new('RGB',(100,100),'white' if name=='before.png' else 'gray' if name=='new.png' else 'black')
        with patch.object(Image,'open',side_effect=screenshot):
            result=r.recognize('/exchange/after.png',beforePath='/exchange/before.png')
            self.assertEqual(result['items'][0]['score'],.01)
            self.assertEqual(seen,[0.0]);self.assertEqual(r.ocr.text_score,.5)
            r.recognize('/exchange/after.png')
            self.assertEqual(seen,[0.0,.5])
        r.ocr.side_effect=RuntimeError('OCR failed')
        with patch.object(Image,'open',side_effect=screenshot),self.assertRaises(RuntimeError):
            r.recognize('/exchange/new.png',beforePath='/exchange/before.png')
        self.assertEqual(r.ocr.text_score,.5)

    @unittest.skipUnless(HAS_IMAGE_DEPS,'Pillow/numpy are provided by the private reader image')
    def test_native_detection_only_applies_to_small_label_strips_and_restores_default(self):
        r=reader_module.Reader();seen=[]
        detector=types.SimpleNamespace(limit_type='min')
        r.ocr=Mock(side_effect=lambda image:(seen.append(detector.limit_type) or [],None));r.ocr.text_det=detector
        def screenshot(path):
            return Image.new('RGB',(2300,300),'white' if Path(path).name=='before.png' else 'black')
        with patch.object(Image,'open',side_effect=screenshot):
            r.recognize('/exchange/after.png',rect=[0,0,465,50])
            self.assertEqual(seen,['max']);self.assertEqual(detector.limit_type,'min')
            r.recognize('/exchange/after.png')  # Full security inspection.
            r.recognize('/exchange/after.png',rect=[0,0,300,200])  # Search list.
            r.recognize('/exchange/after.png',rect=[0,0,465,50],beforePath='/exchange/before.png')
            r.recognize('/exchange/after.png',rect=[0,0,2200,50])  # No shrink of very wide strips.
            self.assertEqual(seen,['max','min','min','min','min'])
            r.ocr.side_effect=RuntimeError('detector failed')
            with self.assertRaisesRegex(RuntimeError,'detector failed'):
                r.recognize('/exchange/after.png',rect=[0,0,95,50])
            self.assertEqual(detector.limit_type,'min')

    def test_only_source_metadata_marks_a_real_mention(self):
        parse=reader_module.mentioned_users
        self.assertEqual(parse('<msgsource><atuserlist><![CDATA[wxid_self, wxid_bob]]></atuserlist></msgsource>'),['wxid_self','wxid_bob'])
        for body in ['@阮阮 你好','<msg><quote><atuserlist>self</atuserlist></quote></msg>','<msgsource><quoted><atuserlist>self</atuserlist></quoted></msgsource>','broken <xml']:
            self.assertEqual(parse(body),[])
        self.assertNotEqual(reader_module.source_id('account','room1','message/message_0.db',1),reader_module.source_id('account','room2','message/message_0.db',1))

    def test_group_poll_keeps_public_context_and_self_messages_without_splitting_the_room(self):
        path=Path('/fake/db_storage/message/message_0.db')
        people={1:types.SimpleNamespace(username='alice',display_name='Alice'),2:types.SimpleNamespace(username='bob',display_name='Bob'),3:types.SimpleNamespace(username='self',display_name='阮阮')}
        chat=types.SimpleNamespace(username='room@chatroom',is_chatroom=True,display_name='群')
        def row(local,actor,source):
            r=[None]*18;r[0]=local;r[1]=100+local;r[2]=1;r[4]=actor;r[5]=2000;r[11]=source;r[12]='@阮阮 hi';r[17]=path;return r
        rows=[row(1,1,'<msgsource/>'),row(2,1,'<msgsource><atuserlist>self</atuserlist></msgsource>'),row(3,2,'<msgsource><atuserlist>self</atuserlist></msgsource>'),row(4,3,'<msgsource><atuserlist>self</atuserlist></msgsource>')]
        class DB:
            user_info=types.SimpleNamespace(account='self',data_dir='/fake')
            _chat_rooms={'room@chatroom':types.SimpleNamespace(parsed_member_list=['alice','bob','self'])}
            def get_db_path_by_username(self,_):return [path]
            def _table_for_username(self,*_):return 'messages'
            def _max_local_id(self,*_):return 4
            def _message_column_sql(self):return '*'
            def _q(self,t):return t
            def execute_query(self,*args):return [r for r in rows if r[0]>args[-1][0]]
            def _normalize_message_row(self,r,p):return r
            def get_contact_by_sender_id(self,id,p):return people[id]
            def get_contact_in_room(self,room,name):return next(p for p in people.values() if p.username==name)
        r=reader_module.Reader();r.db=DB();r.owner=people[1];r.settings={'accountDirectory':'self_abcd','accountWechatId':'role','ownerWechatId':'ownerid','ownerPeerId':'owner'}
        r.chats={chat.username:chat};r.routes={};r.watermarks={};r.since=r.multi_since=1000;r.refresh_routes=lambda:None
        result=r.poll()
        self.assertEqual([e['database']['localId'] for e in result['events']],[1,2,3,4])
        self.assertEqual(len(set(e['route']['peerId'] for e in result['events'])),1)
        self.assertTrue(result['events'][-1]['contextOnly'])
        self.assertEqual(r.watermarks['room@chatroom:message/message_0.db'],4)
        self.assertEqual(r.poll()['events'],[])

if __name__=='__main__':unittest.main()
