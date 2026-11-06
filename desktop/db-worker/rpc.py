"""Private stdio reader. Network disabled; WeChat storage mounted read-only."""
import hashlib
import json
import logging
import math
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from wechat_ai_bot.models import UserInfo
from live_database import LiveDatabaseService as LinuxDatabaseService
from wechat_ai_bot.weixin.message_content import chat_message_text, message_content_text
from wechat_ai_bot.rpa.rpa_action import RPAActionType
from wechat_ai_bot.rpa.send_verifier import SendVerifier

logging.basicConfig(stream=sys.stderr, level=logging.ERROR)


def source_id(account, conversation, shard, local_id):
    return f'db:{account}:{conversation}:{shard}:{int(local_id)}'


def image_filename(packed):
    if not packed:return ''
    from wechat_ai_bot.weixin.parser.util.protocbuf import packed_info_data_img2_pb2,packed_info_data_img_pb2
    # The same local protobuf fields used by the upstream image factory.
    # Some images have a storage filename unrelated to the XML image digest.
    for cls,field in ((packed_info_data_img2_pb2.PackedInfoDataImg2,'imageInfo'),
                      (packed_info_data_img_pb2.PackedInfoDataImg,None)):
        try:
            value=cls();value.ParseFromString(packed)
            name=getattr(getattr(value,field) if field else value,'filename','').strip().strip('"').strip()
            if name:return name
        except Exception:continue
    return ''


def mentioned_users(source, ct_flag=None):
    # An @ in body text or a quote is not a real mention.
    from xml.etree import ElementTree
    try:
        root = ElementTree.fromstring(message_content_text(source, ct_flag))
        node = root.find('atuserlist') if root.tag == 'msgsource' else None
        return [name.strip() for name in (node.text or '').split(',') if name.strip()] if node is not None else []
    except (ElementTree.ParseError, ValueError):
        return []


def payment_card(app):
    """Describe native payment messages, never infer that money was received.

    The card's nativeurl/pay URL is deliberately kept out of model context.
    Opening or claiming payments is not part of the read-only transport.
    """
    pay = app.find('wcpayinfo')
    subtype = (app.findtext('type') or '').strip()
    if pay is None or subtype not in ('2000', '2001'):
        return None
    if subtype == '2001':
        description = (pay.findtext('receivertitle') or pay.findtext('sendertitle') or '').strip()[:200]
        value = {'kind': 'red_packet', 'description': description, 'receipt': 'unconfirmed', 'amountText': None}
        text = '[微信红包消息]'
        if description:
            text += ' 祝福语：' + json.dumps(description, ensure_ascii=False)
        text += '（领取结果未确认，金额未知）'
    else:
        amount = (pay.findtext('feedesc') or '').strip()[:64] or None
        value = {'kind': 'transfer', 'receipt': 'unconfirmed', 'amountText': amount}
        text = '[微信转账消息]'
        if amount:
            text += ' 卡片金额：' + json.dumps(amount, ensure_ascii=False)
        text += '（收款结果未确认）'
    return {'payment': value, 'displayText': text}


def native_voice_transcript(row,proof):
    from wechat_ai_bot.weixin.parser.audio_parser import audio_transcript
    return str(audio_transcript(proof['text'],row[14] if len(row)>14 else None) or '').strip()


