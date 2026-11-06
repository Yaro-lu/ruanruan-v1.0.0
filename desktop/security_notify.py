"""Durable notices delivered through an explicitly configured external adapter."""
import importlib.util
import fcntl
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path


def detect_notice(items, geometry):
    texts=[''.join(item['text'].split()) for item in items]
    combined=''.join(texts)
    if ('你已退出微信' in combined and '我知道了' in combined) or '需在手机上完成登录' in combined:
        return {'kind':'logout','reason':'微信登录中断：'+next(t for t in texts if '退出微信' in t or '手机上完成登录' in t)}
    # Account dialogs have an actionable control inside the main window.
    # Merely discussing a CAPTCHA/appeal in an ordinary chat is not an alert.
    x,y,w,h=(geometry[k] for k in ('X','Y','WIDTH','HEIGHT'))
    controls={'去验证','开始验证','立即验证','验证','确定','确认','取消','申诉','联系客服','申请解封',
              '下一步','我知道了','知道了','提交','申请','重新登录','登录','获取验证码'}
    def in_dialog(item):
        points=item.get('box',[])
        if len(points)!=4:return False
        cx=sum(p[0] for p in points)/4;cy=sum(p[1] for p in points)/4
        return x+w*.2<=cx<=x+w*.8 and y+h*.15<=cy<=y+h*.85
    if not any(t in controls and item.get('score',1)>=.7 and in_dialog(item) for t,item in zip(texts,items)):
        return None
    issue=re.compile(r'为了你的[帐账]号安全|[帐账]号.{0,12}(违规|限制|风险|异常|封禁|封停)|登录环境.{0,8}异常|'
                     r'安全(核验|验证|校验)|身份(核验|验证)|验证码|客服申请|申诉|申请解封|辅助验证')
    evidence=[item['text'] for item,t in zip(items,texts) if in_dialog(item) and issue.search(t)]
    if evidence:return {'kind':'security','reason':'微信账号安全提示：'+' / '.join(evidence)[:260]}
    return None


class SenderUnavailable(RuntimeError):
    pass


def control_sender(config):
    """Load the selected file's create_sender(config); no implicit sender."""
    if config.get('enabled') is False:
        raise SenderUnavailable('外部通知发送已停用')
    adapter=config.get('senderAdapterPath')
    if not isinstance(adapter,str) or not adapter.strip():
        raise SenderUnavailable('外部通知发送适配器未配置')
    path=Path(adapter).expanduser().resolve()
    spec=importlib.util.spec_from_file_location('wechat_notice_adapter_'+hashlib.sha256(str(path).encode()).hexdigest()[:16],path)
    if spec is None or spec.loader is None:
        raise SenderUnavailable('外部通知发送适配器不可加载')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    factory=getattr(module,'create_sender',None)
    if not callable(factory):
        raise SenderUnavailable('外部通知发送适配器缺少 create_sender 工厂')
    return factory(config)


def channel_label(config):
    return config.get('channelLabel') or '外部通知通道'


def _outbox(config):
    root=Path(config.get('outboxDirectory') or (Path(config['controlDirectory'])/'control-notification-outbox'))
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    return root


def _save(path,value):
    temporary=path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary,0o600)
        json.dump(value,stream,ensure_ascii=False)
        stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)
    descriptor=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def _result(record,path,config):
    return {'channel':channel_label(config),'status':record['status'],'outboxPath':str(path),
            'attempts':record.get('attempts',0),'retryAt':record.get('retryAt'),
            **({'error':record['error']} if record.get('error') else {})}


def _deliver(record,path,config,now):
    if record['accountId']!=config['accountId']:
        record.update(status='blocked',error='通知账号绑定已变化，保留原通知等待核对')
        _save(path,record);return _result(record,path,config)
    if record['status'] in ('accepted','uncertain','blocked'):
        return _result(record,path,config)
    if record['status']=='sending':
        record.update(status='uncertain',error='进程在发送确认前中断，未自动重发')
        _save(path,record);return _result(record,path,config)
    try:
        sender=control_sender(config)
        revision=sender.revision()
    except Exception as error:
        if now>=record.get('retryAt',0):
            record['attempts']=record.get('attempts',0)+1
            record.update(status='unavailable' if isinstance(error,SenderUnavailable) else 'retry',
                          error=str(error) if isinstance(error,SenderUnavailable) else '通知适配器或凭据暂不可用：'+type(error).__name__,
                          retryAt=now+min(300,10*2**min(record['attempts'],5)))
            _save(path,record)
        return _result(record,path,config)
    changed=revision!=record.get('revision')
    if record['status']=='waiting_context' and not changed:return _result(record,path,config)
    if not changed and now<record.get('retryAt',0):return _result(record,path,config)
    record.update(status='sending',revision=revision,attempts=record.get('attempts',0)+1,
                  attemptedAt=now,error='')
    _save(path,record)
    try:
        receipt=sender.send(record['text'],record['clientId'])
        if receipt.get('accepted') is not True:
            record.update(status='uncertain',error='通知未取得明确接口确认，未自动重发')
        else:record.update(status='accepted',acceptedAt=now,retryAt=None)
    except Exception as error:
        # A stable client ID is not evidence of server-side idempotency. Only
        # explicit rejections or failures before connecting may be retried.
        uncertain=getattr(error,'uncertain',None)
        if uncertain is None:uncertain=not hasattr(error,'wait_for_context') or '未确认发送' in str(error)
        state='uncertain' if uncertain else 'waiting_context' if getattr(error,'wait_for_context',False) else 'retry'
        record.update(status=state,error=str(error)[:300],
                      retryAt=None if uncertain else now+min(300,10*2**min(record['attempts'],5)))
    _save(path,record)
    return _result(record,path,config)


