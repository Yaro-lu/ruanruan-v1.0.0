"""Local recovery bookkeeping; no WeChat actions or model calls."""
import json
import os
from pathlib import Path
import threading
import time


def durable_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.fchmod(stream.fileno(),0o600)
        json.dump(value,stream,ensure_ascii=False);stream.write('\n');stream.flush();os.fsync(stream.fileno())
    temporary.replace(path)
    directory=os.open(path.parent,os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)


class RecoveryBackoff:
    """Persist crash loops across process restarts; reset only after stability."""
    def __init__(self,path):
        self.path=Path(path)
        self.state=json.loads(self.path.read_text()) if self.path.exists() else {}
        self.failures=max(0,int(self.state.get('failures',0)))
        if self.state.get('running'):self.failures+=1
        self.reset=False

    def wait(self):
        # systemd already waits five seconds after a crash. Further failures
        # cool down without exhausting StartLimit and silently staying dead.
        delay=(0,0,10,25,55,115,295)[min(self.failures,6)]
        if delay:time.sleep(delay)
        durable_json(self.path,{'running':True,'failures':self.failures,'startedAt':int(time.time()*1000)})

    def failed(self,error):
        durable_json(self.path,{'running':False,'failures':self.failures+1,
            'failedAt':int(time.time()*1000),'lastError':str(error)[:300]})

    def stopped(self):
        durable_json(self.path,{'running':False,'failures':self.failures,'stoppedAt':int(time.time()*1000)})

    def healthy(self):
        if self.reset:return
        self.failures=0;self.reset=True
        durable_json(self.path,{'running':True,'failures':0,'healthyAt':int(time.time()*1000)})


class TransportHealth:
    def __init__(self,path,exit_process=os._exit):
        self.path=Path(path);self.exit_process=exit_process
        self.lock=threading.Lock();self.stopped=threading.Event();self.thread=None
        now=int(time.time()*1000)
        self.value={'pid':os.getpid(),'startedAt':now,'updatedAt':now,'lastPollAt':0,
            'lastSendCycleAt':0,'phase':'starting','receiveEnabled':False,
            'sendBlocked':True,'blockKind':None,'lastError':None,'recoveryAttempts':0}
        self.last_poll=time.monotonic();self.deadline=time.monotonic()+240
        self.operation='initialization'

    def start(self):
        self.flush();self.thread=threading.Thread(target=self._watch,daemon=True);self.thread.start()

    def update(self,**values):
        with self.lock:self.value.update(values)

    def ready(self):
        with self.lock:
            self.last_poll=time.monotonic();self.deadline=self.last_poll+30
            self.value.update(phase='running',receiveEnabled=True,lastError=None)

    def polled(self):
        with self.lock:
            self.last_poll=time.monotonic();self.value['lastPollAt']=int(time.time()*1000)

    def cycle(self):
        with self.lock:
            self.deadline=time.monotonic()+30;self.operation='supervision'
            self.value['lastSendCycleAt']=int(time.time()*1000)

    def begin(self,operation,seconds):
        with self.lock:self.operation=operation;self.deadline=time.monotonic()+seconds

    def stalled(self):
        with self.lock:
            if self.value['phase']=='paused':return None
            if self.value['receiveEnabled'] and time.monotonic()-self.last_poll>90:
                return 'Message polling made no progress for 90 seconds'
            if time.monotonic()>self.deadline:return self.operation+' exceeded its progress deadline'
        return None

    def flush(self):
        with self.lock:
            self.value['updatedAt']=int(time.time()*1000);value=dict(self.value)
        durable_json(self.path,value)

    def _watch(self):
        while not self.stopped.wait(5):
            issue=self.stalled()
            if issue:
                self.update(phase='recovering',lastError=issue,receiveEnabled=False)
                self.flush()
                # No operation is replayed. systemd kills the entire process
                # group; a pre-click journal allows receipt-only reconciliation.
                self.exit_process(75);return
            self.flush()

    def close(self):
        self.stopped.set()
        if self.thread:self.thread.join(timeout=2)
        self.flush()
