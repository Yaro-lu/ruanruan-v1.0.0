#!/usr/bin/env python3
"""Event transport: private SQLCipher reader plus local X11/clipboard actions.

Normal operation is scripted; failures may use bounded visual model assistance.
"""
import argparse
import atexit
import fcntl
import json
import os
from pathlib import Path
import re
import selectors
import signal
import shutil
import subprocess
import struct
import sys
import time
import threading
import queue
import unicodedata
from datetime import datetime
from contextlib import contextmanager
from contextvars import ContextVar

from wechat_gui import DATA, EXCHANGE, CONTAINER, BASE, control, run, bridge_call, BRIDGE_CONFIG, ui_session
from security_notify import detect_notice, notify_control, channel_label
from model_recovery import ModelRecovery
from deployment_hold import deployment_held
from transport_recovery import TransportHealth, RecoveryBackoff, durable_json
from repair_queue import enqueue_repair, cancel_repair

SETTINGS = DATA/'database.json'
STATE = DATA/'database-state'
RECOVERY = ContextVar('wechat_visual_recovery',default=None)


@contextmanager
def recovery_scope(settings,delivery=None):
    if RECOVERY.get() is not None or not settings.get('modelRecovery',{}).get('enabled'):
        yield;return
    token=RECOVERY.set({'model':ModelRecovery(max_calls=4),'settings':settings,
        'delivery':delivery,'attempted':False})
    try:yield
    finally:RECOVERY.reset(token)


def ask_recovery(stage,error,geometry,screen,regions=None,observations=None):
    context=RECOVERY.get()
    if context is None or context.get('halted'):return None
    if 'repairId' not in context:
        try:context['repairId']=enqueue_repair(stage,str(error),context['settings'],context['delivery'],screen,
            observations={**(observations or {}),'geometry':geometry,'regions':regions or []})
        except Exception as queue_error:
            context['repairId']=None
            print(json.dumps({'event':'repair-enqueue-failed','error':str(queue_error)[:200]}),flush=True)
    failure=str(error)
    for attempt in range(2):
        result=context['model'].analyze(stage,screen,failure,context['settings'],geometry,
            delivery=context['delivery'],allowed_regions=regions or [],attempted=context['attempted'])
        issue=(result or {}).get('error') or (context['model'].last_error if result is None else None)
        print(json.dumps({'event':'model-recovery','stage':'receipt' if context['attempted'] else stage,
            'delivery':(context['delivery'] or {}).get('id'),'attempt':attempt+1,
            'decision':(result or {}).get('decision'),'elapsedMs':(result or {}).get('elapsedMs'),
            'error':issue},ensure_ascii=False),flush=True)
        code=issue.get('code') if isinstance(issue,dict) else issue
        if code in ('quota_exhausted','lease_unavailable','lease_expired_after_planning'):
            context['halted']=True
        if stage not in ('conversation','mention','inspect') or code not in (
                'invalid_output','model_error','timeout','invalid_planner_result','planner_timeout','planner_unavailable'):
            break
        failure='上次视觉判断未通过：'+str(issue)+'\n原故障：'+str(error)
    if result and result.get('screen') in ('security','logged_out'):
        if context.get('repairId'):
            try:cancel_repair(context['repairId'],'账号安全或登录提示，交由管理者处理')
            except Exception:pass
        raise DesktopSecurityError(result['reason'],
            'logout' if result['screen']=='logged_out' else 'security',screen)
    if result and result.get('point') and window_geometry()!=geometry:
        raise RuntimeError('Window moved during model recovery; stale coordinates were discarded')
    return result


def model_view(settings,error,current=None,header_only=False):
    if RECOVERY.get() is None:return None
    geometry=(current or {}).get('geometry') or window_geometry()
    screen,captured=capture_screen()
    x,y,w,h=(geometry[k] for k in ('X','Y','WIDTH','HEIGHT'))
    regions=[] if header_only else [{'id':'send_button','x':x+w-105,'y':y+h-60,'width':95,'height':50}]
    result=ask_recovery('inspect',error,geometry,screen,regions)
    if not result or result.get('screen')!='chat' or result.get('decision')=='stop':return None
    matched=result.get('targetMatches') and normalize_label(result.get('observedText',''),settings.get('kind')=='group')==normalize_label(settings['uiLabel'])
    point=result.get('point');buttons=[]
    if point and point['regionId']=='send_button':buttons=[(point['x'],point['y'])]
    return {'screen':screen,'geometry':geometry,'ownerVisible':bool(matched),'sendButtons':buttons,
        'capturedAt':captured,'fullInspection':True,'timing':{},'modelAssisted':True}

class DesktopSecurityError(RuntimeError):
    def __init__(self,reason,kind='security',screenshot=None):
        super().__init__(reason);self.kind=kind;self.screenshot=screenshot

class UncertainDelivery(RuntimeError):
    pass

def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    temp.chmod(0o600);temp.replace(path)


class ReaderQueue:
    """One stdio exchange at a time; queued send checks precede media work."""
    def __init__(self):
        self.condition=threading.Condition()
        self.waiting=[];self.sequence=0;self.active=False

    @contextmanager
    def acquire(self, priority, timeout):
        deadline=time.monotonic()+timeout
        with self.condition:
            self.sequence+=1;ticket=(priority,self.sequence)
            self.waiting.append(ticket)
            try:
                while self.active or min(self.waiting)!=ticket:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:raise TimeoutError('Reader queue timed out before starting a request')
                    self.condition.wait(remaining)
                self.active=True
            finally:
                self.waiting.remove(ticket)
                self.condition.notify_all()
        try:yield
        finally:
            with self.condition:
                self.active=False;self.condition.notify_all()


