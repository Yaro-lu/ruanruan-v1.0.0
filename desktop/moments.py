#!/usr/bin/env python3
"""Reusable, explicitly invoked Moments publishing through the official GUI.

JSON stdin: post {requestId,text,images?:[absolute paths],publish?:false}
            status {requestId}
No schedule, conversation trigger, private protocol, or database key access.
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from wechat_gui import DATA, EXCHANGE, BASE, control, run, bridge_call, ui_session
from database_operator import PrivateReader, DesktopSecurityError, alert, save_json
from security_notify import detect_notice


class MomentsNotSent(RuntimeError):
    """The client explicitly rejected this post; it is not a send receipt."""


def normalized(text):
    return ''.join(str(text).split())


def center(item):
    points=item['box']
    return tuple(round(sum(p[i] for p in points)/len(points)) for i in (0,1))


def validate_id(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value):
        raise ValueError('requestId must contain 1–100 letters, digits, _ or -')
    return value


def payload(args):
    request_id=validate_id(args.get('requestId'))
    text=args.get('text')
    if not isinstance(text,str) or not text.strip() or len(text)>1000 or '\x00' in text:
        raise ValueError('Provide a nonempty caption of at most 1000 characters')
    images=args.get('images',[])
    if not isinstance(images,list) or len(images)>9 or any(not isinstance(p,str) for p in images):
        raise ValueError('images must contain 0–9 local PNG/JPEG paths')
    if 'publish' in args and not isinstance(args['publish'],bool):
        raise ValueError('publish must be a boolean; it defaults to false')
    files=[]
    for filename in images:
        path=Path(filename).expanduser().resolve(strict=True)
        if not path.is_file() or path.suffix.lower() not in ('.png','.jpg','.jpeg'):
            raise ValueError('Only local PNG/JPEG images are supported')
        if not 0<path.stat().st_size<=32*1024*1024:
            raise ValueError('Each image must be nonempty and no larger than 32 MiB')
        data=path.read_bytes()
        if not (data.startswith(b'\x89PNG\r\n\x1a\n') or data.startswith(b'\xff\xd8\xff')):
            raise ValueError('Image file does not contain PNG/JPEG data')
        files.append({'path':str(path),'sha256':hashlib.sha256(data).hexdigest()})
    content={'text':text,'images':files}
    fingerprint=hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    return request_id,content,fingerprint,args.get('publish',False)


class Receipts:
    def __init__(self,directory=DATA/'moments'):
        self.directory=Path(directory)

    def read(self,request_id):
        path=self.directory/(validate_id(request_id)+'.json')
        if not path.exists():return {'requestId':request_id,'status':'not_found','published':False}
        value=json.loads(path.read_text())
        # Persisted before the click: a killed process must never repeat it.
        if value['status']=='publishing':
            return {**value,'status':'uncertain','published':False,
                    'error':'Publishing was attempted; inspect the saved evidence, do not retry'}
        return value

    def save(self,value):
        value={**value,'updatedAt':datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()}
        save_json(self.directory/(validate_id(value['requestId'])+'.json'),value)
        return value


class MomentsUI:
    """OCR locates labeled controls; observed icon offsets follow their window."""
    def __init__(self,reader,folder):
        self.reader=reader
        self.folder=Path(folder)
        self.folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.sequence=0
        self.owned=False
        self.composing=False
        self.geometry=None
        self.last_screen=None

    def windows(self):
        windows={}
        for window in control('windows',{})['windows']:
            if window['title'] not in ('微信','朋友圈','选择文件'):continue
            raw=run(BASE+['xdotool','getwindowgeometry','--shell',window['id']]).decode()
            g={k:int(v) for k,v in (line.split('=',1) for line in raw.splitlines() if '=' in line)
               if k in ('X','Y','WIDTH','HEIGHT')}
            if window['title'] in windows:raise RuntimeError('Ambiguous '+window['title']+' window')
            windows[window['title']]={**g,'id':window['id']}
        return windows

    def observe(self,label='screen'):
        self.sequence+=1
        target=self.folder/f'{self.sequence:02d}-{label}.png'
        shutil.copy2(control('screenshot',{})['screenshot'],target)
        self.last_screen=str(target)
        items=self.reader.call('ocr',{'path':'/exchange/'+str(target.relative_to(EXCHANGE))})['items']
        windows=self.windows()
        # Inspect even a small login/security window before checking its size.
        for name in ('微信','朋友圈'):
            if name in windows:
                notice=detect_notice(items,windows[name])
                if notice:raise DesktopSecurityError(notice['reason'],notice['kind'],str(target))
        return {'items':items,'windows':windows,'screenshot':str(target)}

    @staticmethod
    def find(observation,text,geometry=None,prefix=False):
        matches=[]
        for item in observation['items']:
            value=normalized(item['text']);wanted=normalized(text)
            if item.get('score',1)<.65 or not (value.startswith(wanted) if prefix else value==wanted):continue
            x,y=center(item)
            if geometry and not (geometry['X']<=x<=geometry['X']+geometry['WIDTH']
                                 and geometry['Y']<=y<=geometry['Y']+geometry['HEIGHT']):continue
            matches.append(item)
        if len(matches)!=1:return None
        return matches[0]

    def click_label(self,observation,text,geometry=None,prefix=False):
        item=self.find(observation,text,geometry,prefix)
        if not item:raise RuntimeError('Visible control not uniquely identified: '+text)
        x,y=center(item)
        control('click',{'x':x,'y':y,'capture':False})

    def wait_for(self,predicate,label,timeout=8):
        deadline=time.monotonic()+timeout
        while True:
            observed=self.observe(label)
            if predicate(observed):return observed
            if time.monotonic()>=deadline:raise RuntimeError('Expected Moments screen was not visible: '+label)
            time.sleep(.4)

    def prepare(self,text,images):
        if images:
            # Pillow already ships in the desktop image. Validate every selected
            # file before opening a dialog; no partial image selection is accepted.
            run(BASE+['/lsiopy/bin/python3','-c',
                'from PIL import Image; import sys\nfor p in sys.argv[1:]:\n with Image.open(p) as im: im.verify()',*images])
        before=self.observe('before')
        if '朋友圈' in before['windows'] or '选择文件' in before['windows']:
            raise RuntimeError('An existing Moments window or file dialog is open; its draft was preserved')
        main=before['windows'].get('微信')
        if not main or main['WIDTH']<800 or main['HEIGHT']<600:
            raise RuntimeError('Logged-in WeChat chat window is unavailable')
        control('click',{'x':main['X']+31,'y':main['Y']+259,'capture':False})
        opened=self.wait_for(lambda o:'朋友圈' in o['windows'],'opened')
        self.owned=True
        self.geometry=g=opened['windows']['朋友圈']
        if g['WIDTH']<400 or g['HEIGHT']<500:raise RuntimeError('Moments window is too small')
        # The camera is in the observed top toolbar, relative to the actual window.
        control('click',{'x':g['X']+66,'y':g['Y']+24,'button':1 if images else 3,'capture':False})
        if images:
            picker=self.wait_for(lambda o:'选择文件' in o['windows'],'file-picker')
            field=self.find(picker,'文件名',picker['windows']['选择文件'],prefix=True)
            if not field:raise RuntimeError('File-name field was not visible')
            x,y=center(field)
            control('click',{'x':x+180,'y':y,'capture':False})
            control('key',{'key':'ctrl+a','capture':False})
            control('paste_text',{'text':' '.join('"'+p+'"' for p in images),'capture':False})
            control('key',{'key':'Return','capture':False})
        else:
            menu=self.wait_for(lambda o:self.find(o,'发表文字',g),'text-menu')
            self.click_label(menu,'发表文字',g)
        editor=self.wait_for(lambda o:self.find(o,'谁可以看',g) and self.find(o,'发表',g),'editor')
        placeholder=self.find(editor,'这一刻的想法',g,prefix=True)
        if not placeholder:raise RuntimeError('An existing Moments draft was preserved; empty editor expected')
        self.composing=True
        x,y=center(placeholder)
        control('click',{'x':x,'y':y,'capture':False})
        control('paste_text',{'text':text,'capture':False})
        control('key',{'key':'ctrl+a','capture':False})
        control('key',{'key':'ctrl+c','capture':False})
        if control('read_clipboard',{}).get('text')!=text:
            raise RuntimeError('Visible Moments caption does not match the supplied text')
        control('key',{'key':'Right','capture':False})
        final=self.observe('draft')
        audience=self.find(final,'谁可以看',g)
        public=self.find(final,'公开',g)
        if not audience or not public or abs(center(audience)[1]-center(public)[1])>15:
            raise RuntimeError('Audience is not confirmed as 公开; no privacy settings were changed')
        button=self.find(final,'发表',g)
        if not button:raise RuntimeError('Publish button is missing')
        x,y=center(button)
        if not self.reader.call('green',{'path':'/exchange/'+str(Path(final['screenshot']).relative_to(EXCHANGE)),
                                       'point':[x,y]})['enabled']:
            raise RuntimeError('Publish button is not enabled')
        return final

    def publish(self,draft,text):
        self.click_label(draft,'发表',self.geometry)
        # A UI receipt, not a fabricated Moments server ID or reader DB receipt.
        g=self.geometry
        expected=normalized(text)[:60]
        def visible_post(observed):
            rejected=next((self.find(observed,word,g) for word in ('照片未发送','发表失败','发送失败')
                           if self.find(observed,word,g)),None)
            if rejected:
                main=observed['windows'].get('微信')
                sidebar=[normalized(i['text']) for i in observed['items'] if main
                         and main['X']+55<=center(i)[0]<=main['X']+300]
                if any('微信团队' in word for word in sidebar) and any('微信安全提' in word for word in sidebar):
                    raise DesktopSecurityError('朋友圈显示“'+rejected['text']+'”，微信团队出现微信安全提醒；保留现场，未重试。',
                                               'security',observed['screenshot'])
                raise MomentsNotSent('微信客户端提示：'+rejected['text']+'；未重试')
            if '朋友圈' not in observed['windows'] or self.find(observed,'谁可以看',g):return False
            body=[item for item in observed['items'] if g['X']+60<=center(item)[0]<=g['X']+g['WIDTH']-10
                  and g['Y']+320<=center(item)[1]<=g['Y']+g['HEIGHT']]
            body.sort(key=lambda item:(round(center(item)[1]/8),center(item)[0]))
            words=''.join(normalized(item['text']) for item in body)
            # Own author and caption must be together in the newly displayed top card.
            return '阮阮' in words and expected in words
        result=self.wait_for(visible_post,'published',timeout=15)
        self.composing=False
        return result

    def close(self):
        if not self.owned:return
        observed=self.observe('cleanup')
        g=self.geometry
        picker=observed['windows'].get('选择文件')
        if picker:
            self.click_label(observed,'取消',picker)
            observed=self.observe('picker-cancelled')
        has_editor=bool(self.find(observed,'谁可以看',g))
        if has_editor and not self.composing:
            raise RuntimeError('An existing Moments draft is still open and was preserved')
        if self.composing and has_editor:
            self.click_label(observed,'取消',g)
            observed=self.observe('cancel')
            if self.find(observed,'不保留',g):
                self.click_label(observed,'不保留',g)
                observed=self.observe('discarded')
            if self.find(observed,'谁可以看',g):raise RuntimeError('The preview editor did not close')
            self.composing=False
        if '朋友圈' in observed['windows']:
            control('click',{'x':g['X']+g['WIDTH']-32,'y':g['Y']+24,'capture':False})
        self.owned=False


def execute(args,receipts=None,reader_factory=None,ui_factory=MomentsUI):
    request_id,content,fingerprint,publish=payload(args)
    receipts=receipts or Receipts()
    with ui_session(blocking=False) as acquired:
        if not acquired:return {'requestId':request_id,'status':'busy','published':False}
        old=receipts.read(request_id)
        if old['status']!='not_found':
            if old.get('fingerprint')!=fingerprint:raise ValueError('requestId already refers to different content')
            if old['status']!='preview' or not publish:return old
        status=bridge_call('status',{})
        if not status.get('enabled') or status.get('paused'):
            return {'requestId':request_id,'status':'paused','published':False}
        if status.get('uiBusy'):
            return {'requestId':request_id,'status':'busy','published':False}
        settings=json.loads((DATA/'database.json').read_text())
        folder=EXCHANGE/'moments'/request_id
        folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        staged=[]
        for index,file in enumerate(content['images']):
            source=Path(file['path']);target=folder/f'{index+1:02d}{source.suffix.lower()}'
            shutil.copyfile(source,target)
            if hashlib.sha256(target.read_bytes()).hexdigest()!=file['sha256']:
                raise RuntimeError('Image changed while staging')
            staged.append('/exchange/'+str(target.relative_to(EXCHANGE)))
        value={'requestId':request_id,'fingerprint':fingerprint,'text':content['text'],
               'images':content['images'],'status':'preparing','published':False,'audience':'公开',
               'autonomous':False,'createdAt':old.get('createdAt',datetime.now(ZoneInfo('Asia/Shanghai')).isoformat())}
        receipts.save(value)
        reader=None;ui=None;attempted=False;security=False
        try:
            reader=(reader_factory or (lambda:PrivateReader(settings,'vision-client')))()
            ui=ui_factory(reader,folder/'evidence')
            draft=ui.prepare(content['text'],staged)
            value.update(previewScreenshot=draft['screenshot'])
            if publish:
                value['status']='publishing';receipts.save(value)
                attempted=True
                result=ui.publish(draft,content['text'])
                value.update(status='published',published=True,screenshot=result['screenshot'],
                             receipt='visible_own_post',publishedAt=datetime.now(ZoneInfo('Asia/Shanghai')).isoformat())
            else:
                value.update(status='preview',screenshot=draft['screenshot'])
        except Exception as error:
            security=isinstance(error,DesktopSecurityError)
            value.update(status='blocked' if security else 'not_sent' if isinstance(error,MomentsNotSent)
                         else 'uncertain' if attempted else 'failed',
                         error=str(error)[:500],published=False)
            if ui and ui.last_screen:value['screenshot']=ui.last_screen
            if security:alert(error,settings)
        finally:
            if ui and not security:
                try:ui.close()
                except Exception as error:
                    value['cleanupError']=str(error)[:300]
                    # An unresolved popup must not receive the next chat reply.
                    alert(error,settings)
            if reader:reader.close()
        return receipts.save(value)


def dispatch(action,args):
    if action=='status':return Receipts().read(args.get('requestId'))
    if action=='post':return execute(args)
    raise ValueError('Unknown Moments action')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=('post','status'))
    options=parser.parse_args()
    try:
        result=dispatch(options.action,json.load(sys.stdin))
        print(json.dumps(result,ensure_ascii=False))
        return 0 if result['status'] in ('preview','published') else 2
    except Exception as error:
        print(json.dumps({'status':'error','published':False,'error':str(error)},ensure_ascii=False))
        return 1


if __name__=='__main__':sys.exit(main())
