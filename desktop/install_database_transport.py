#!/usr/bin/env python3
"""Build the pinned local reader; leaves automatic sending disabled."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

from wechat_gui import DATA, EXCHANGE, PROJECT, BASE, run
from database_operator import save_json

REVISION='638e98e51fd373f11d62965a41bccb603d63954c'
IMAGE='local/ruanruan-wechat-reader:'+REVISION[:12]


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--account-wechat-id',required=True)
    parser.add_argument('--owner-wechat-id',required=True)
    options=parser.parse_args()
    bridge=json.loads((DATA/'bridge.json').read_text())
    owner=next((c for c in bridge['contacts'] if c['peerId']==bridge['ownerPeerId']),None)
    if not owner:raise RuntimeError('Verify and bind the owner first')
    source=DATA/'vendor'/'wechat-ai'
    if not source.exists():
        source.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        subprocess.run(['git','clone','--no-checkout','https://github.com/ChisBread/wechat-ai.git',str(source)],check=True)
        subprocess.run(['git','-C',str(source),'checkout','--detach',REVISION],check=True)
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    if revision!=REVISION:raise RuntimeError('Upstream revision differs from the reviewed pinned source')
    code='''from pathlib import Path
import json
accounts=set()
for p in Path('/proc').glob('[0-9]*'):
 try:
  if (p/'comm').read_text().strip()!='wechat':continue
  for f in (p/'fd').iterdir():
   try:
    path=str(f.readlink())
    if '/db_storage/' in path:accounts.add(path.split('/db_storage/')[0].split('/')[-1])
   except OSError:pass
 except OSError:pass
print(json.dumps(sorted(accounts)))
'''
    accounts=json.loads(run(BASE+['/lsiopy/bin/python3','-c',code]))
    if len(accounts)!=1:raise RuntimeError('Cannot identify one active logged-in WeChat account')
    context=DATA/'build'/'database-reader';context.mkdir(parents=True,exist_ok=True,mode=0o700)
    shutil.copytree(source/'src',context/'upstream'/'src',dirs_exist_ok=True)
    shutil.copy2(source/'LICENSE',context/'upstream'/'LICENSE')
    shutil.copy2(PROJECT/'desktop'/'db-worker'/'rpc.py',context/'rpc.py')
    shutil.copy2(PROJECT/'desktop'/'db-worker'/'live_database.py',context/'live_database.py')
    subprocess.run(['docker','build','--progress','plain','-t',IMAGE,
                    '-f',str(PROJECT/'desktop'/'db-worker'/'Dockerfile'),str(context)],check=True)
    (EXCHANGE/'incoming').mkdir(parents=True,exist_ok=True)
    save_json(DATA/'database.json',{'version':1,'enabled':False,'readerImage':IMAGE,'upstreamRevision':REVISION,
        'accountDirectory':accounts[0],'accountWechatId':options.account_wechat_id,
        'ownerWechatId':options.owner_wechat_id,'ownerPeerId':bridge['ownerPeerId'],
        'uiLabel':owner['uiLabel']})
    print(json.dumps({'installed':True,'enabled':False,'upstreamRevision':REVISION,'loginAttempted':False,'messagesSent':0}))


if __name__=='__main__':main()