class PrivateReader:
    def __init__(self, settings, purpose='database'):
        account=settings['accountDirectory']
        args=['docker','run','--rm','-i','--name','ruanruan-wechat-vision' if purpose=='vision' else 'ruanruan-wechat-reader',
              '--network','none','--pid','container:'+CONTAINER,
              '--cap-drop','ALL','--cap-add','SYS_PTRACE','--cap-add','DAC_READ_SEARCH','--cap-add','DAC_OVERRIDE',
              '--security-opt','no-new-privileges=true','--read-only',
              '--tmpfs','/tmp:rw,nosuid,size=128m','--memory','640m','--memory-swap','1g',
              '--cpus','0.7','--pids-limit','80','-e','LD_PRELOAD=',
              '-e','OMP_NUM_THREADS=1','-e','OPENBLAS_NUM_THREADS=1',
              '-v',str(DATA/'config'/'xwechat_files'/account)+':/config/xwechat_files/'+account+':ro',
              '-v',str(EXCHANGE)+':/exchange:rw']
        for relative in ('.xwechat/net/kvcomm','app_data/net/kvcomm','xwechat/net/kvcomm'):
            source=DATA/'config'/relative
            if source.is_dir():args.extend(['-v',str(source)+':/config/'+relative+':ro'])
        if purpose=='vision':
            # OCR has no database mount, PID access or key-scanning capability.
            args=['docker','run','--rm','-i','--name','ruanruan-wechat-vision','--network','none',
                  '--user',str(os.getuid())+':'+str(os.getgid()),
                  '--cap-drop','ALL','--security-opt','no-new-privileges=true','--read-only',
                  '--tmpfs','/tmp:rw,nosuid,size=64m','--memory','640m','--memory-swap','1g',
                  '--cpus','1.5','--pids-limit','64','-e','LD_PRELOAD=',
                  '-e','OMP_NUM_THREADS=1','-e','OPENBLAS_NUM_THREADS=1','-v',str(EXCHANGE)+':/exchange:rw']
        if purpose=='vision-client':
            # An extra stdio OCR connection in the existing isolated vision
            # container; no new reader, database access or key discovery.
            args=['docker','exec','-i','ruanruan-wechat-vision',
                  '/opt/ruanruan-reader/bin/python','-u','/opt/ruanruan-reader/rpc.py']
        else:
            args.extend(['--label','com.docker.compose.project=ruanruan-wechat-desktop',
                         '--label','com.docker.compose.service='+('vision' if purpose=='vision' else 'reader'),
                         '--label','managed-by=database-operator',settings['readerImage']])
        self.queue=ReaderQueue()
        self.process=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=None,bufsize=0)
        self.sequence=0;self.buffer=b'';self.broken=False;self.selector=selectors.DefaultSelector()
        self.selector.register(self.process.stdout,selectors.EVENT_READ)
        atexit.register(self.close)

    def call(self, method, args=None, timeout=30):
        priority=0 if method in ('prepare','verify','reconcile') else 2 if method in ('resolve-media','poll-media') else 1
        queued=time.monotonic()
        with self.queue.acquire(priority,timeout):
            started=time.monotonic();remaining=timeout-(started-queued)
            if remaining<=0:raise TimeoutError('Reader queue timed out before starting a request')
            result=self._call(method,args,remaining)
            if isinstance(result,dict):
                result={**result,'_rpcTiming':{'lockWaitMs':round((started-queued)*1000,3),
                    'rpcMs':round((time.monotonic()-started)*1000,3)}}
            return result

    def _call(self, method, args=None, timeout=30):
        if getattr(self,'broken',False):
            raise RuntimeError('Read-only worker connection is invalid; restart required')
        self.sequence+=1
        deadline=time.monotonic()+timeout
        # Bound writes too: a wedged worker may stop reading its pipe.
        data=(json.dumps({'id':self.sequence,'method':method,'args':args or {}},ensure_ascii=False)+'\n').encode()
        consumed=False
        try:
            fd=self.process.stdin.fileno();os.set_blocking(fd,False)
            with selectors.DefaultSelector() as writable:
                writable.register(fd,selectors.EVENT_WRITE)
                while data:
                    remaining=deadline-time.monotonic()
                    if remaining<=0:raise TimeoutError('Read-only worker input timed out')
                    if not writable.select(min(remaining,1)):continue
                    try:
                        written=os.write(fd,data)
                        if written<=0:raise BrokenPipeError('Read-only worker input stopped')
                        data=data[written:]
                    except BlockingIOError:continue
            while True:
                while b'\n' in self.buffer:
                    line,self.buffer=self.buffer.split(b'\n',1)
                    value=json.loads(line)
                    if not isinstance(value,dict) or type(value.get('id')) is not int or value['id']!=self.sequence:
                        raise RuntimeError('Reader response order mismatch')
                    if 'error' in value:
                        error=value['error']
                        if not isinstance(error,dict) or not isinstance(error.get('type'),str) or not isinstance(error.get('message'),str) or 'result' in value:
                            raise RuntimeError('Invalid reader error response')
                        consumed=True
                        raise RuntimeError('Read-only worker: '+error['type']+': '+error['message'])
                    if 'result' not in value:raise RuntimeError('Invalid reader result response')
                    consumed=True
                    return value['result']
                remaining=deadline-time.monotonic()
                if remaining<=0:raise RuntimeError('Read-only worker timed out; no send retry')
                if not self.selector.select(min(remaining,1)):continue
                chunk=os.read(self.process.stdout.fileno(),65536)
                if not chunk:raise RuntimeError('Read-only worker stopped')
                self.buffer+=chunk
        except BaseException:
            # Once an exchange starts, an incomplete or malformed response
            # leaves the stream boundary uncertain. Never send another request
            # into that pipe or mistake a late reply for its result. A complete
            # business error frame is safe to consume and does not break stdio.
            if not consumed:self.broken=True
            raise

    def close(self):
        self.broken=True
        if self.process.poll() is None:
            self.process.stdin.close()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.terminate()
                try:self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=3)
        self.selector.close()
        self.process.stdout.close()


class ReaderServices:
    def __init__(self,database,vision):self.database=database;self.vision=vision
    def call(self,method,args=None,timeout=30):
        return (self.vision if method in ('ocr','blank','green') else self.database).call(method,args,timeout)


def window_geometry():
    # X11 windows may disappear while xdotool traverses them. Rediscover on
    # BadWindow only; never retry clicks, sends, or other transport failures.
    for attempt in range(3):
        try:
            ids=run(BASE+['xdotool','search','--onlyvisible','--name','^微信$']).decode().split()
            if len(ids)!=1:raise RuntimeError('WeChat main window is missing or ambiguous')
            raw=run(BASE+['xdotool','getwindowgeometry','--shell',ids[0]]).decode()
            break
        except RuntimeError as exc:
            if 'BadWindow (invalid Window parameter)' not in str(exc) or attempt==2:raise
            print('X11 BadWindow during window lookup; rediscovering window',file=sys.stderr,flush=True)
            time.sleep(.1*(attempt+1))
    fields=dict(line.split('=',1) for line in raw.splitlines() if '=' in line)
    return {k:int(fields[k]) for k in ('X','Y','WIDTH','HEIGHT')}


def normalize_label(value, group=False):
    label=''.join(value.split())
    return re.sub(r'[（(]\d+[）)]$', '', label) if group else label


def conversation_label_matches(text, settings, *, search=False):
    group = settings.get('kind') == 'group'
    actual = normalize_label(text, group)
    expected = normalize_label(settings['uiLabel'], group)
    if actual == expected:return True
    if not group or not settings.get('username'):return False
    truncated = re.fullmatch(r'(.+?)(?:…+|\.{3})', actual) if search else None
    # OCR can omit emoji in a title, and search rows can visibly end in an
    # ellipsis. Accept only an exact remaining name/prefix belonging to one
    # known room; keep the full title check after opening the search result.
    def key(value):
        return ''.join(c for c in value if unicodedata.category(c) not in ('So', 'Cf', 'Mn'))
    observed = key(truncated.group(1) if truncated else actual)
    if not observed:return False
    contacts = json.loads(BRIDGE_CONFIG.read_text())['contacts']
    owners = {c['username'] for c in contacts if c.get('kind') == 'group' and c.get('username')
              and (key(normalize_label(c['uiLabel'], True)).startswith(observed) if truncated
                   else key(normalize_label(c['uiLabel'], True)) == observed)}
    target = key(expected)
    matches = target.startswith(observed) if truncated else target == observed
    return matches and owners == {settings['username']}


def register_routes(routes):
    if not routes:return
    bridge=json.loads(BRIDGE_CONFIG.read_text())
    contacts={c['peerId']:c for c in bridge['contacts']}
    for route in routes:contacts[route['peerId']]=route
    updated={**bridge,'multiUser':True,'contacts':list(contacts.values())}
    if updated!=bridge:
        identity_fields=lambda value:[{k:v for k,v in contact.items() if k!='rosterObservedAt'} for contact in value['contacts']]
        changed_identities=identity_fields(updated)!=identity_fields(bridge)
        save_json(BRIDGE_CONFIG,updated)
        if changed_identities:bridge_call('sync-identities',{})


