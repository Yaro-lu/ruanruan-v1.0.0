#!/usr/bin/env python3
"""Authenticated SSH or local desktop connection takeover; no GUI actions."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import sys
import time
import uuid
from transport_recovery import durable_json
from wechat_gui import DATA,bridge_call


def takeover(directory=DATA,input_stream=sys.stdin,output=sys.stdout,announce_release=True):
    directory=Path(directory);path=directory/'manual-control.json'
    with (directory/'ui.lock').open('a') as lock:
        deadline=time.monotonic()+20
        while True:
            try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()>deadline:raise RuntimeError('阮阮正在操作桌面，请稍后重试接管。')
                time.sleep(.2)
        status=bridge_call('status',{})
        if status.get('uiBusy'):raise RuntimeError('仍有尚未结束的发送操作，请核对后再接管。')
        value={'active':True,'sessionId':str(uuid.uuid4()),'pid':os.getpid(),'startedAt':int(time.time()*1000)}
        durable_json(path,value)
        try:
            print('RR_CONTROL_READY',file=output,flush=True)
            # SSH/socket disconnection closes stdin. Selkies keeps one socket
            # while any interactive browser is connected; the final close
            # returns control automatically. A hard kill leaves a visible hold.
            for line in input_stream:
                if line.strip().lower() in ('q','quit','exit'):break
        finally:
            durable_json(path,{**value,'active':False,'endedAt':int(time.time()*1000)})
            if announce_release:
                try:print('RR_CONTROL_RELEASED',file=output,flush=True)
                except (BrokenPipeError,ConnectionResetError):pass


def release(directory=DATA):
    directory=Path(directory)
    with (directory/'ui.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        path=directory/'manual-control.json'
        value=json.loads(path.read_text()) if path.exists() else {'sessionId':str(uuid.uuid4())}
        durable_json(path,{**value,'active':False,'endedAt':int(time.time()*1000)})
    print('RR_CONTROL_RELEASED',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['session','release'])
    parser.add_argument('--quiet-release',action='store_true')
    args=parser.parse_args()
    def stop(*_):raise SystemExit(0)
    for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT):signal.signal(sig,stop)
    try:
        if args.action=='session':takeover(announce_release=not args.quiet_release)
        else:release()
    except Exception as error:
        print(str(error),file=sys.stderr,flush=True);raise SystemExit(1)
