#!/usr/bin/env python3
"""Private state snapshots and isolated restore drills. Never restores in place.

Each SQLite file uses its backup API, including committed WAL pages. The manifest
records the capture window; this is not a transaction across independent DBs.
Credentials in structured fields are omitted. Chat text is private data, not a
credential store, and is preserved as part of the requested conversation backup.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import time
import uuid

FORMAT='ruanruan-state-backup-v1'
STORE_MARKER='.ruanruan-backup-store.json'
DEFAULT_DESTINATION=Path('/mnt/D-2TB/.codex/阮阮素材/私有备份/阮阮运行状态')
DEFAULT_EXTENSION=Path(__file__).resolve().parents[1]/'node_modules/sqlite-vec-linux-x64/vec0.so'
PERSONA_ROOT=Path(__file__).resolve().parents[1]/'personas/ruanruan'
SECRET_KEYS={'apikey','apitoken','bottoken','contexttoken','jobcontexttoken','accesstoken',
             'refreshtoken','idtoken','token','password','passwd','secret','clientsecret',
             'secretkey','privatekey','authorization','cookie','credentials','aeskey'}
APP_PATHS=['message-queue.json','sessions','identities.sqlite3','people','memory','memory-facts.sqlite3',
           'person-memory-resets.json','conversations','jobs','manual-deliveries','media-fingerprints',
           'media-state','generated-images','retired-threads','thread-archives.jsonl',
           'runtime-notifications.json','runtime-notices','voice-transcription','logs/visual-usage','providers','character-life','GENERATE.md','REVIEW.md']
CONTROL_PATHS=['accounts','sessions','conversations','memory','memory-facts.sqlite3','work-memory',
               'message-queue.json','jobs','approvals','reminders','character-life','media-state',
               'image-deliveries','generated-images','providers','get_updates_buf',
               'control-notification-outbox','GENERATE.md','REVIEW.md']


def secret_key(key):
    return re.sub('[^a-z0-9]','',str(key).lower()) in SECRET_KEYS


def scrub(value):
    if isinstance(value,dict):return {k:scrub(v) for k,v in value.items() if not secret_key(k)}
    if isinstance(value,list):return [scrub(v) for v in value]
    return value


def private_dir(path):
    if path.is_symlink():raise ValueError('Private destination must not be a symlink')
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    path.chmod(0o700)


def write_json(path,value):
    path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
    path.chmod(0o600)


def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):value.update(block)
    return value.hexdigest()


def sync_directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(descriptor)
    finally:os.close(descriptor)


def quote(name):return '"'+name.replace('"','""')+'"'


def load_extensions(connection,extension):
    schemas='\n'.join(row[0] or '' for row in connection.execute("SELECT sql FROM sqlite_master WHERE type='table'"))
    if re.search(r'\busing\s+vec0\b',schemas,re.I):
        if not extension or not Path(extension).is_file():raise RuntimeError('sqlite-vec extension required to validate this backup')
        connection.enable_load_extension(True)
        try:connection.load_extension(str(Path(extension).resolve()))
        finally:connection.enable_load_extension(False)


def redact_database(connection):
    """Strip structured credentials only; preserve history, identities and receipts."""
    changed=0
    tables=[(row[1],row[2]) for row in connection.execute('PRAGMA table_list')
            if row[2]=='table' and not row[1].startswith('sqlite_')]
    for name,_ in tables:
        info=list(connection.execute('PRAGMA table_info('+quote(name)+')'))
        columns=[row[1] for row in info]
        primary=[row[1] for row in sorted(info,key=lambda row:row[5]) if row[5]]
        schema=connection.execute('SELECT sql FROM sqlite_master WHERE name=?',(name,)).fetchone()[0] or ''
        without_rowid='WITHOUT ROWID' in schema.upper()
        keys=primary if without_rowid else ['rowid']
        selection=','.join(quote(k) for k in keys+columns)
        cursor=connection.execute('SELECT '+selection+' FROM '+quote(name))
        for row in cursor:
            row_keys=row[:len(keys)];values=dict(zip(columns,row[len(keys):]));updates={}
            for key,value in values.items():
                if secret_key(key) and value not in (None,''):
                    updates[key]='' if isinstance(value,str) else None
                elif isinstance(value,str) and value.lstrip().startswith(('{','[')):
                    try:parsed=json.loads(value)
                    except ValueError:continue
                    cleaned=scrub(parsed)
                    if cleaned!=parsed:updates[key]=json.dumps(cleaned,ensure_ascii=False)
            if secret_key(values.get('key','')) and 'value' in values:updates['value']=''
            if updates:
                query='UPDATE '+quote(name)+' SET '+','.join(quote(k)+'=?' for k in updates)
                query+=' WHERE '+' AND '.join(quote(k)+' IS ?' for k in keys)
                connection.execute(query,tuple(updates.values())+tuple(row_keys));changed+=1
    return changed


def sqlite_snapshot(source,destination,extension=None,timeout=30):
    started=time.monotonic()
    reader=sqlite3.connect(source.resolve().as_uri()+'?mode=ro',uri=True,timeout=5)
    writer=sqlite3.connect(destination)
    try:
        def progress(*_):
            if time.monotonic()-started>timeout:raise TimeoutError('SQLite snapshot exceeded deadline')
        reader.backup(writer,pages=128,progress=progress,sleep=.05)
        writer.execute('PRAGMA journal_mode=DELETE')
        load_extensions(writer,extension)
        writer.execute('PRAGMA secure_delete=ON')
        redactions=redact_database(writer)
        writer.commit()
        if redactions:writer.execute('VACUUM')
        checks=[row[0] for row in writer.execute('PRAGMA integrity_check')]
        if checks!=['ok']:raise RuntimeError('SQLite integrity validation failed')
        return {'sqliteIntegrity':'ok','redactedRows':redactions}
    finally:
        writer.close();reader.close()
        if destination.exists():destination.chmod(0o600)


def inventory(desktop,control=None):
    # Capture intake cursors before the channel DB. A restored older cursor can
    # safely re-ingest by stable message ID; a newer cursor could skip messages.
    specs=[('desktop',desktop,'database-state'),('desktop',desktop,'bridge.json'),
           ('desktop',desktop,'database.json'),
           ('desktop',desktop,'moments')]
    for path in APP_PATHS:
        # Existing dual-entry installations may explicitly include the shared
        # life target. Capture it once, under that selected root.
        if path=='character-life' and control and (desktop/'app'/path).is_symlink() \
                and (desktop/'app'/path).resolve()==(control/path).resolve():continue
        specs.append(('desktop',desktop,'app/'+path))
    if control:specs.extend(('control',control,path) for path in CONTROL_PATHS)
    specs.append(('desktop',desktop,'bridge'))
    allowed=(desktop.resolve(),*((control.resolve(),) if control else ()))
    persona_sources={desktop/'app'/name for name in ('GENERATE.md','REVIEW.md')}
    if control:persona_sources.update(control/name for name in ('GENERATE.md','REVIEW.md'))
    for label,root,relative in specs:
        base=root/relative
        if not base.exists():continue
        if base.is_symlink() and base.is_dir() and not any(base.resolve().is_relative_to(parent) for parent in allowed):
            raise ValueError('State link resolves outside the selected runtime roots; select its root explicitly')
        files=sorted(base.rglob('*')) if base.is_dir() else [base]
        for source in files:
            if not source.is_file():continue
            real=source.resolve()
            persona=source in persona_sources and real==PERSONA_ROOT/source.name
            if not persona and not any(real.is_relative_to(parent) for parent in allowed):
                raise ValueError('State link resolves outside the selected runtime roots')
            name=source.name
            if name.endswith(('-wal','-shm','.lock','.sock','.tmp','.env')):continue
            if name in ('events.jsonl','summary.json'):continue
            # Media is backed up only when it is an actual incoming chat asset.
            is_media=source.is_relative_to(desktop/'bridge/incoming')
            if not is_media and source.suffix.lower() not in ('.sqlite3','.db','.json','.jsonl','.md') and name!='get_updates_buf':continue
            yield source,Path(label)/source.relative_to(root),is_media


def make_store(destination):
    private_dir(destination)
    marker=destination/STORE_MARKER
    if marker.exists():
        value=json.loads(marker.read_text())
        if value.get('format')!=FORMAT or not value.get('storeId'):raise ValueError('Unrecognized backup destination marker')
    else:
        value={'format':FORMAT,'storeId':str(uuid.uuid4()),'createdAt':time.time()}
        write_json(marker,value)
    return value['storeId']


def create_backup(desktop,control=None,destination=DEFAULT_DESTINATION,extension=None):
    desktop=Path(desktop).resolve();control=Path(control).resolve() if control is not None else None
    destination=Path(destination).resolve()
    roots={'desktop':desktop,**({'control':control} if control else {})}
    if any(not root.is_dir() for root in roots.values()):raise ValueError('Selected runtime roots must exist')
    if any(destination.is_relative_to(root) for root in roots.values()):
        raise ValueError('Backup destination must be outside runtime roots')
    store_id=make_store(destination);started=time.time()
    name='ruanruan-state-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex[:8]
    staging=destination/('.incomplete-'+name);private_dir(staging)
    files=[]
    try:
        for source,relative,is_media in inventory(desktop,control):
            target=staging/relative;private_dir(target.parent)
            meta={'path':relative.as_posix()}
            if source.suffix in ('.sqlite3','.db'):
                meta.update(sqlite_snapshot(source,target,extension));meta['kind']='sqlite'
            elif source.suffix in ('.json','.jsonl'):
                content=source.read_text()
                if source.suffix=='.json':write_json(target,scrub(json.loads(content)))
                else:
                    target.write_text(''.join(json.dumps(scrub(json.loads(line)),ensure_ascii=False)+'\n'
                                              for line in content.splitlines() if line.strip()))
                meta['kind']='structured'
            else:
                shutil.copyfile(source,target);meta['kind']='media' if is_media else 'text'
            target.chmod(0o600)
            with target.open('rb') as completed:os.fsync(completed.fileno())
            meta.update(bytes=target.stat().st_size,sha256=digest(target));files.append(meta)
        manifest={'format':FORMAT,'storeId':store_id,'captureStartedAt':started,'captureFinishedAt':time.time(),
                  'sourceRoots':{name:str(root) for name,root in roots.items()},'files':files,
                  'consistency':'SQLite backup API per database; independent databases have a capture window',
                  'secrets':'Structured credential fields and env/login data omitted; private chat text preserved',
                  'restoreMode':'isolated directory only; manual identity/credentials/send reconciliation before activation'}
        write_json(staging/'manifest.json',manifest)
        verify_backup(staging,extension)
        with (staging/'manifest.json').open('rb') as completed:os.fsync(completed.fileno())
        for folder,_,_ in os.walk(staging,topdown=False):sync_directory(folder)
        final=destination/name;staging.rename(final)
        sync_directory(destination)
        return final
    except BaseException:
        # Only this invocation's unpublished staging directory is removed.
        shutil.rmtree(staging)
        raise


def checked_path(root,relative):
    part=Path(relative)
    if part.is_absolute() or '..' in part.parts:raise ValueError('Invalid manifest path')
    target=root/part
    if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):raise ValueError('Manifest path escapes snapshot')
    return target


def verify_backup(snapshot,extension=None):
    snapshot=Path(snapshot);manifest=json.loads((snapshot/'manifest.json').read_text())
    if manifest.get('format')!=FORMAT:raise ValueError('Unrecognized backup format')
    seen=set()
    for record in manifest['files']:
        if record['path'] in seen:raise ValueError('Duplicate snapshot path')
        seen.add(record['path']);path=checked_path(snapshot,record['path'])
        if not path.is_file() or digest(path)!=record['sha256']:raise ValueError('Backup checksum mismatch: '+record['path'])
        if stat.S_IMODE(path.stat().st_mode)&0o077:raise ValueError('Backup file is not private')
        if record['kind']=='sqlite':
            connection=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)
            try:
                load_extensions(connection,extension)
                if list(connection.execute('PRAGMA integrity_check'))!=[('ok',)]:raise ValueError('SQLite integrity failure')
            finally:connection.close()
    return manifest


def restore_isolated(snapshot,target,extension=None):
    snapshot=Path(snapshot).resolve();target=Path(target).absolute()
    manifest=verify_backup(snapshot,extension)
    if target.exists() or target.is_symlink():raise ValueError('Restore destination must be a new directory')
    protected=[Path(p).resolve() for p in manifest['sourceRoots'].values()]
    protected.extend([Path.home()/'.wechat-codex-desktop',Path.home()/'.wechat-codex-bridge'])
    if any(target.resolve()==p or target.resolve().is_relative_to(p) for p in protected):
        raise ValueError('In-place production restore is not supported')
    private_dir(target)
    try:
        for record in manifest['files']:
            source=checked_path(snapshot,record['path']);dest=checked_path(target,record['path'])
            private_dir(dest.parent);shutil.copyfile(source,dest);dest.chmod(0o600)
        write_json(target/'manifest.json',manifest)
        verify_backup(target,extension)
        life_link=[]
        if any(row['path'].startswith('control/character-life/') for row in manifest['files']) \
                and not any(row['path'].startswith('desktop/app/character-life/') for row in manifest['files']):
            life_link=['Recreate the app/character-life link to control/character-life']
        write_json(target/'RESTORE-NOT-ACTIVATED.json',{'restoredAt':time.time(),'source':str(snapshot),
            'activated':False,'required':[*life_link,
            'Restore credentials separately and verify owner/account bindings',
            'Reconcile queued/uncertain sends and cursors before starting services',
            'Native Codex rollout history and WeChat login data are not included']})
        return target
    except BaseException:
        shutil.rmtree(target);raise


def prune_owned(destination,days=7,now=None,apply=False):
    if days<1:raise ValueError('Retention must be at least one day')
    destination=Path(destination);marker=json.loads((destination/STORE_MARKER).read_text())
    if marker.get('format')!=FORMAT:raise ValueError('Unrecognized backup store')
    cutoff=(time.time() if now is None else now)-days*86400;eligible=[]
    for path in sorted(destination.glob('ruanruan-state-*')):
        if path.is_symlink() or not path.is_dir() or not re.fullmatch(r'ruanruan-state-\d{8}T\d{6}Z-[0-9a-f]{8}',path.name):continue
        try:manifest=json.loads((path/'manifest.json').read_text())
        except (ValueError,OSError):continue
        if manifest.get('format')==FORMAT and manifest.get('storeId')==marker['storeId'] and manifest.get('captureFinishedAt',float('inf'))<cutoff:
            eligible.append(str(path))
            if apply:shutil.rmtree(path)
    return eligible


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sqlite-extension',default=str(DEFAULT_EXTENSION))
    commands=parser.add_subparsers(dest='command',required=True)
    backup=commands.add_parser('backup');backup.add_argument('--desktop',type=Path,default=Path.home()/'.wechat-codex-desktop')
    backup.add_argument('--control',type=Path,help='Explicit optional second runtime root; omitted for a standalone character')
    backup.add_argument('--destination',type=Path,default=DEFAULT_DESTINATION)
    backup.add_argument('--retain-days',type=int,default=7);backup.add_argument('--prune-owned',action='store_true')
    verify=commands.add_parser('verify');verify.add_argument('snapshot',type=Path)
    restore=commands.add_parser('restore-drill');restore.add_argument('snapshot',type=Path);restore.add_argument('--target',type=Path,required=True)
    args=parser.parse_args();os.umask(0o077)
    if args.command=='backup':
        path=create_backup(args.desktop,args.control,args.destination,args.sqlite_extension)
        removed=prune_owned(args.destination,args.retain_days,apply=args.prune_owned)
        print(json.dumps({'snapshot':str(path),'retentionCandidates':removed,'retentionApplied':args.prune_owned},ensure_ascii=False))
    elif args.command=='verify':
        manifest=verify_backup(args.snapshot,args.sqlite_extension);print(json.dumps({'verified':True,'files':len(manifest['files'])}))
    else:print(json.dumps({'restoredTo':str(restore_isolated(args.snapshot,args.target,args.sqlite_extension)),'activated':False}))


if __name__=='__main__':main()