def initialize_reader(current, settings, cursorpath, expected=None, prepare=False):
    cursor=json.loads(cursorpath.read_text()) if cursorpath.exists() else None
    result=current.call('init',{'settings':settings,'cursor':cursor},timeout=180)
    binding={k:result['binding'][k] for k in ('accountDirectory','selfUsername','ownerUsername')}
    if not prepare and binding!=expected:
        raise DesktopSecurityError('Database identity differs from the prepared binding')
    register_routes(result.get('routes',[]))
    next_cursor=result['cursor']
    if prepare:
        # Preparation runs while receiving is disabled and before binding the
        # bridge. Keep live watermarks, but leave unimported room history pending
        # for the first enabled startup. New messages after these watermarks
        # still take the normal poll path rather than becoming background.
        next_cursor={**next_cursor,'contextRooms':list((cursor or {}).get('contextRooms',[]))}
    else:
        accept_events(result.get('baselineEvents',[]),settings)
    save_json(cursorpath,next_cursor)
    save_json(STATE/'routes.json',{'routes':result.get('routes',[]),'at':time.time()})
    return result


def add_elapsed(timings,key,started):
    if timings is not None:timings[key]=timings.get(key,0)+round((time.perf_counter()-started)*1000)


def capture_screen(timings=None):
    captured=time.monotonic();started=time.perf_counter()
    screen=control('screenshot',{})['screenshot']
    add_elapsed(timings,'screenshotMs',started)
    return screen,captured


def measured_read(reader,method,args,timings=None):
    started=time.perf_counter();result=reader.call(method,args)
    if timings is not None:
        if method=='ocr':
            add_elapsed(timings,'regionOcrMs' if args.get('rect') else 'fullOcrMs',started)
            timings['ocrCalls']=timings.get('ocrCalls',0)+1
            timings['ocrCacheHits']=timings.get('ocrCacheHits',0)+int(bool(result.get('cacheHit')))
            if isinstance(result.get('elapsedMs'),(int,float)):
                timings['ocrWorkerMs']=timings.get('ocrWorkerMs',0)+result['elapsedMs']
        rpc=result.get('_rpcTiming') or {}
        for name in ('lockWaitMs','rpcMs'):
            if isinstance(rpc.get(name),(int,float)):
                key=method+name[:1].upper()+name[1:]
                timings[key]=timings.get(key,0)+rpc[name]
    return result


def view(reader, settings, full=False, header_only=False):
    timings={};started=time.perf_counter();geometry=window_geometry()
    add_elapsed(timings,'geometryMs',started)
    x,y,w,h=(geometry[k] for k in ('X','Y','WIDTH','HEIGHT'))
    screen,captured=capture_screen(timings)
    small=w<800 or h<600
    header_rect=[x+300,y+30,w-415,50]
    send_rect=[x+w-105,y+h-60,95,50]
    items=[]
    for rect in (() if full or small else (header_rect,) if header_only else (header_rect,send_rect)):
        for item in measured_read(reader,'ocr',{'path':'/exchange/desktop.png','rect':rect},timings)['items']:
            item={**item,'box':[[px+rect[0],py+rect[1]] for px,py in item['box']]};items.append(item)
    # Unknown/blocked windows still get the full security/logout inspection.
    # A recognizable different chat title is an ordinary conversation switch,
    # not a reason to OCR all of its chat history before searching the target.
    has_header=any(i['score']>=.8 and header_rect[0]<=sum(p[0] for p in i['box'])/4<header_rect[0]+header_rect[2]
        and header_rect[1]<=sum(p[1] for p in i['box'])/4<header_rect[1]+header_rect[3] for i in items)
    inspected_full=full or small or not has_header
    if inspected_full:
        items=measured_read(reader,'ocr',{'path':'/exchange/desktop.png'},timings)['items']
    notice=detect_notice(items,geometry)
    if notice:raise DesktopSecurityError(notice['reason'],notice['kind'],screen)
    if small:raise RuntimeError('WeChat window is too small for the calibrated layout')
    header=[];buttons=[]
    for item in items:
        box=item['box'];cx=sum(p[0] for p in box)/4;cy=sum(p[1] for p in box)/4
        if x+300<=cx<x+w-115 and y+30<=cy<y+80:header.append(item['text'])
        if normalize_label(item['text'])=='发送' and item['score']>=.8:buttons.append((round(cx),round(cy)))
    return {'screen':screen,'geometry':geometry,
            'ownerVisible':conversation_label_matches(''.join(header),settings),
            'sendButtons':buttons,'capturedAt':captured,'fullInspection':inspected_full,'timing':timings}


def inspected_view(reader,settings,*,full=False,header_only=False,timings=None,health=None):
    kwargs={'full':True} if full else {'header_only':True} if header_only else {}
    try:current=view(reader,settings,**kwargs)
    except DesktopSecurityError:raise
    except Exception as error:
        current=model_view(settings,error,header_only=header_only)
        if current is None:raise
    if timings is not None:
        for key,value in current.get('timing',{}).items():timings[key]=timings.get(key,0)+value
    if health is not None and current.get('fullInspection'):
        # Freshness starts at screenshot acquisition, not after a slow OCR call.
        health.update(last=current['capturedAt'],failures=0)
    return current


def ensure_owner(reader, settings, lease, timings=None, health=None):
    if settings.get('kind') == 'group' and settings['uiLabel'].endswith('@chatroom'):
        raise RuntimeError('Group display title is not available in current contact metadata')
    current=inspected_view(reader,settings,header_only=True,timings=timings,health=health)
    if current['ownerVisible']:return current
    g=current['geometry'];x,y=g['X'],g['Y']
    control('click',{'capture':False,'x':x+145,'y':y+56,'leaseId':lease})
    control('key',{'capture':False,'key':'ctrl+a','leaseId':lease})
    control('paste_text',{'capture':False,'text':settings['uiLabel'],'leaseId':lease})
    # Search result is selected by visible exact label, not a guessed first row.
    capture_screen(timings)
    try:items=measured_read(reader,'ocr',{'path':'/exchange/desktop.png','rect':[x+60,y+80,300,min(g['HEIGHT']-100,500)]},timings)['items']
    except RuntimeError:items=[]
    center_y=lambda item:sum(p[1] for p in item['box'])/4
    # Web suggestions can repeat the exact contact label below the local hit.
    # Keep their section boundary so they cannot inherit the "联系人" heading.
    sections=[i for i in items if normalize_label(i['text']) in
              ('群聊','联系人','好友','最近聊天','搜索网络结果','聊天记录','公众号','小程序','搜一搜')]
    def local_result(item):
        preceding=[s for s in sections if center_y(s)<center_y(item)]
        if not preceding:return False
        section=normalize_label(max(preceding,key=center_y)['text'])
        return section in (('群聊','最近聊天') if settings.get('kind')=='group' else ('联系人','好友','最近聊天'))
    exact=[i for i in items if local_result(i) and conversation_label_matches(i['text'],settings,search=True) and i['score']>=.8]
    if len(exact)!=1:
        result=ask_recovery('conversation','Exact conversation search result is missing or ambiguous',g,current['screen'],
            [{'id':'conversation_candidates','x':x+60,'y':y+80,'width':300,'height':min(g['HEIGHT']-100,500)}])
        if not result or result.get('decision')!='locate' or not result.get('point'):
            raise RuntimeError('Exact conversation search result is missing or ambiguous')
        cx,cy=result['point']['x'],result['point']['y']
    else:
        box=exact[0]['box'];cx=x+60+sum(p[0] for p in box)/4;cy=y+80+sum(p[1] for p in box)/4
    control('click',{'capture':False,'x':round(cx),'y':round(cy),'leaseId':lease})
    current=inspected_view(reader,settings,header_only=True,timings=timings,health=health)
    if not current['ownerVisible']:
        current=model_view(settings,'Conversation title OCR did not match the verified contact',current,header_only=True) or current
    if not current['ownerVisible']:raise RuntimeError('Conversation title did not match verified contact')
    return current


