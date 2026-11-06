#!/usr/bin/env python3
"""Export recorded usage facts once per source event; no inferred dollar prices."""
import argparse
import csv
from datetime import datetime,timedelta
import json
import math
import os
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

FIELDS=('inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens')
TZ=ZoneInfo('Asia/Shanghai')


def default_roots():
    return [Path(os.environ.get('WCB_DATA_DIR', Path.home()/'.wechat-codex-desktop/app')).expanduser().resolve()]


def number(value):return value if type(value) in (int,float) and math.isfinite(value) and value>=0 else None


def normalized(value):
    value=value if isinstance(value,dict) else {}
    def first(*values):return next((number(v) for v in values if number(v) is not None),None)
    return {'inputTokens':first(value.get('inputTokens'),value.get('input_tokens'),value.get('prompt_tokens')),
      'cachedInputTokens':first(value.get('cachedInputTokens'),(value.get('input_tokens_details') or {}).get('cached_tokens'),
                                 (value.get('prompt_tokens_details') or {}).get('cached_tokens')),
      'cacheWriteInputTokens':first(value.get('cacheWriteInputTokens'),value.get('cache_creation_input_tokens')),
      'outputTokens':first(value.get('outputTokens'),value.get('output_tokens'),value.get('completion_tokens')),
      'reasoningOutputTokens':first(value.get('reasoningOutputTokens'),(value.get('output_tokens_details') or {}).get('reasoning_tokens'))}


def read_json(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return None


def readonly(path):
    db=sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=5);db.row_factory=sqlite3.Row
    return db