def _queue(text,client_id,config,attempt=True):
    root=_outbox(config)
    path=root/(hashlib.sha256(client_id.encode()).hexdigest()+'.json')
    with path.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if path.exists():record=json.loads(path.read_text())
        else:
            record={'version':1,'clientId':client_id,'accountId':config['accountId'],'text':text,
                    'createdAt':time.time(),'status':'pending','attempts':0,'retryAt':0}
            _save(path,record)
        return _deliver(record,path,config,time.time()) if attempt else _result(record,path,config)


def retry_notifications(config,limit=3):
    """Independent timer drains only durable, provably retryable deliveries."""
    root=_outbox(config);processed=0;summary={}
    for path in sorted(root.glob('*.json')):
        if path.name=='summary.json':continue
        with path.with_suffix('.lock').open('a') as lock:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:continue
            try:record=json.loads(path.read_text())
            except (ValueError,OSError):
                summary['damaged']=summary.get('damaged',0)+1;continue
            if record.get('status') not in ('accepted','uncertain','blocked') and processed<limit:
                before=(record.get('status'),record.get('attempts'))
                _deliver(record,path,config,time.time())
                if before!=(record.get('status'),record.get('attempts')):processed+=1
            state=record.get('status','damaged');summary[state]=summary.get(state,0)+1
    _save(root/'summary.json',{'updatedAt':int(time.time()*1000),'counts':summary})
    return summary


def notify_control(value, config,attempt=True):
    text=('【阮阮微信账号提醒】\n'+value['reason']+
          '\n已停止相关微信自动操作，保留待发送内容和现场；未点击验证、重登或申诉。'+
          '\n时间：'+value['detectedAt']+
          ('\n截图：'+value['screenshotPath'] if value.get('screenshotPath') else '\n现场截图暂不可取得。'))
    return _queue(text,'wechat-account-alert-'+value['id'],config,attempt)


def notify_runtime(value, config,attempt=True):
    text=('【阮阮对话处理提醒】\n'+value['reason']+
          '\n相关消息与任务记录已保留，人物微信没有发送后台失败话术。'+
          ('\n任务：'+value['jobId'] if value.get('jobId') else '')+'\n时间：'+value['detectedAt'])
    return _queue(text,'wechat-runtime-alert-'+value['id'],config,attempt)


def recover_retained(settings_path,config):
    """Recover the gap between persisting a failure and starting its notifier."""
    root=Path(settings_path).resolve().parent
    sources=[(root/'alert.json',notify_control)]
    try:
        runtime_config=json.loads((root/'app/runtime-notifications.json').read_text())
        runtime_enabled=runtime_config.get('enabled') is True and Path(runtime_config['settingsPath']).resolve()==Path(settings_path).resolve()
    except (OSError,ValueError,KeyError,TypeError):runtime_enabled=False
    if runtime_enabled:
        sources.extend((path,notify_runtime) for path in sorted((root/'app/runtime-notices').glob('*.json')))
    for path,notify in sources:
        try:
            value=json.loads(path.read_text())
            if value.get('notificationDeliveryVersion')!=1:continue
            if notify is notify_control and value.get('kind') not in ('security','logout'):continue
            previous=value.get('notification')
            if previous=='disabled' or isinstance(previous,dict) and previous.get('status')=='accepted':continue
            notify(value,config,attempt=False)
            # Do not rewrite a source being updated by the producer. The outbox
            # is authoritative and is already persisted before network calls.
        except (OSError,ValueError,KeyError,TypeError):continue


if __name__=='__main__':
    if len(sys.argv)!=3 or sys.argv[1] not in ('runtime','retry'):raise SystemExit('Use runtime|retry SETTINGS_PATH')
    settings=json.loads(Path(sys.argv[2]).read_text())
    config=settings['securityNotifications']
    if sys.argv[1]=='retry':
        recover_retained(sys.argv[2],config)
        result=retry_notifications(config)
    else:result=notify_runtime(json.load(sys.stdin),config)
    print(json.dumps(result,ensure_ascii=False))