def compose_is_empty(reader, geometry):
    x,y,w,h=(geometry[k] for k in ('X','Y','WIDTH','HEIGHT'))
    return reader.call('blank',{'path':'/exchange/desktop.png',
        'rect':[x+315,y+h-130,w-335,70]})['blank']


def read_composer(lease):
    return control('read_composer',{'leaseId':lease})['text']


def native_prefixes(names):
    return ['@'+name+separator for name in names for separator in ('\u2005',' ')]


class OwnedDraft:
    """Only text written after a verified empty composer belongs to this send."""
    def __init__(self):self.expected=set()
    def expect(self,values):
        # Linux WeChat sometimes adds one leading U+2005 before a native chip.
        self.expected={variant for value in values for variant in (value,'\u2005'+value)}
    def clear(self,current,lease):
        if not self.expected or not current or not current.get('ownerVisible'):return False
        g=current['geometry']
        control('key',{'capture':False,'key':'Escape','leaseId':lease})
        control('click',{'capture':False,'x':g['X']+340,'y':g['Y']+g['HEIGHT']-115,'leaseId':lease})
        result=control('clear_composer',{'leaseId':lease,'expected':sorted(self.expected)})
        if result.get('cleared'):
            self.expected.clear();return True
        return False


def mention_key(name):
    # Used only to locate readable labels; copied native names remain exact.
    value=unicodedata.normalize('NFKC',name).casefold()
    return ''.join(c for c in value if c.isalnum() or c=='_')


def mention_candidate(items, mention, members=None, render_names=None):
    """Resolve one visible label to one member, never by nickname alone.

    Readable labels can identify one account. A sole row from a uniquely named
    full-name search may be selected tentatively even when its text is unreadable,
    but its complete native chip must then be copied and checked immediately,
    before any body is appended. Sending is always separate.
    """
    names=list(dict.fromkeys([mention['name'],*(render_names or [])]))
    keys={mention_key(name) for name in names}
    def owners(predicate):
        return {member['username'] for member in members or [] if any(predicate(name)
            for name in [member['name'],*(member.get('mentionNames') or [])])}
    def unique(predicate):
        return bool(members) and owners(predicate)=={mention['username']}
    def matches(item):
        if item.get('score',0)<.8:return False
        label=item['text'].strip();key=mention_key(label)
        if not key:return False
        if key in keys:
            return unique(lambda name:mention_key(name)==key) if members is not None else label in names
        if members is None:return False
        truncated=re.fullmatch(r'(.+?)(?:\.{2,}|…+)',label)
        if truncated:
            prefix=mention_key(truncated.group(1))
            return len(prefix)>=4 and any(k.startswith(prefix) for k in keys) \
                and unique(lambda name:mention_key(name).startswith(prefix))
        return False
    candidates=[item for item in items if matches(item)]
    if not candidates and len(items)==1 and unique(lambda alias:alias==mention['name']):
        # A full-name search may locate a row whose decorative Unicode OCR
        # cannot read. Its box is only a tentative click target: the exact
        # native Unicode name and its unique roster owner must be copied and
        # checked before any reply text is appended, regardless of verify=False.
        item=items[0];box=item.get('box',[])
        if len(box)==4 and all(len(point)==2 for point in box) \
                and max(p[0] for p in box)>min(p[0] for p in box) \
                and max(p[1] for p in box)>min(p[1] for p in box):
            return {**item,'requiresChipCheck':True,'exactNativeName':True}
    if len(candidates)!=1:raise RuntimeError('Exact @ member candidate is missing or ambiguous')
    return candidates[0]


def select_mention(reader, current, mention, lease, render_names=None, members=None, *, draft=None, verify=True,timings=None):
    name=mention['name']
    x,y,w,h=(current['geometry'][k] for k in ('X','Y','WIDTH','HEIGHT'))
    # A failed previous attempt can leave the popup visible even after its draft
    # is removed. Close it before capturing the baseline used to detect new rows.
    control('click',{'capture':False,'x':x+w-30,'y':y+200,'leaseId':lease})
    capture_screen(timings)
    before=EXCHANGE/('mention-before-'+lease+'.png')
    shutil.copy2(current['screen'],before)
    try:
        control('click',{'capture':False,'x':x+340,'y':y+h-115,'leaseId':lease})
        if draft:draft.expect(['@'])
        control('key',{'capture':False,'key':'at','leaseId':lease})
        time.sleep(.3)
        if draft:draft.expect(['@','@'+name])
        control('paste_text',{'capture':False,'text':name,'leaseId':lease})
        time.sleep(.5)
        capture_screen(timings)
        # Only new popup labels above the editor count, not names in history.
        height=min(h-220,520)
        rect=[x+60,y+h-140-height,w-60,height]
        items=[]
        try:
            items=measured_read(reader,'ocr',{'path':'/exchange/desktop.png','rect':rect,
                'beforePath':'/exchange/'+before.name},timings)['items']
            candidate=mention_candidate(items,mention,members,render_names)
        except RuntimeError as error:
            result=ask_recovery('mention',error,current['geometry'],current['screen'],
                [{'id':'mention_candidates','x':rect[0],'y':rect[1],'width':rect[2],'height':rect[3]}],
                observations={'ocrItems':items,'members':members or [],'renderNames':render_names or [name],
                    'beforeScreenshot':str(before)})
            if not result or result.get('decision')!='locate' or not result.get('point'):raise
            owners={member['username'] for member in members or [] if name in
                [member['name'],*(member.get('mentionNames') or [])]}
            if owners!={mention['username']}:raise RuntimeError('Model candidate must identify one current member')
            point=result['point'];relative=[point['x']-rect[0],point['y']-rect[1]]
            candidate={'box':[relative]*4,'requiresChipCheck':True,'exactNativeName':True}
        box=candidate['box']
        names=render_names or [name]
        if draft:draft.expect(['@'+name,*native_prefixes(names)])
        control('click',{'capture':False,'x':round(rect[0]+sum(p[0] for p in box)/4),
            'y':round(rect[1]+sum(p[1] for p in box)/4),'leaseId':lease})
        # Refocus the editor without replacing the selected native mention.
        control('click',{'capture':False,'x':x+340,'y':y+h-115,'leaseId':lease})
        if not verify and not candidate.get('requiresChipCheck'):return
        control('key',{'capture':False,'key':'ctrl+End','leaseId':lease})
        copied=read_composer(lease).removeprefix('\u2005')
        selected_names=[label for label in names if copied.startswith('@'+label) and copied[len(label)+1:]
                        and all(c in ' \u2005' for c in copied[len(label)+1:])]
        if candidate.get('exactNativeName'):
            # Spaces or a Tab following a typed @ are not a native selection.
            selected_names=[label for label in names if copied=='@'+label+'\u2005'
                and {member['username'] for member in members or []
                     if label in [member['name'],*(member.get('mentionNames') or [])]}=={mention['username']}]
        elif candidate.get('requiresChipCheck'):
            selected_names=[label for label in selected_names if {member['username'] for member in members or []
                if any(mention_key(alias)==mention_key(label) for alias in [member['name'],*(member.get('mentionNames') or [])])}=={mention['username']}]
        if not selected_names:
            if draft and candidate.get('requiresChipCheck') and copied in native_prefixes(
                    [name for member in members or [] for name in [member['name'],*(member.get('mentionNames') or [])]]):
                # A tentative click created this exact, roster-known chip.
                # Recovery may remove it only while it remains unchanged;
                # unrelated text or a manually extended draft is not owned.
                draft.expect([copied])
            raise RuntimeError('Native @ member selection could not be confirmed')
        return copied
    finally:
        before.unlink(missing_ok=True)