def decode_voice(data,target):
    """Decode only local bytes; the bounded child has no network or source DB writes."""
    import subprocess,tempfile,wave
    if not data or len(data)>10*1024*1024:raise ValueError('Voice bytes missing or too large')
    target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='voice-decode-',dir=target.parent) as temporary:
        source=Path(temporary)/'voice.silk';pcm=Path(temporary)/'voice.pcm';wav=Path(temporary)/'voice.wav'
        if data.startswith((b'\x02#!SILK_V3',b'#!SILK_V3')):
            source.write_bytes(data)
            subprocess.run([sys.executable,'-c',
                'import resource,sys;resource.setrlimit(resource.RLIMIT_FSIZE,(2080000,2080000));'
                'resource.setrlimit(resource.RLIMIT_CPU,(5,6));import pilk;pilk.decode(sys.argv[1],sys.argv[2],pcm_rate=16000)',str(source),str(pcm)],
                check=True,timeout=10,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            if not pcm.is_file() or not 0<pcm.stat().st_size<=16000*2*65:raise ValueError('Decoded voice duration is invalid')
            with wave.open(str(wav),'wb') as stream:
                stream.setparams((1,2,16000,0,'NONE','NONE'));stream.writeframes(pcm.read_bytes())
        elif data.startswith(b'RIFF'):wav.write_bytes(data)
        else:raise ValueError('Unsupported native voice encoding')
        with wave.open(str(wav),'rb') as stream:
            if stream.getnchannels()!=1 or stream.getsampwidth()!=2:raise ValueError('Invalid decoded voice PCM')
            duration=stream.getnframes()/stream.getframerate()
            if not 0<duration<=65:raise ValueError('Decoded voice duration is invalid')
            if len(stream.readframes(stream.getnframes()))!=stream.getnframes()*2:raise ValueError('Truncated voice audio')
        wav.replace(target)
    return duration


class DesktopSendVerifier(SendVerifier):
    def _rows(self):
        rows=super()._rows()
        latest=getattr(self,'latest_at',None)
        return [row for row in rows if float(row[5] or 0)<=latest] if latest is not None else rows

    def verify(self, action):
        self.matched_rows = {}
        result = super().verify(action)
        # Upstream calls _matches only after watermark, server ID and sender
        # checks. Keep that exact row instead of searching the database again.
        row = self.matched_rows[(result['local_id'], result['server_id'])]
        return {**result, 'matchedRow': row, 'senderUsername': self.sender}

    def _matches(self, action, row):
        matches = self._content_matches(action, row)
        if matches and hasattr(self, 'matched_rows'):
            self.matched_rows.setdefault((int(row[0]), str(row[1])), row)
        return matches

    def _content_matches(self, action, row):
        if action.action_type == RPAActionType.SEND_TEXT_MESSAGE and action.at_user_name:
            # The picker can show a personal remark while the native chip uses
            # a room/global nickname. All names come from this member's contact
            # record; the actual recipient ID must still match independently.
            text = chat_message_text(row[12], row[15], chat_username=self.username,
                                     sender_username=self.sender).removeprefix('\u2005')
            if row[2] not in (1, 2) or mentioned_users(row[11], row[16]) != [action.at_user_username]:
                return False
            for name in getattr(action,'at_user_names',[action.at_user_name]):
                prefix='@'+name
                if not text.startswith(prefix):continue
                rest=text[len(prefix):]
                if action.content == '' and all(c in '\u2005 \t' for c in rest):return True
                if rest[:1] in ('\u2005',' ','\t') and rest[1:].replace('\r\n','\n') == action.content.replace('\r\n','\n'):
                    return True
            return False
        return super()._matches(action, row)


class Reader:
    def __init__(self):
        self.db = None
        self.verifier = None
        self.ocr = None
        self.ocr_cache = {}
        self.mention = None
        self.pending_media = {}
        self._route_signature = None
        self._routes_by_username = {}
        self._roster_observed_at = 0

    def initialize(self, settings, cursor=None):
        account_dir = settings['accountDirectory']
        if not re.fullmatch(r'[A-Za-z0-9_]+', account_dir):
            raise ValueError('Invalid account directory')
        account = account_dir.rpartition('_')[0]
        self.settings = settings
        self.db = LinuxDatabaseService(UserInfo(account=account), active_account=account)
        self.db.setup()
        if not self.db.is_available:
            raise RuntimeError('Cannot open current account message databases')
        own = self.db.get_contact_by_username(account)
        if not own or settings['accountWechatId'] not in (own.alias, own.username):
            raise RuntimeError('Logged-in database identity differs from the verified role account')
        matches = [c for c in self.db._contact_by_username.values()
                   if settings['ownerWechatId'] in (c.alias, c.username)
                   and c.remark == settings['uiLabel'] and not c.is_chatroom]
        if len(matches) != 1:
            raise RuntimeError('Verified owner identity and unique remark did not match one contact')
        self.owner = matches[0]
        binding = self.binding()
        if cursor and cursor.get('binding') != binding:
            raise RuntimeError('Reader checkpoint belongs to another account or owner')
        self.since = cursor['since'] if cursor else int(time.time())
        self.multi_since = cursor.get('multiSince', int(time.time())) if cursor else self.since
        self.watermarks = dict(cursor.get('watermarks', {})) if cursor else {}
        self._route_signature = None
        self.refresh_routes()
        self.pending_media = {}
        for source,pending in (cursor.get('pendingMedia',{}) if cursor else {}).items():
            parts=source.split(':')
            if len(parts)==5 and parts[:2]==['db',account_dir] and parts[2] in self.chats:
                self.pending_media[source]={'attempts':int(pending.get('attempts',0)),
                    'baseline':bool(pending.get('baseline',False)),
                    'next':time.monotonic()+max(0,min(60,float(pending.get('nextAt',0))-time.time()))}
        # Migrate the original owner's shard cursors; baseline other existing
        # conversations once, without replaying their previous group history.
        if not cursor or cursor.get('version') != 2:
            old = self.watermarks
            self.watermarks = {}
            for chat in self.chats.values():
                for path, table in self.shards(chat.username):
                    key = self.watermark_key(chat.username, path)
                    self.watermarks[key] = int(old.get(self.shard_name(path), 0)) if chat.username == self.owner.username and cursor else self.db._max_local_id(path, table)
        self.context_rooms=set(cursor.get('contextRooms',[])) if cursor else set()
        baseline=[]
        for chat in self.chats.values():
            if chat.is_chatroom and chat.username not in self.context_rooms:
                rows=self.db.get_messages_by_username(chat.username,count=40,order='desc')
                for row in reversed(rows):
                    # A room discovered during polling may not have a context
                    # seed yet. Its persisted watermark still distinguishes old
                    # history from messages arriving while the reader restarted.
                    key=self.watermark_key(chat.username,row[17])
                    if key in self.watermarks and int(row[0])>self.watermarks[key]:
                        continue  # Leave new rows for the normal poll path.
                    event=self.make_event(row,chat,baseline=True)
                    if event:baseline.append(event)
                self.context_rooms.add(chat.username)
        return {'binding':binding,'cursor':self.cursor(),'baseline':not bool(cursor),
                'routes':list(self.routes.values()),'baselineEvents':baseline}


    def binding(self):
        return {**{k: self.settings[k] for k in ('accountDirectory', 'accountWechatId', 'ownerWechatId')},
                'selfUsername': self.db.user_info.account, 'ownerUsername': self.owner.username}

    def cursor(self):
        now=time.monotonic();wall=time.time()
        return {'version': 2, 'binding': self.binding(), 'since': self.since,
                'multiSince': self.multi_since, 'watermarks': self.watermarks, 'contextRooms':list(getattr(self,'context_rooms',set())),
                'pendingMedia':{source:{'attempts':pending['attempts'],'baseline':pending.get('baseline',False),
                    'nextAt':wall+max(0,pending['next']-now)} for source,pending in self.pending_media.items()}}

    def conversation_label(self, chat):
        if not chat.is_chatroom or chat.display_name != chat.username:
            return chat.display_name
        # Unnamed rooms use their ordered members' display names in the client,
        # excluding this account. The internal @chatroom ID is not searchable.
        room = self.db._chat_rooms.get(chat.username)
        names = []
        for username in room.parsed_member_list if room else []:
            if username == self.db.user_info.account:continue
            person = self.db.get_contact_in_room(chat.username, username)
            if not person or person.display_name == username:return chat.username
            names.append(person.display_name)
        return '、'.join(names) if names else chat.username

    def route(self, chat, actor=None):
        group = chat.is_chatroom
        if group:
            room=self.db._chat_rooms.get(chat.username)
            members=[]
            for name in room.parsed_member_list if room else []:
                person=self.db.get_contact_in_room(chat.username,name)
                if person:
                    names=list(dict.fromkeys(n for n in (getattr(person,'room_remark',''),getattr(person,'nick_name',''),person.display_name) if n))
                    members.append({'username':name,'name':person.display_name,'mentionNames':names,'profile':self.contact_profile(person)})
            return {'peerId':'room-'+hashlib.sha256(chat.username.encode()).hexdigest()[:24],
                    'uiLabel':self.conversation_label(chat),'username':chat.username,'kind':'group','members':members,
                    **({'rosterObservedAt':self._roster_observed_at} if room and self._roster_observed_at else {}),
                    'identityNote':'Verified public room; participants are separate identities'}
        actor=actor or chat
        identity=json.dumps([chat.username,actor.username],separators=(',',':'))
        peer=self.settings['ownerPeerId'] if actor.username==self.owner.username else 'p-'+hashlib.sha256(identity.encode()).hexdigest()[:24]
        return {'peerId':peer,'uiLabel':chat.display_name,'username':chat.username,
                'actorUsername':actor.username,'actorName':actor.display_name,'kind':'private','profile':self.contact_profile(actor),
                'identityNote':'Local read-only address book identity; chat only'}

    @staticmethod
    def contact_profile(person):
        return {key:getattr(person,field,'') for key,field in
                [('wechatId','alias'),('nickname','nick_name'),('roomNickname','room_remark'),('remark','remark')]
                if getattr(person,field,'')}

    def refresh_routes(self, force=False):
        previous_refresh = getattr(self.db, '_last_contact_refresh', 0)
        if force:self.db.refresh_contact_metadata(force=True)
        else:self.db.refresh_contact_metadata()
        observed = getattr(self.db, '_last_contact_refresh', 0)
        # Upstream refreshes at most every ten seconds. Cached reads do not
        # renew authorization; a missing room/query cannot keep a stale stamp.
        verified = observed > previous_refresh and bool(getattr(self.db, '_db', lambda _: None)('contact/contact.db'))
        if verified:self._roster_observed_at = int(time.time() * 1000)
        contacts = list(self.db._contact_by_username.values())
        # Contact reloads replace objects even when nothing changed. Compare
        # only route/profile inputs, including raw room membership/nickname data.
        fields = ('username', 'alias', 'nick_name', 'room_remark', 'remark',
                  'display_name', 'is_chatroom', 'delete_flag', 'verify_flag', 'flag')
        signature = (tuple(sorted(tuple(getattr(c, field, '') for field in fields) for c in contacts)),
                     tuple(sorted((name, bytes(room.ext_buffer or b''))
                                  for name, room in self.db._chat_rooms.items())))
        if signature == self._route_signature:
            if verified:
                for route in self.routes.values():
                    if route.get('kind') != 'group':continue
                    room = self.db._chat_rooms.get(route['username'])
                    if room:
                        # Accessing the parser verifies the new room buffer.
                        members = set(room.parsed_member_list)
                        if all(member['username'] in members for member in route.get('members', [])):
                            route['rosterObservedAt'] = self._roster_observed_at
                            continue
                    route.pop('rosterObservedAt', None)
            return
        candidates = [c for c in contacts if c.username != self.db.user_info.account
                      and not c.delete_flag and (c.is_chatroom or
                      (not c.verify_flag and not c.username.startswith('gh_')
                       and c.username not in ('filehelper','weixin','fmessage','medianote','floatbottle','newsapp')
                       and (c.username == self.owner.username or c.flag & 1)))]
        labels = {}
        display_names = {chat.username:self.conversation_label(chat) for chat in candidates}
        for chat in candidates:
            label = ''.join(display_names[chat.username].split())
            labels.setdefault(label, set()).add(chat.username)
        self.chats = {c.username: c for c in candidates if len(labels[''.join(display_names[c.username].split())]) == 1}
        if self.owner.username not in self.chats:
            raise RuntimeError('Owner conversation label became ambiguous')
        self.routes = {}
        for chat in self.chats.values():
            route=self.route(chat);self.routes[route['peerId']]=route
        self._routes_by_username = {route['username']: route for route in self.routes.values()}
        self._route_signature = signature

    def shards(self, username):
        return [(p, self.db._table_for_username(p, username)) for p in self.db.get_db_path_by_username(username)]

    def shard_name(self, path):
        return str(Path(path).relative_to(Path(self.db.user_info.data_dir)/'db_storage'))

    def watermark_key(self, username, path):
        return username+':'+self.shard_name(path)

    def proof(self, row, username, sender_username=None):
        if sender_username is None:
            sender = self.db.get_contact_by_sender_id(row[4], row[17])
            sender_username = sender.username if sender else ''
        text = chat_message_text(row[12], row[15], chat_username=username,
                                 sender_username=sender_username)
        proof={'accountDirectory': self.settings['accountDirectory'],
                'selfUsername': self.db.user_info.account, 'ownerUsername': self.owner.username,
                'conversationUsername': username, 'senderUsername': sender_username,
                'atUsernames': mentioned_users(row[11], row[16]),
                'shard': self.shard_name(row[17]), 'localId': int(row[0]),
                'serverId': str(row[1] or ''), 'createdAt': int(row[5] or 0)*1000,
                'messageType': (int(row[2]) & 0xFFFFFFFF), 'text': text}
        if (int(row[2]) & 0xFFFFFFFF) in (3,34,43,47):proof['displayText']={3:'[图片]',34:'[语音]',43:'[视频]',47:'[表情包]'}[(int(row[2]) & 0xFFFFFFFF)]
        if (int(row[2]) & 0xFFFFFFFF)==49:
            from xml.etree import ElementTree
            try:
                root=ElementTree.fromstring(text)
                app=root if root.tag=='appmsg' else root.find('appmsg')
                if app is not None:
                    proof['displayText']=app.findtext('title') or '[引用消息]'
                    payment = payment_card(app)
                    if payment:
                        proof.update(payment)
                    ref=app.find('refermsg')
                    if ref is not None:
                        kind={'1':'text','3':'image','34':'audio','43':'video','47':'sticker'}.get(ref.findtext('type'),'text')
                        proof['replyTo']={'actorId':next((name for name in (ref.findtext('fromusr'),ref.findtext('chatusr')) if name and not name.endswith('@chatroom')),None),
                            'actorName':ref.findtext('displayname'),'serverId':ref.findtext('svrid'),'kind':kind,
                            'text':(ref.findtext('content') or '')[:1500] if kind=='text' else {'image':'[图片]','sticker':'[表情包]','video':'[视频]','audio':'[语音]'}[kind]}
            except ElementTree.ParseError:pass
        return proof

    def make_event(self,row,chat,baseline=False,decode_media=False):
        proof=self.proof(row,chat.username)
        if not proof['senderUsername'] or not re.fullmatch(r'[0-9]*[1-9][0-9]*',proof['serverId']):return None
        if not chat.is_chatroom and proof['senderUsername']!=chat.username:return None
        kind={1:'text',2:'text',3:'image',43:'video',47:'sticker',34:'audio',49:'text'}.get((int(row[2]) & 0xFFFFFFFF))
        if kind is None or ((int(row[2]) & 0xFFFFFFFF)==49 and not proof.get('displayText')):return None
        actor=self.db.get_contact_in_room(chat.username,proof['senderUsername']) if chat.is_chatroom else chat
        event={'route':self._routes_by_username.get(chat.username) or self.route(chat),'sourceMessageId':source_id(self.settings['accountDirectory'],chat.username,proof['shard'],row[0]),
               'kind':kind,'text':proof.get('displayText',proof['text'] if kind=='text' else ''),
               'database':proof,'actor':{'username':proof['senderUsername'],'name':actor.display_name if actor else proof['senderUsername']},
               'contextOnly':baseline or proof['senderUsername']==self.db.user_info.account}
        if proof.get('replyTo'):
            ref=dict(proof['replyTo'])
            try:original=self.find_message(chat.username,server_id=ref.get('serverId'))
            except Exception as exc:
                logging.warning('Reference pending for local_id=%s: %s',row[0],type(exc).__name__)
                original=None
            if original:
                target=self.proof(original,chat.username)
                ref.update({'sourceId':source_id(self.settings['accountDirectory'],chat.username,target['shard'],original[0]),
                            'actorId':target['senderUsername']})
                if ref['kind']=='text':ref['text']=target.get('displayText',target['text'])
                if ref['kind'] in ('image','sticker'):
                    ref['media']=self.image_content(original,target,ref['kind']) if decode_media else self.pending_content(original,target,ref['kind'])
                ref.pop('replyTo',None)
            elif ref['kind'] in ('image','sticker'):
                ref['media']={'kind':ref['kind'],'key':hashlib.sha256((chat.username+':'+str(ref.get('serverId'))).encode()).hexdigest(),'status':'pending'}
            event['replyTo']=ref
        if kind!='text':
            try:
                native=self.native_audio_content(row,proof) if kind=='audio' else None
                if native:
                    event['media']=native
                elif not decode_media:
                    event['media']=self.pending_content(row,proof,kind)
                    event['unavailable']='Actual media is pending'
                elif kind in ('image','sticker'):
                    event['media']=self.image_content(row,proof,kind)
                    if event['media'].get('localPath') and kind=='image':event['attachmentPath']=event['media']['localPath']
                    if event['media'].get('status')!='available':event['unavailable']='Actual media is pending'
                else:event.update(self.media(row,proof,kind))
            except Exception as exc:
                # Media is optional message content. A broken/unsupported file
                # must not terminate receiving texts or unrelated conversations.
                logging.error('Media unavailable for local_id=%s: %s',row[0],type(exc).__name__)
                event.update({'unavailable':'Incoming '+kind+' could not be decoded; content remains unknown'})
            if decode_media and not event.get('attachmentPath') and not any(
                    event.get('media',{}).get(field) for field in ('localPath','url','transcript')):
                # Audio/video files may arrive after their database row too.
                # Keep the same bounded retry queue until actual bytes exist.
                event.setdefault('media',self.pending_content(row,proof,kind))
                event.setdefault('unavailable','Actual media is pending')
        if not decode_media and self.has_pending_media(event):
            self.pending_media.setdefault(event['sourceMessageId'],
                {'next':time.monotonic(),'attempts':0,'baseline':bool(baseline)})
        return event

    def find_message(self, username, *, server_id=None, local_id=None, shard=None):
        if server_id is not None and not re.fullmatch(r'[0-9]*[1-9][0-9]*',str(server_id)):return None
        if server_id is None and local_id is None:return None
        for path,table in self.shards(username):
            if shard and self.shard_name(path)!=shard:continue
            column='server_id' if server_id is not None else 'local_id'
            sql=f'select {self.db._message_column_sql()} from {self.db._q(table)} where {column} = ? limit 1'
            rows=self.db.execute_query(path,sql,(server_id if server_id is not None else int(local_id),))
            if rows:return self.db._normalize_message_row(rows[0],path)
        return None

    def pending_content(self,row,proof,kind):
        identity=source_id(self.settings['accountDirectory'],proof['conversationUsername'],proof['shard'],row[0])
        return {'kind':kind,'key':hashlib.sha256(identity.encode()).hexdigest(),'sourceId':identity,'status':'pending'}

    @staticmethod
    def has_pending_media(event):
        return event.get('media',{}).get('status')=='pending' or event.get('replyTo',{}).get('media',{}).get('status')=='pending'

    def image_content(self,row,proof,kind):
        pending=self.pending_content(row,proof,kind)
        try:result=self.media(row,proof,kind)
        except Exception as exc:
            logging.warning('Media pending for local_id=%s: %s',row[0],type(exc).__name__)
            result={}
        media=result.get('media') or pending
        return {**media,'sourceId':pending['sourceId'],'status':'available' if media.get('localPath') or media.get('url') else 'pending'}

    def resolve_media(self, source):
        parts=source.split(':')
        if len(parts)!=5 or parts[:2]!=['db',self.settings['accountDirectory']] or parts[2] not in self.chats:
            raise ValueError('Unknown media conversation')
        row=self.find_message(parts[2],local_id=parts[4],shard=parts[3])
        event=self.make_event(row,self.chats[parts[2]],True,decode_media=True) if row else None
        if event and not self.has_pending_media(event):self.pending_media.pop(source,None)
        return event

    def poll(self):
        events = []
        self.refresh_routes()
        for chat in self.chats.values():
            for path, table in self.shards(chat.username):
                key = self.watermark_key(chat.username, path)
                last = int(self.watermarks.get(key, 0))
                if self.db._max_local_id(path, table) < last:
                    raise RuntimeError('Message sequence reset; inspect before importing history')
                sql = (f'select {self.db._message_column_sql()} from {self.db._q(table)} '
                       'where local_id > ? order by local_id asc limit 100')
                for raw in self.db.execute_query(path, sql, (last,)):
                    row = self.db._normalize_message_row(raw, path)
                    self.watermarks[key] = int(row[0])
                    since=self.since if chat.username==self.owner.username else self.multi_since
                    if int(row[5] or 0)*1000<since*1000:continue
                    event=self.make_event(row,chat)
                    if event:
                        events.append(event)
        events.sort(key=lambda e:(e['database']['createdAt'],e['database']['conversationUsername'],e['database']['shard'],e['database']['localId']))
        return {'events': events, 'cursor': self.cursor(), 'routes': list(self.routes.values())}

    def poll_media(self):
        # One item per RPC lets the caller schedule send confirmation before the
        # next decode. New messages precede old baseline media; no input is lost.
        due=[(source,pending) for source,pending in self.pending_media.items()
             if pending['next']<=time.monotonic()]
        if not due:return {'events':[],'cursor':self.cursor()}
        source,pending=min(due,key=lambda item:(item[1].get('baseline',False),item[1]['next']))
        try:
            updated=self.resolve_media(source)
            complete=updated is None or not self.has_pending_media(updated)
        except Exception as exc:
            logging.warning('Media retry pending: %s',type(exc).__name__)
            updated=None;complete=False
        pending['attempts']+=1
        if complete or pending['attempts']>=6:
            self.pending_media.pop(source,None)
        else:pending['next']=time.monotonic()+min(60,3*2**pending['attempts'])
        return {'events':[updated] if updated else [],'cursor':self.cursor()}

    def native_audio_content(self,row,proof):
        transcript=native_voice_transcript(row,proof)
        if not transcript:return None
        media=self.pending_content(row,proof,'audio')
        return {**media,'status':'available','transcript':{'text':transcript,'rawText':transcript,
            'source':'wechat','sourceId':media['sourceId'],'confidence':None}}

    def audio_content(self,row,proof):
        native=self.native_audio_content(row,proof)
        if native:return {'media':native}
        # VoiceInfo joins Name2Id; server ID alone is not a conversation binding.
        rows=[]
        for path in self.db.get_all_db_files():
            if not re.fullmatch(r'media_\d+\.db',path.name) or path.parent.name!='message':continue
            rows.extend(self.db.execute_query(path,
                'select v.voice_data from VoiceInfo v join Name2Id n on n.rowid=v.chat_name_id '
                "where v.svr_id=? and n.user_name=? and v.create_time=? and v.data_index='0' "
                'and length(v.voice_data)>0 and length(v.voice_data)<=? limit 2',
                (proof['serverId'],proof['conversationUsername'],int(row[5]),10*1024*1024)))
        candidates={bytes(value[0]) for value in rows if value[0]}
        if not candidates:return {'media':self.pending_content(row,proof,'audio'),'unavailable':'Original voice bytes have not arrived'}
        if len(candidates)!=1:raise RuntimeError('Ambiguous voice data for the original message')
        data=candidates.pop();key=hashlib.sha256(data).hexdigest()
        target=Path('/exchange/incoming')/(key+'.wav')
        if target.exists():
            import wave
            with wave.open(str(target),'rb') as stream:duration=stream.getnframes()/stream.getframerate()
        else:duration=decode_voice(data,target)
        media={**self.pending_content(row,proof,'audio'),'key':key,'status':'available',
            'localPath':str(target),'durationSeconds':duration}
        return {'media':media,'attachmentPath':str(target),'kind':'audio'}

    def media(self, row, proof, kind):
        if kind == 'audio':return self.audio_content(row,proof)
        if kind == 'video':
            from xml.etree import ElementTree
            import shutil
            root=ElementTree.fromstring(proof['text'])
            video=root if root.tag=='videomsg' else root.find('.//videomsg')
            relative=self.db.get_video(video.get('md5','')) if video is not None else None
            if relative:
                path=Path(self.db.user_info.data_dir)/relative
                if path.is_file():
                    target=Path('/exchange/incoming')/(hashlib.sha256(str(path).encode()).hexdigest()+'.mp4')
                    target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,target)
                    return {'attachmentPath':str(target),'kind':'video'}
        if kind == 'sticker':
            from xml.etree import ElementTree
            try:
                root=ElementTree.fromstring(proof['text'])
                emoji=root if root.tag=='emoji' else root.find('.//emoji')
                md5=(emoji.get('md5','') if emoji is not None else '').lower()
                if re.fullmatch('[a-f0-9]{32}',md5):
                    url=self.db.get_emoji_url(md5) or (emoji.get('cdnurl','') if emoji is not None else '')
                    media={'kind':'sticker','key':md5}
                    if url:media['url']=url
                    for folder in ('cache/emoticon','cache/emoji','resource/emoticon','msg/emoji'):
                        base=Path(self.db.user_info.data_dir)/folder
                        if base.is_dir():
                            found=next((p for p in base.rglob(md5+'*') if p.is_file()),None)
                            if found:
                                import shutil
                                target=Path('/exchange/incoming')/(md5+(found.suffix or '.gif'))
                                target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(found,target)
                                media['localPath']=str(target);break
                    return {'media':media}
            except ElementTree.ParseError:pass
        if kind == 'image':
            from wechat_ai_bot.services.core.wechat_dat import decrypt_dat_file
            from wechat_ai_bot.services.core.wechat_dat_key_discovery import derive_dat_key_for_file
            from wechat_ai_bot.services.core.wechat_image import present_dat_image
            message = SimpleNamespace(local_id=row[0], create_time=row[5],
                                      str_time=datetime.fromtimestamp(row[5]).isoformat(),
                                      file_name=image_filename(row[14] if len(row)>14 else None))
            seen=set()
            for thumb in (False,True):
                relative=self.db.get_image(proof['text'],message,sender_wxid=proof['conversationUsername'],thumb=thumb)
                if not relative or str(relative) in seen:continue
                seen.add(str(relative));path=Path(self.db.user_info.data_dir)/relative
                try:
                    derived=derive_dat_key_for_file(path)
                    result=present_dat_image(decrypt_dat_file(path,
                        aes_key=derived.key if derived else None,xor_key=derived.xor_key if derived else None))
                    target=Path('/exchange/incoming')/(hashlib.sha256(str(path).encode()).hexdigest()+result.extension)
                    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(result.data)
                    return {'attachmentPath':str(target),'kind':'image','media':{'kind':'image','key':hashlib.sha256(result.data).hexdigest(),
                            'localPath':str(target),'quality':'thumbnail' if thumb else 'original'}}
                except Exception as exc:
                    logging.warning('Image decode pending local_id=%s thumbnail=%s: %s',row[0],thumb,type(exc).__name__)
        # A notification/XML description must never be passed off as an image.
        return {'unavailable': 'Incoming '+kind+' needs its actual local file; no placeholder was forwarded'}

    def prepare(self, delivery):
        # Queued speech can outlive a room nickname. Refresh only contact data,
        # then resolve the immutable member ID; never reinterpret a stale name
        # as another person or reset message watermarks/key discovery.
        self.refresh_routes(force=True)
        route = self.routes.get(delivery['peerId'])
        if not route or route['uiLabel'] != delivery['uiLabel']:
            raise RuntimeError('Outgoing recipient is not an identified address book route')
        self.target = route['username']
        kind = delivery['kind']
        mention = None
        mention_names=[]
        if kind == 'text' and route['kind'] == 'group' and delivery.get('mention'):
            requested=delivery['mention']
            members=route.get('members',[])
            matches=[m for m in members if m['username']==requested.get('username')]
            if len(matches)!=1:
                raise RuntimeError('Group @ member identity is missing or ambiguous')
            mention={'username':matches[0]['username'],'name':matches[0]['name']}
            mention_names=list(dict.fromkeys([mention['name'],*(matches[0].get('mentionNames') or [])]))
        action = SimpleNamespace(action_type=RPAActionType.SEND_TEXT_MESSAGE if kind == 'text' else RPAActionType.SEND_FILE,
            target=self.target, target_username=self.target,
            content=delivery.get('text', ''), at_user_name=mention['name'] if mention else None,
            at_user_username=mention['username'] if mention else None, at_user_names=mention_names,
            file_path=delivery.get('desktopPath', ''))
        self.verifier = DesktopSendVerifier(self.db, timeout=10, poll_interval=0.25)
        self.verifier.prepare(action)
        self.action = action
        self.mention = mention
        self.delivery_kind=kind
        return {'verification':self.verification_checkpoint(), 'prepared': True, 'binding': self.binding(), 'mention': mention,'mentionNames':mention_names,
                'mentionMembers':[{'username':m['username'],'name':m['name'],'mentionNames':m.get('mentionNames',[])}
                    for m in route.get('members',[])] if mention else []}

    def verification_checkpoint(self):
        verifier=self.verifier
        return {'version':1,'binding':self.binding(),'target':self.target,
            'sender':verifier.sender,'kind':self.delivery_kind,'text':self.action.content,
            'mention':self.mention,'mentionNames':self.action.at_user_names,
            'watermarks':verifier.watermarks,'startedAt':verifier.started_at,
            'fileMd5':verifier.file_md5}

    def reconcile(self,checkpoint):
        # This restores the original watermark; calling prepare here would
        # discard the very outgoing row we need to find after a crash.
        if checkpoint.get('version')!=1 or checkpoint.get('binding')!=self.binding():
            raise ValueError('Recovery checkpoint belongs to a different database binding')
        sender=str(self.db.user_info.account or '')
        if not sender or checkpoint.get('sender')!=sender:
            raise ValueError('Recovery sender identity changed')
        target=checkpoint.get('target');kind=checkpoint.get('kind')
        if not isinstance(target,str) or not self.db.get_contact_by_username(target):
            raise ValueError('Recovery target no longer resolves to its original account')
        if kind not in ('text','image','file','video'):raise ValueError('Invalid recovery delivery kind')
        started=checkpoint.get('startedAt');attempted=checkpoint.get('attemptedAt')
        if not all(isinstance(v,(int,float)) and math.isfinite(v) and v>0 for v in (started,attempted)) or attempted<started or attempted>time.time()+5:
            raise ValueError('Invalid original recovery time window')
        watermarks=checkpoint.get('watermarks')
        if not isinstance(watermarks,dict) or any(not isinstance(k,str) or not isinstance(v,int) or v<0 for k,v in watermarks.items()):
            raise ValueError('Invalid original recovery watermarks')
        mention=checkpoint.get('mention');names=checkpoint.get('mentionNames',[])
        if mention is not None and (not isinstance(mention,dict) or not mention.get('username') or not mention.get('name')):
            raise ValueError('Invalid original recovery mention')
        if not isinstance(names,list) or any(not isinstance(n,str) for n in names):raise ValueError('Invalid recovery mention names')
        text=checkpoint.get('text')
        if not isinstance(text,str):raise ValueError('Invalid original recovery text')
        file_md5=checkpoint.get('fileMd5','')
        if kind!='text' and not re.fullmatch('[a-fA-F0-9]{32}',file_md5):raise ValueError('Missing original attachment digest')
        self.target=target;self.mention=mention
        self.action=SimpleNamespace(action_type=RPAActionType.SEND_TEXT_MESSAGE if kind=='text' else RPAActionType.SEND_FILE,
            target=target,target_username=target,content=text,at_user_name=mention['name'] if mention else None,
            at_user_username=mention['username'] if mention else None,at_user_names=names,file_path='')
        verifier=DesktopSendVerifier(self.db,timeout=0,poll_interval=.25)
        verifier.sender=sender;verifier.username=target;verifier.watermarks=dict(watermarks)
        verifier.started_at=started;verifier.file_md5=file_md5
        # A later, manually sent identical message is not evidence for this
        # click. Retain uncertainty when a receipt falls outside its window.
        verifier.latest_at=attempted+120
        self.verifier=verifier
        return self.verify(wait=False)

    def verify(self, wait=True):
        started=time.perf_counter()
        if not self.verifier:
            raise RuntimeError('No prepared outgoing delivery')
        self.verifier.timeout=10 if wait else 0
        try:result = self.verifier.verify(self.action)
        except Exception as exc:
            if not wait and type(exc).__name__=='SendVerificationError' and str(exc).startswith('No matching new sent message'):
                return {'pending':True,'verifyQueryMs':round((time.perf_counter()-started)*1000)}
            raise
        proof = self.proof(result['matchedRow'], self.target, sender_username=result['senderUsername'])
        if self.mention and proof['atUsernames'] != [self.mention['username']]:
            raise RuntimeError('Sent reply did not @ exactly the intended group member; do not resend')
        if self.verifier.file_md5:
            proof['fileMd5'] = self.verifier.file_md5
        self.verifier = None
        return {'database': proof, 'verified': True,'verifyQueryMs':round((time.perf_counter()-started)*1000)}

    def recognize(self, path, rect=None, beforePath=None):
        started=time.perf_counter()
        from PIL import Image, ImageChops
        p = Path(path).resolve()
        if not p.is_relative_to('/exchange'):
            raise ValueError('OCR input must be a local exchange screenshot')
        image = Image.open(p).convert('RGB')
        if rect:
            x,y,w,h=map(int,rect); image=image.crop((x,y,x+w,y+h))
        before = None
        if beforePath:
            previous = Path(beforePath).resolve()
            if not previous.is_relative_to('/exchange'):
                raise ValueError('Previous screenshot must come from exchange')
            before = Image.open(previous).convert('RGB')
            if rect: before=before.crop((x,y,x+w,y+h))
            if before.size != image.size:raise RuntimeError('Popup screenshot geometry changed')
        # RapidOCR's default detector expands the short edge to 736px. For a
        # 50px title/button strip that creates a much larger image than the full
        # desktop. Native-size detection is verified for these label regions;
        # keep default precision for popup ellipses, search lists and safety OCR.
        label_region=bool(rect and before is None and image.height<=80 and image.width<=2000)
        key=(label_region,image.size,hashlib.sha256(image.tobytes()).digest(),hashlib.sha256(before.tobytes()).digest() if before is not None else None)
        if key in self.ocr_cache:
            return {**self.ocr_cache[key],'cacheHit':True,'elapsedMs':round((time.perf_counter()-started)*1000)}
        offset_x=offset_y=0
        crop=image
        if before is not None:
            difference=ImageChops.difference(before,image).convert('L')
            changed_bounds=difference.point(lambda value:255 if value>=24 else 0).getbbox()
            if changed_bounds:
                left,top,right,bottom=changed_bounds
                bounds=(max(0,left-16),max(0,top-16),min(image.width,right+16),min(image.height,bottom+16))
                offset_x,offset_y=bounds[:2]
                crop=image.crop(bounds)
            else:
                result={'items':[]}
                if len(self.ocr_cache)>=12:self.ocr_cache.pop(next(iter(self.ocr_cache)))
                self.ocr_cache[key]=result
                return {**result,'cacheHit':False,'elapsedMs':round((time.perf_counter()-started)*1000)}
        import numpy as np
        if self.ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            self.ocr = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1)
        detector=self.ocr.text_det
        previous_limit_type=detector.limit_type
        previous_text_score=self.ocr.text_score
        try:
            # The pinned detector's max policy does not shrink inputs <=2000px.
            # Restore even on failure: the shared engine also handles full OCR.
            if label_region:detector.limit_type='max'
            # Popup text is a locator, not the member identity. Keep detected
            # rows even when their decorative name is unreadable; the sender
            # verifies the copied native Unicode chip before adding body text.
            if before is not None:self.ocr.text_score=0.0
            results, _ = self.ocr(np.array(crop))
        finally:
            detector.limit_type=previous_limit_type
            self.ocr.text_score=previous_text_score
        results=[([[float(x)+offset_x,float(y)+offset_y] for x,y in box],text,score)
                 for box,text,score in (results or [])]
        if before is not None:
            def changed(box):
                xs,ys=zip(*box)
                bounds=(max(0,int(min(xs))),max(0,int(min(ys))),min(image.width,int(max(xs))+1),min(image.height,int(max(ys))+1))
                difference=ImageChops.difference(before.crop(bounds),image.crop(bounds)).convert('L')
                return sum(difference.histogram()[24:])>=max(2,difference.width*difference.height*.02)
            results=[(box,text,score) for box,text,score in (results or []) if changed(box)]
        result={'items': [{'box': [[float(x),float(y)] for x,y in box], 'text': text,
                           'score': float(score)} for box,text,score in (results or [])]}
        if len(self.ocr_cache)>=12:self.ocr_cache.pop(next(iter(self.ocr_cache)))
        self.ocr_cache[key]=result
        return {**result,'cacheHit':False,'elapsedMs':round((time.perf_counter()-started)*1000)}

    def pixels(self, path, rect=None, point=None):
        from PIL import Image
        p=Path(path).resolve()
        if not p.is_relative_to('/exchange'):raise ValueError('Image must come from exchange')
        image=Image.open(p).convert('RGB')
        if point:
            x,y=map(int,point);pixels=image.crop((x-45,y-15,x+45,y+15)).getdata()
            return {'enabled':sum(1 for r,g,b in pixels if r<100 and g>130 and b<160)>100}
        x,y,w,h=map(int,rect)
        pixels=image.crop((x,y,x+w,y+h)).getdata()
        # Blank composer is near white. A caret is allowed; an existing draft,
        # attachment or sticker is preserved instead of cleared by automation.
        return {'blank':sum(1 for r,g,b in pixels if min(r,g,b)<200)<60}

    def call(self, method, args):
        if method == 'init': return self.initialize(**args)
        if method == 'ocr': return self.recognize(**args)
        if method in ('blank','green'): return self.pixels(**args)
        if not self.db: raise RuntimeError('Reader not initialized')
        if method == 'poll': return self.poll()
        if method == 'poll-media': return self.poll_media()
        if method == 'routes':
            self.refresh_routes()
            return {'routes': list(self.routes.values())}
        if method == 'prepare': return self.prepare(args['delivery'])
        if method == 'verify': return self.verify(**args)
        if method == 'reconcile': return self.reconcile(args['checkpoint'])
        if method == 'resolve-media': return self.resolve_media(args['source'])
        raise ValueError('Unknown reader method')


if __name__ == '__main__':
    reader=Reader()
    for line in sys.stdin:
        request={}
        try:
            request=json.loads(line)
            result=reader.call(request['method'],request.get('args',{}))
            response={'id':request['id'],'result':result}
        except Exception as exc:
            # No keys, raw memory, source message text or traceback in output.
            response={'id':request.get('id'),'error':{'type':type(exc).__name__,'message':str(exc)[:300]}}
        print(json.dumps(response,ensure_ascii=False),flush=True)