def export_day(day,roots):
    start=datetime.strptime(day,'%Y-%m-%d').replace(tzinfo=TZ).timestamp()*1000;end=start+86400000
    rows=[];seen=set();warnings=[];life_jobs=set();databases=set()
    def add(key,at,stage,task,provider,model,value,status,source,raw=None,scope=None):
        if key in seen or not isinstance(at,(int,float)) or not start<=at<end:return
        seen.add(key);counts=normalized(value)
        unknown=[key for key in FIELDS if counts[key] is None]
        rows.append({'id':key,'at':datetime.fromtimestamp(at/1000,TZ).isoformat(),'timestamp':at,
          'stage':stage,'taskId':task,'provider':provider or 'unknown','model':model or 'unknown',
          'status':status,'source':str(source),'scope':scope or 'legacy_last_request_or_unknown',**counts,
          'unknownFields':unknown,'rawUsage':raw})
    # Job status is authoritative for chat, review, memory and life. Logs and
    # life.attempts may mirror it and are never added a second time.
    for root in roots:
        root=Path(root)
        for folder in sorted((root/'jobs').glob('*')):
            job=read_json(folder/'job.json');status=read_json(folder/'status.json')
            if not isinstance(job,dict) or not isinstance(status,dict):continue
            result=status.get('result') or {};options=job.get('options') or {};job_id=job.get('id',folder.name)
            if status.get('state')=='pending' and not result:continue
            if (job.get('life') or {}).get('id'):life_jobs.add(job['life']['id'])
            kind=job.get('kind');stage={'life':'life','consolidate':'memory','compact':'compaction'}.get(kind,
                    'control' if options.get('profile')=='work' else 'chat')
            if kind=='update':continue
            provider=result.get('llmProvider') or options.get('llmProvider') or result.get('generationProvider') or 'codex'
            detail=result.get('usageDetails') or {};at=status.get('updatedAt',job.get('createdAt'))
            add(str(root.resolve())+':job:'+job_id,at,stage,job_id,provider,result.get('providerModel') or options.get('model'),
                result,status.get('state'),folder/'status.json',detail.get('raw'),detail.get('scope'))
            review=result.get('characterReview') or {}
            if review.get('usageCalls'):
                for i,call in enumerate(review['usageCalls']):
                    details=call.get('usageDetails') or {}
                    add(str(root.resolve())+':review:'+job_id+':'+str(i),call.get('at',at),call.get('stage','review'),job_id,
                        call.get('provider'),call.get('model'),call,'failed' if call.get('failed') else 'reported',
                        folder/'status.json',details.get('raw'),details.get('scope'))
            elif review.get('checks',0)>0:
                target=options.get('reviewTarget') or options
                add(str(root.resolve())+':review:'+job_id,at,'review_combined',job_id,target.get('llmProvider') or 'codex',
                    review.get('model'),review,review.get('status'),folder/'status.json')
        for path in sorted((root/'logs/visual-usage').glob('*.json')):
            row=read_json(path)
            if not isinstance(row,dict):continue
            detail=row.get('usageDetails') or {}
            add('visual:'+str(row.get('id',path)),row.get('at'),'visual_recovery',row.get('deliveryId') or row.get('id'),
                row.get('provider'),row.get('model'),row,row.get('status'),path,detail.get('raw'),detail.get('scope'))
        asr=root/'voice-transcription/cache.sqlite3'
        if asr.exists() and asr.resolve() not in databases:
            databases.add(asr.resolve());db=readonly(asr)
            try:
                for record in db.execute('SELECT * FROM transcriptions WHERE started_at>=? AND started_at<?',(start,end)):
                    row=dict(record);result=json.loads(row['result']) if row.get('result') else {};usage=result.get('usage')
                    add('asr:'+row['cache_key'],row['started_at'],'asr',row['source_id'],row['provider'],row['model'],usage,
                        row['status'],asr,usage,'provider_response' if usage else 'unknown')
            except (sqlite3.Error,ValueError) as error:warnings.append('ASR usage unavailable: '+str(asr)+' ('+type(error).__name__+')')
            finally:db.close()
        for path in sorted((root/'memory').glob('**/semantic*.sqlite3')):
            if path.resolve() in databases:continue
            databases.add(path.resolve());db=readonly(path)
            try:
                details=bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='usage_details'").fetchone())
                query='SELECT u.rowid,u.at,u.tokens,u.kind'+(',d.provider,d.model,d.raw' if details else '')+' FROM usage u'
                if details:query+=' LEFT JOIN usage_details d ON d.usage_rowid=u.rowid'
                query+=' WHERE u.at>=? AND u.at<?'
                for record in db.execute(query,(start,end)):
                    row=dict(record);raw=json.loads(row['raw']) if row.get('raw') else None
                    usage={**(raw or {}),'inputTokens':row['tokens'],'outputTokens':0}
                    add('embedding:'+str(path.resolve())+':'+str(row['rowid']),row['at'],'embedding_'+row['kind'],None,
                        row.get('provider'),row.get('model'),usage,'reported',path,raw,'input_only')
            except (sqlite3.Error,ValueError) as error:warnings.append('Embedding usage unavailable: '+str(path)+' ('+type(error).__name__+')')
            finally:db.close()
    # Shared life can be linked from both entry points. Only attempts without a
    # retained job are imported; regular job-backed attempts were counted above.
    for root in roots:
        path=Path(root)/'character-life/life.sqlite3'
        if not path.exists() or path.resolve() in databases:continue
        databases.add(path.resolve());db=readonly(path)
        try:
            for record in db.execute('SELECT id,at,status,usage FROM attempts WHERE at>=? AND at<?',(start,end)):
                row=dict(record)
                if row['id'] in life_jobs:continue
                value=json.loads(row['usage']) if row.get('usage') else {}
                add('life:'+row['id'],row['at'],'life',row['id'],value.get('provider'),value.get('model'),value,row['status'],path)
        except sqlite3.Error as error:warnings.append('Life usage unavailable: '+str(path)+' ('+type(error).__name__+')')
        finally:db.close()
    groups={}
    for row in rows:
        key=(row['stage'],row['provider'],row['model'])
        group=groups.setdefault(key,{'stage':key[0],'provider':key[1],'model':key[2],'records':0,
            'knownTotals':{field:0 for field in FIELDS},'unknownCounts':{field:0 for field in FIELDS}})
        group['records']+=1
        for field in FIELDS:
            if row[field] is None:group['unknownCounts'][field]+=1
            else:group['knownTotals'][field]+=row[field]
    return {'date':day,'timezone':'Asia/Shanghai','records':len(rows),'groups':list(groups.values()),'warnings':warnings,
      'limits':['Cached input is a subset of input; it is not added again.',
        'Only recorded facts are totaled. Unknown is not zero. No dollar price or cost is inferred.',
        'Legacy app-server records may contain only the last request of a multi-request turn.',
        'Codex app-server exposes native usage, not the provider raw billing response; unexposed cache-write counts remain unknown.',
        'Unrecorded failures, pre-upgrade visual calls, external image generation and autonomous code-repair calls have unknown usage here.'],
      'rows':sorted(rows,key=lambda row:(row['timestamp'],row['id']))}


def save_exports(report,directory):
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    base=directory/report['date'];json_path=base.with_suffix('.json');csv_path=base.with_suffix('.csv')
    json_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');json_path.chmod(0o600)
    columns=['id','at','stage','taskId','provider','model','status',*FIELDS,'scope','unknownFields','rawUsage','source']
    with csv_path.open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=columns,extrasaction='ignore');writer.writeheader()
        for row in report['rows']:
            writer.writerow({**row,'unknownFields':','.join(row['unknownFields']),
                'rawUsage':json.dumps(row['rawUsage'],ensure_ascii=False) if row['rawUsage'] is not None else ''})
    csv_path.chmod(0o600)
    return json_path,csv_path


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--date',default=datetime.now(TZ).strftime('%Y-%m-%d'))
    parser.add_argument('--root',action='append',type=Path);parser.add_argument('--output-dir',type=Path)
    args=parser.parse_args();os.umask(0o077)
    report=export_day(args.date,args.root or default_roots())
    if args.output_dir:save_exports(report,args.output_dir)
    print(json.dumps({k:v for k,v in report.items() if k!='rows'},ensure_ascii=False,indent=2))