def review_failure(reader, settings, error, delivery=None):
    with recovery_scope(settings,delivery):
        return _review_failure(reader,settings,error,delivery)


def _review_failure(reader, settings, error, delivery=None):
    """Inspect locally; spend model budget only if inspection itself fails."""
    screen=control('screenshot',{})['screenshot']
    folder=STATE/'recovery';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
    name=(delivery or {}).get('id','transport')+'-'+str(time.time_ns())
    saved=folder/(name+'.png');shutil.copyfile(screen,saved)
    try:
        current=inspected_view(reader,settings,full=True)
    except DesktopSecurityError:
        save_json(folder/(name+'.json'),{'error':str(error)[:300],'screenshot':str(saved),'status':'security_or_login'})
        raise
    except Exception as inspect_error:
        if RECOVERY.get() is None:
            save_json(folder/(name+'.json'),{'error':str(error)[:300],'screenshot':str(saved),'status':'unresolved','inspectionError':str(inspect_error)[:200]})
            return None
        try:geometry=window_geometry()
        except Exception:
            width,height=struct.unpack('>II',Path(screen).read_bytes()[16:24])
            geometry={'X':0,'Y':0,'WIDTH':width,'HEIGHT':height}
        decision=ask_recovery('recover',inspect_error,geometry,str(saved))
        if not decision or decision.get('decision')!='retry':
            save_json(folder/(name+'.json'),{'error':str(error)[:300],'screenshot':str(saved),'status':'model_unresolved'})
            return None
        current=inspected_view(reader,settings,full=True)
    save_json(folder/(name+'.json'),{'error':str(error)[:300],'screenshot':str(saved),'status':'inspected',
        'recipientVisible':current['ownerVisible'],'sendButtonCount':len(current['sendButtons'])})
    print(json.dumps({'event':'screenshot-recheck','delivery':(delivery or {}).get('id'),'recipientVisible':current['ownerVisible']}),flush=True)
    return current


def confirm_delivery(reader,settings,delivery,seconds):
    deadline=time.monotonic()+seconds
    timings={'verifyChecks':0,'verifyLockWaitMs':0.0,'verifyRpcMs':0.0,'verifyWaitMs':0.0}
    while True:
        started=time.monotonic()
        verified=reader.call('verify',{'wait':False})
        call=verified.get('_rpcTiming',{})
        timings['verifyChecks']+=1
        timings['verifyLockWaitMs']+=call.get('lockWaitMs',0)
        timings['verifyRpcMs']+=call.get('rpcMs',(time.monotonic()-started)*1000)
        if 'verifyQueryMs' in verified:
            timings['verifyQueryMs']=timings.get('verifyQueryMs',0.0)+verified['verifyQueryMs']
        if not verified.get('pending'):
            started=time.monotonic()
            bridge_call('receipt',{'id':delivery['id'],'leaseId':delivery['leaseId'],'status':'sent',
                'uiLabel':settings['uiLabel'],'database':verified['database']})
            record_done(delivery)
            timings['receiptMs']=(time.monotonic()-started)*1000
            return {key:round(value,3) for key,value in timings.items()}
        if time.monotonic()>=deadline:raise UncertainDelivery('No matching outgoing confirmation after screenshot review; retained without resending')
        started=time.monotonic()
        time.sleep(.2)
        timings['verifyWaitMs']+=(time.monotonic()-started)*1000


def deliver(reader, settings, delivery, health=None):
    settings={**settings,'uiLabel':delivery.get('uiLabel',settings['uiLabel'])}
    route=next((c for c in json.loads(BRIDGE_CONFIG.read_text())['contacts'] if c['peerId']==delivery.get('peerId')),None) if delivery.get('peerId') else None
    if route:settings={**settings,**route}
    with recovery_scope(settings,delivery):
        return _deliver(reader,settings,delivery,health)


def _deliver(reader, settings, delivery, health=None):
    lease=delivery['leaseId'];attempted=False;draft_ready=False;expected_draft=None;owned=OwnedDraft()
    started=time.monotonic();composed=None;clicked=None
    timings={}
    for attempt in range(2):
        try:
            phase=time.perf_counter()
            current=ensure_owner(reader,settings,lease,timings=timings,health=health)
            timings['locateMs']=round((time.perf_counter()-phase)*1000)
            if not draft_ready:
                if not compose_is_empty(reader,current['geometry']):
                    raise RuntimeError('Existing WeChat draft was preserved; inspect before sending')
                phase=time.perf_counter()
                prepared=measured_read(reader,'prepare',{'delivery':delivery},timings)
                record_prepared(delivery,prepared)
                timings['prepareMs']=round((time.perf_counter()-phase)*1000)
                g=current['geometry'];x,y,w,h=(g[k] for k in ('X','Y','WIDTH','HEIGHT'))
                control('click',{'capture':False,'x':x+340,'y':y+h-115,'leaseId':lease})
                if delivery['kind']=='text':
                    requested=delivery.get('mention');mention=prepared.get('mention')
                    if bool(requested)!=bool(mention) or requested and mention.get('username')!=requested['username']:
                        raise RuntimeError('The @ member identity differs from the current address book')
                    names=prepared.get('mentionNames') or ([mention['name']] if mention else [])
                    if RECOVERY.get() is not None:
                        # prepare may refresh a nickname while retaining its account ID.
                        RECOVERY.get()['delivery']['mention']=mention
                        RECOVERY.get()['settings']['members']=prepared.get('mentionMembers') or settings.get('members',[])
                    phase=time.perf_counter()
                    if mention:select_mention(reader,current,mention,lease,names,
                        prepared.get('mentionMembers',settings.get('members')),draft=owned,verify=False,timings=timings)
                    timings['mentionMs']=round((time.perf_counter()-phase)*1000)
                    prefixes=native_prefixes(names) if mention else ['']
                    expected=[prefix+delivery['text'] for prefix in prefixes]
                    # Keep both pre-paste and post-paste text for a failed paste;
                    # cleanup compares the actual editor before deleting it.
                    owned.expect([*prefixes,*expected])
                    phase=time.perf_counter()
                    copied=control('append_composer',{'leaseId':lease,'text':delivery['text']})['text']
                    if mention:copied=copied.removeprefix('\u2005')
                    if copied not in expected:raise RuntimeError('Pasted draft differs from the reviewed reply')
                    expected_draft=copied;owned.expect([copied])
                    timings['pasteVerifyMs']=round((time.perf_counter()-phase)*1000)
                else:
                    phase=time.perf_counter()
                    control('paste_file',{'capture':False,'path':delivery['desktopPath'],'leaseId':lease})
                    timings['pasteVerifyMs']=round((time.perf_counter()-phase)*1000)
                draft_ready=True
            elif delivery['kind']=='text' and read_composer(lease).removeprefix('\u2005')!=expected_draft:
                raise RuntimeError('Draft changed during recovery; retained without overwriting')
            phase=time.perf_counter()
            full=health is not None and time.monotonic()-health['last']>=30
            ready=inspected_view(reader,settings,full=full,timings=timings,health=health)
            if not ready['ownerVisible'] or len(ready['sendButtons'])!=1:
                ready=model_view(settings,'Recipient or Send button could not be confirmed by OCR',ready) or ready
            if not ready['ownerVisible']:raise RuntimeError('Recipient changed before sending')
            if len(ready['sendButtons'])!=1:raise RuntimeError('Send button is missing or ambiguous')
            cx,cy=ready['sendButtons'][0]
            if not measured_read(reader,'green',{'path':'/exchange/desktop.png','point':[cx,cy]},timings)['enabled']:
                raise RuntimeError('WeChat Send button is not enabled')
            timings['preflightMs']=round((time.perf_counter()-phase)*1000)
            timings['preflightFullInspection']=bool(ready.get('fullInspection',full))
            # Crash on either side of the click is treated as uncertain. The
            # original watermark is durable before the UI may send anything.
            record_attempted(delivery)
            composed=time.monotonic();attempted=True
            if RECOVERY.get() is not None:RECOVERY.get()['attempted']=True
            try:
                control('click',{'capture':False,'x':cx,'y':cy,'leaseId':lease})
            except RuntimeError as denied:
                # These errors originate in control's ui-access check, before
                # it executes xdotool. A rejected authorization is not a click.
                if str(denied) in ('Desktop lease expired or was cancelled',
                        'Desktop delivery is not authorized for UI actions',
                        'Desktop is reserved by another conversation operation'):
                    attempted=False
                    if RECOVERY.get() is not None:RECOVERY.get()['attempted']=False
                raise
            clicked=time.monotonic()
            remaining=max(0,delivery['leaseUntil']/1000-time.time()-3) if delivery.get('leaseUntil') else 12
            confirmation=confirm_delivery(reader,settings,delivery,remaining) or {}
            print(json.dumps({'event':'sent','kind':delivery['kind'],'serverAcknowledged':True,
                'composeMs':round((composed-started)*1000),'confirmMs':round((time.monotonic()-clicked)*1000),
                'totalMs':round((time.monotonic()-started)*1000),'recovered':attempt>0,**timings,**confirmation}),flush=True)
            return True
        except Exception as exc:
            fatal=isinstance(exc,DesktopSecurityError)
            if not fatal:
                # Reserve the single bounded recovery before taking a slow
                # screenshot/OCR, rather than trying to renew an expired lease.
                try:
                    extended=bridge_call('extend-delivery',{'leaseId':lease}).get('delivery')
                    if extended:delivery=extended
                except Exception:
                    pass  # The failure receipt keeps an expired task terminal.
            try:
                inspected=None if fatal else review_failure(reader,settings,exc,delivery)
            except DesktopSecurityError as security:
                inspected=None;exc=security;fatal=True
            except Exception:
                inspected=None
            if not fatal and inspected:
                try:
                    if attempted:
                        # Only re-read acknowledgements. Never repeat the send click.
                        confirmation=confirm_delivery(reader,settings,delivery,15) or {}
                        print(json.dumps({'event':'sent','kind':delivery['kind'],'serverAcknowledged':True,'recovered':True,**timings,**confirmation}),flush=True)
                        return True
                    if attempt==0:
                        if not draft_ready and expected_draft is not None and inspected['ownerVisible']:
                            draft_ready=read_composer(lease).removeprefix('\u2005')==expected_draft
                        if draft_ready or owned.clear(inspected,lease):
                            continue
                except Exception as recovery_error:
                    exc=recovery_error
            if not fatal and not attempted and owned.expected and inspected:
                try:
                    if owned.clear(inspected,lease):
                        print(json.dumps({'event':'owned-draft-cleared','delivery':delivery['id']}),flush=True)
                except Exception as cleanup_error:
                    print(json.dumps({'event':'owned-draft-retained','delivery':delivery['id'],
                        'error':str(cleanup_error)[:200]}),flush=True)
            try:
                bridge_call('receipt',{'id':delivery['id'],'leaseId':lease,
                    'status':'uncertain' if attempted else 'rejected','uiLabel':settings['uiLabel'],
                    'error':str(exc)[:300]+'; reviewed reply retained for recovery'})
            finally:
                if fatal:raise exc
            if attempted:
                issue=UncertainDelivery(str(exc));issue.delivery_id=delivery['id'];raise issue
            record_done(delivery)
            print(json.dumps({'event':'delivery-retained','id':delivery['id'],'error':str(exc)[:200]}),flush=True)
            return False


def incoming_args(event,settings):
    route=event.get('route',{})
    args={'peerId':route.get('peerId',settings.get('ownerPeerId')),'uiLabel':route.get('uiLabel',settings.get('uiLabel')),
          'sourceMessageId':event['sourceMessageId'],'text':event['text'],'database':event['database']}
    for key in ('actor','replyTo','contextOnly','self'):
        if key in event:args[key]=event[key]
    if args.get('replyTo',{}).get('media',{}).get('localPath'):
        args['replyTo']={**args['replyTo'],'media':{**args['replyTo']['media'],
            'localPath':str(EXCHANGE/Path(args['replyTo']['media']['localPath']).relative_to('/exchange'))}}
    if event.get('unavailable'):args['unavailableMedia']=event['kind']
    if event.get('media'):
        media=dict(event['media'])
        if media.get('localPath'):media['localPath']=str(EXCHANGE/Path(media['localPath']).relative_to('/exchange'))
        args['media']=media
    if event.get('attachmentPath'):
        host=EXCHANGE/Path(event['attachmentPath']).relative_to('/exchange')
        args['attachment']={'kind':event['kind'],'path':str(host)}
    return args


def accept_events(events,settings):
    if not events:return
    bridge_call('incoming-batch',{'messages':[incoming_args(e,settings) for e in events]})


def ingest(reader, settings, timings=None):
    batch=reader.call('poll')
    if timings is not None:
        rpc=batch.get('_rpcTiming',{})
        for key in ('lockWaitMs','rpcMs'):
            if key in rpc:timings['poll'+key[:1].upper()+key[1:]]=rpc[key]
    register_routes(batch.get('routes',[]))
    accept_events(batch['events'],settings)
    # Commit received metadata before any optional, potentially slow decoding.
    save_json(STATE/'cursor.json',batch['cursor'])
    return len(batch['events'])


def ingest_media(reader, settings):
    requests=bridge_call('media-requests',{}).get('sources',[])
    # Only one decode per pass. The reader queue lets waiting verification and
    # message polling run between media jobs without interleaving stdio.
    if requests:
        source=requests[0]
        try:
            event=reader.call('resolve-media',{'source':source})
            if event:accept_events([event],settings)
        except Exception as exc:
            print(json.dumps({'event':'media-refresh-failed','error':type(exc).__name__}),flush=True)
        finally:bridge_call('media-request-finished',{'source':source})
    else:
        batch=reader.call('poll-media')
        accept_events(batch.get('events',[]),settings)
        if 'cursor' in batch:save_json(STATE/'cursor.json',batch['cursor'])


def receive_loop(reader,settings,stopped,failures,progress=None):
    previous_started=None;previous_media_ms=0
    try:
        while not stopped.is_set():
            started=time.monotonic();timings={}
            gap_ms=round((started-previous_started)*1000) if previous_started is not None else None
            count=ingest(reader,settings,timings)
            if progress:progress.polled()
            poll_ms=round((time.monotonic()-started)*1000)
            # Report slow empty passes too: otherwise the next received batch
            # cannot distinguish late DB visibility from a stalled receiver.
            if count or poll_ms>=2000 or (gap_ms is not None and gap_ms>=2000):
                print(json.dumps({'event':'incoming' if count else 'receive-slow',
                    'count':count,'pollMs':poll_ms,'pollGapMs':gap_ms,
                    'previousMediaMs':previous_media_ms,**timings}),flush=True)
            previous_started=started;previous_media_ms=0
            if not stopped.is_set():
                media_started=time.monotonic();ingest_media(reader,settings)
                previous_media_ms=round((time.monotonic()-media_started)*1000)
            stopped.wait(.5)
    except Exception as exc:failures.put(exc);stopped.set()


def alert(error, settings):
    reason=str(error)[:300];screen=getattr(error,'screenshot',None)
    kind=getattr(error,'kind','failure')
    value={'id':str(time.time_ns()),'reason':reason,'kind':kind,'notificationDeliveryVersion':1,
           'detectedAt':datetime.now().astimezone().isoformat()}
    # Commit the block independently of screenshots, which may be the component
    # that has failed. Technical uncertainty stops sending, not durable intake.
    try:
        action='pause' if kind in ('security','logout') else 'hold-sending'
        args={'reason':reason,'kind':kind}
        if screen:args['screenshotPath']=screen
        if getattr(error,'delivery_id',None):args['deliveryId']=error.delivery_id
        result=bridge_call(action,args)
        value.update(result.get('alert') or result.get('hold') or {})
    except Exception as exc:value['pauseError']=type(exc).__name__
    try:
        if not screen:screen=control('screenshot',{})['screenshot']
    except Exception as exc:value['screenshotError']=type(exc).__name__
    if screen:value.setdefault('screenshotPath',screen)
    save_json(STATE/'alert.json',value)
    if kind in ('security','logout'):
        try:value['notification']=notify_control(value,settings['securityNotifications'])
        except Exception as exc:
            value['notification']={'channel':channel_label(settings.get('securityNotifications') or {}),'status':'failed','error':str(exc)[:200]}
    else:value['notification']={'status':'existing-server-monitor'}
    save_json(STATE/'alert.json',value)
    print('ERROR 微信'+('自动操作' if kind in ('security','logout') else '发送')+'已暂停：'+reason+
          '；'+channel_label(settings.get('securityNotifications') or {})+'：'+value['notification']['status'],file=sys.stderr,flush=True)


def record_prepared(delivery,prepared):
    checkpoint=prepared.get('verification')
    if not isinstance(checkpoint,dict):raise RuntimeError('Durable send verification checkpoint missing; send was not attempted')
    durable_json(STATE/'deliveries'/(delivery['id']+'.json'),
        {'version':1,'id':delivery['id'],'leaseId':delivery['leaseId'],
         'phase':'prepared','verification':checkpoint})


def record_attempted(delivery):
    path=STATE/'deliveries'/(delivery['id']+'.json')
    value=json.loads(path.read_text())
    if value['leaseId']!=delivery['leaseId']:raise RuntimeError('Send checkpoint lease mismatch')
    value.update(phase='attempted',attemptedAt=int(time.time()*1000))
    value['verification']['attemptedAt']=time.time()
    durable_json(path,value)


def record_done(delivery):
    try:(STATE/'deliveries'/(delivery['id']+'.json')).unlink(missing_ok=True)
    except OSError as exc:
        # A successfully committed receipt must not be downgraded merely
        # because its redundant local journal could not be removed.
        print(json.dumps({'event':'journal-cleanup-pending','id':delivery['id'],'error':str(exc)[:200]}),flush=True)


def reconcile_deliveries(reader):
    """Read-only recovery from the exact pre-click watermark, never re-prepare."""
    pending=bridge_call('pending-reconciliation',{}).get('deliveries',[])
    recovered=0;deadline=time.monotonic()+55
    for delivery in pending:
        if time.monotonic()>=deadline:break
        path=STATE/'deliveries'/(delivery['id']+'.json')
        if not path.exists():continue  # Legacy uncertainty lacks a trusted baseline.
        try:
            value=json.loads(path.read_text())
            if value.get('phase')!='attempted' or value.get('leaseId')!=delivery.get('leaseId'):continue
            verified=reader.call('reconcile',{'checkpoint':value['verification']},timeout=30)
            if verified.get('pending'):continue
            bridge_call('reconcile-receipt',{'id':delivery['id'],'leaseId':delivery['leaseId'],
                'status':'sent','uiLabel':delivery['uiLabel'],'database':verified['database']})
            record_done(delivery);recovered+=1
            print(json.dumps({'event':'delivery-reconciled','id':delivery['id'],'serverAcknowledged':True}),flush=True)
        except Exception as exc:
            # A malformed/legacy checkpoint or removed member is isolated to
            # this delivery. Broken reader IPC still goes through supervision.
            if any(term in str(exc) for term in ('Read-only worker stopped','worker timed out',
                    'worker input timed out','Reader response order','Broken pipe')):raise
            print(json.dumps({'event':'reconciliation-retained','id':delivery['id'],
                'error':str(exc)[:300]}),flush=True)
    return recovered


def send_cycle(reader,settings,health):
    """Use idle time for security OCR; keep only expired checks on send's path."""
    if deployment_held():return .2
    status=bridge_call('status',{})
    if status.get('receivePaused',False):return None
    if status.get('sendPaused',status.get('paused')):return .5
    manual_revision=(status.get('manualControl') or {}).get('revision')
    with ui_session(blocking=False) as available:
        if available:
            # The browser can acquire and release control after status was
            # sampled. Re-read its durable state under the shared UI lock,
            # without adding a second bridge RPC to every idle cycle.
            try:manual=json.loads((DATA/'manual-control.json').read_text())
            except FileNotFoundError:manual=None
            if manual is not None:
                if not isinstance(manual,dict) or type(manual.get('active')) is not bool or not isinstance(manual.get('sessionId'),str):
                    raise RuntimeError('Manual takeover state is invalid; inspect before resuming')
                if manual['active']:return .5
                manual_revision=manual['sessionId']+':'+str(manual.get('endedAt') or '')
            if manual_revision and health.get('manualRevision')!=manual_revision:
                health['last']=0.0;timings={}
                inspected_view(reader,settings,full=True,timings=timings,health=health)
                # Only a successful check authorizes the next automatic UI
                # workflow; a failed check must be repeated on the next cycle.
                health['manualRevision']=manual_revision
                print(json.dumps({'event':'security-check','during':'manual-resume',**timings}),flush=True)
            if any(r['status']=='queued' and r['count'] for r in status['outgoing']):
                delivery=bridge_call('next-delivery',{}).get('delivery')
                if delivery and deliver(reader,settings,delivery,health):
                    return 0
            # Start early while no reply is ready: the previous full OCR took
            # about eight seconds. The 30-second preflight expiry remains the
            # backstop during a busy queue or unusually long UI operation.
            if time.monotonic()-health['last']>=20:
                check_started=time.monotonic();timings={}
                try:
                    inspected_view(reader,settings,full=True,timings=timings,health=health)
                    health['failures']=0
                except DesktopSecurityError:raise
                except Exception as exc:
                    inspected=review_failure(reader,settings,exc)
                    if inspected:
                        health.update(last=inspected.get('capturedAt',check_started),failures=0)
                    else:
                        health['failures']+=1
                        if health['failures']>=3:raise
                print(json.dumps({'event':'security-check','during':'idle',**timings}),flush=True)
    return .2


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare',action='store_true',help='read-only identity/layout initialization; never sends')
    parser.add_argument('--check',action='store_true',help='check configuration only; no database/model/UI actions')
    options=parser.parse_args()
    settings=json.loads(SETTINGS.read_text())
    if options.check:
        print(json.dumps({'configured':True,'enabled':settings['enabled'],'usesOperationModel':False,
            'modelRecovery':bool(settings.get('modelRecovery',{}).get('enabled'))}));return
    STATE.mkdir(parents=True,exist_ok=True,mode=0o700)
    with (DATA/'transport.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        if not options.prepare and not settings['enabled']:return
        backoff=RecoveryBackoff(STATE/'recovery.json')
        def requested_stop(_signum,_frame):
            # A deployment/systemd stop is not a crash-loop attempt. A send
            # journal remains intact for receipt-only reconciliation.
            backoff.stopped()
            raise SystemExit(0)
        previous_term=signal.signal(signal.SIGTERM,requested_stop)
        backoff.wait()
        progress=TransportHealth(DATA/'transport-health.json')
        progress.start()
        database=None;vision=None;stopped=threading.Event();failures=queue.Queue();receiver=None
        try:
            status=bridge_call('status',{})
            if status.get('receivePaused',False):
                progress.update(phase='paused',receiveEnabled=False,sendBlocked=True,
                    blockKind=(status.get('alert') or {}).get('kind','manual'))
                return
            database=PrivateReader(settings)
            cursorpath=STATE/'cursor.json'
            expected=json.loads(BRIDGE_CONFIG.read_text()).get('database')
            def initialize(current,prepare=False):
                return initialize_reader(current,settings,cursorpath,expected,prepare)
            print('正在初始化本地只读消息服务；不发送消息',flush=True)
            initialized=initialize(database,options.prepare)
            vision=PrivateReader(settings,'vision');reader=ReaderServices(database,vision)
            if options.prepare:
                current=view(reader,settings)
                if not current['ownerVisible']:raise RuntimeError('Select the verified owner conversation before preparation')
                binding={k:initialized['binding'][k] for k in ('accountDirectory','selfUsername','ownerUsername')}
                bridge=json.loads(BRIDGE_CONFIG.read_text());bridge['database']=binding
                save_json(BRIDGE_CONFIG,bridge)
                save_json(STATE/'readiness.json',{'prepared':True,'binding':binding,
                    'usesOperationModel':False,'liveMessagesSent':0,'at':time.time()})
                print(json.dumps({'prepared':True,'liveMessagesSent':0,'ownerVisible':True}));return
            receiver=threading.Thread(target=receive_loop,args=(database,settings,stopped,failures,progress),daemon=True)
            receiver.start();progress.ready()
            print('独立读库收件与界面发送已就绪',flush=True)
            health={'last':0.0,'failures':0};next_reconcile=0.0;next_send=0.0;send_failures=0
            stable_since=time.monotonic()
            while True:
                progress.cycle()
                status=bridge_call('status',{})
                if status.get('receivePaused',False):
                    progress.update(phase='paused',receiveEnabled=False,sendBlocked=True,
                        blockKind=(status.get('alert') or {}).get('kind','manual'))
                    return
                progress.update(sendBlocked=bool(status.get('sendPaused',status.get('paused'))),
                    blockKind=(status.get('alert') or {}).get('kind'))
                if not failures.empty():
                    failure=failures.get()
                    # Restart the failed reader from its durable cursor. Do not
                    # require a functioning GUI/OCR to restore message intake.
                    progress.update(phase='recovering',receiveEnabled=False,lastError=str(failure)[:300])
                    receiver.join(timeout=3);database.close()
                    progress.begin('reader-initialization',240)
                    database=PrivateReader(settings);initialize(database);reader.database=database
                    stopped.clear();receiver=threading.Thread(target=receive_loop,
                        args=(database,settings,stopped,failures,progress),daemon=True);receiver.start()
                    progress.ready();stable_since=time.monotonic()
                    print(json.dumps({'event':'reader-recovered','cursorPreserved':True}),flush=True)
                now=time.monotonic()
                if now>=next_reconcile:
                    progress.begin('reconciliation',90)
                    reconcile_deliveries(database);next_reconcile=now+30
                if now-stable_since>=120:backoff.healthy()
                if now<next_send:
                    time.sleep(.5);continue
                progress.begin('sending',720)
                try:
                    delay=send_cycle(reader,settings,health)
                    if delay is None:return
                    send_failures=0
                    progress.update(phase='running',lastError=None)
                except DesktopSecurityError:raise
                except UncertainDelivery as exc:
                    alert(exc,settings);delay=.5
                    progress.update(sendBlocked=True,blockKind='failure',lastError=str(exc)[:300])
                except Exception as exc:
                    # A failed screenshot/OCR does not tear down the receiver.
                    # Calls are bounded, and repeated failures back off locally.
                    send_failures+=1;delay=.5
                    cooldown=(5,15,30,60,120,300)[min(send_failures-1,5)]
                    next_send=time.monotonic()+cooldown
                    progress.update(phase='recovering',lastError=str(exc)[:300],recoveryAttempts=send_failures)
                    print(json.dumps({'event':'sender-recovering','attempt':send_failures,
                        'retryInSeconds':cooldown,'error':str(exc)[:300]}),flush=True)
                    vision.close();vision=PrivateReader(settings,'vision');reader.vision=vision
                    health.update(last=0.0,failures=0)
                if delay:time.sleep(delay)
        except DesktopSecurityError as exc:
            if not options.prepare:alert(exc,settings)
            progress.update(phase='paused',receiveEnabled=False,sendBlocked=True,blockKind=exc.kind,lastError=str(exc)[:300])
            # Safety latches remain manual. A clean exit suppresses restart.
        except Exception as exc:
            backoff.failed(str(exc))
            progress.update(phase='recovering',receiveEnabled=False,lastError=str(exc)[:300])
            raise
        finally:
            signal.signal(signal.SIGTERM,previous_term)
            if sys.exc_info()[0] is None:backoff.stopped()
            stopped.set()
            if receiver:receiver.join(timeout=3)
            if database:database.close()
            if vision:vision.close()
            progress.close()


if __name__=='__main__':main()
