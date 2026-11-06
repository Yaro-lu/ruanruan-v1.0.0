import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime
from zoneinfo import ZoneInfo

spec=importlib.util.spec_from_file_location('usage_export',Path(__file__).resolve().parents[1]/'scripts/export-api-usage.py')
usage=importlib.util.module_from_spec(spec);spec.loader.exec_module(usage)


class UsageTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.day='2026-11-06'
        self.at=int(datetime(2026,11,6,12,tzinfo=ZoneInfo('Asia/Shanghai')).timestamp()*1000)

    def write(self,path,value):
        path=self.root/path;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value));return path

    def job(self,id,kind='codex',**changes):
        self.write('jobs/'+id+'/job.json',{'id':id,'kind':kind,'createdAt':self.at,'life':{'id':'life-attempt'} if kind=='life' else None,
          'options':{'model':'chat-model','llmProvider':'test-api','prompt':'PRIVATE_PROMPT'}})
        self.write('jobs/'+id+'/status.json',{'state':'completed','updatedAt':self.at,'result':{'inputTokens':100,'cachedInputTokens':80,
          'outputTokens':10,'usageDetails':{'scope':'reported_requests','raw':[{'last':{'inputTokens':100}}]},**changes}})

    def test_default_usage_roots_include_only_the_character_or_explicit_environment(self):
        with patch.dict(usage.os.environ,{},clear=True),patch.object(usage.Path,'home',return_value=self.root):
            self.assertEqual(usage.default_roots(),[self.root/'.wechat-codex-desktop/app'])
        selected=self.root/'selected-app'
        with patch.dict(usage.os.environ,{'WCB_DATA_DIR':str(selected)}):
            self.assertEqual(usage.default_roots(),[selected])

    def test_duplicate_roots_life_mirror_and_review_are_not_double_counted(self):
        self.job('chat',characterReview={'inputTokens':30,'outputTokens':3,'checks':1,'model':'review',
          'usageCalls':[{'at':self.at,'stage':'review','model':'review','provider':'test-api','inputTokens':30,'cachedInputTokens':20,'outputTokens':3}]})
        self.job('life','life')
        path=self.root/'character-life/life.sqlite3';path.parent.mkdir()
        db=sqlite3.connect(path);db.execute('CREATE TABLE attempts(id TEXT,at INTEGER,status TEXT,usage TEXT)')
        db.execute('INSERT INTO attempts VALUES(?,?,?,?)',('life-attempt',self.at,'committed',json.dumps({'inputTokens':100,'outputTokens':10})))
        db.commit();db.close()
        report=usage.export_day(self.day,[self.root,self.root])
        self.assertEqual(report['records'],3)
        self.assertEqual(sum(row['inputTokens'] for row in report['rows']),230)
        self.assertEqual(sum(row['cachedInputTokens'] for row in report['rows']),180)
        self.assertTrue(all(row['cacheWriteInputTokens'] is None for row in report['rows']))

    def test_asr_duration_and_unknown_visual_are_preserved_without_inventing_tokens(self):
        self.write('logs/visual-usage/v.json',{'id':'v','at':self.at,'provider':'api','model':'vision','status':'unknown'})
        path=self.root/'voice-transcription/cache.sqlite3';path.parent.mkdir()
        db=sqlite3.connect(path);db.execute('CREATE TABLE transcriptions(cache_key TEXT,source_id TEXT,provider TEXT,model TEXT,status TEXT,started_at INTEGER,result TEXT)')
        raw={'type':'duration','seconds':7.5}
        db.execute('INSERT INTO transcriptions VALUES(?,?,?,?,?,?,?)',('asr','voice:1','api','asr','complete',self.at,json.dumps({'text':'PRIVATE_TRANSCRIPT','usage':raw})))
        db.commit();db.close()
        report=usage.export_day(self.day,[self.root]);self.assertEqual(report['records'],2)
        asr=next(row for row in report['rows'] if row['stage']=='asr')
        self.assertIsNone(asr['inputTokens']);self.assertEqual(asr['rawUsage'],raw)
        self.assertNotIn('PRIVATE_TRANSCRIPT',json.dumps(report))

    def test_embedding_details_augment_legacy_row_instead_of_adding_call(self):
        path=self.root/'memory/person/semantic.sqlite3';path.parent.mkdir(parents=True)
        db=sqlite3.connect(path);db.executescript('CREATE TABLE usage(at INTEGER,tokens INTEGER,kind TEXT);CREATE TABLE usage_details(usage_rowid INTEGER PRIMARY KEY,provider TEXT,model TEXT,raw TEXT);')
        db.execute('INSERT INTO usage VALUES(?,?,?)',(self.at,17,'query'));db.execute('INSERT INTO usage_details VALUES(1,?,?,?)',('api','embed',json.dumps({'total_tokens':17})))
        db.commit();db.close()
        report=usage.export_day(self.day,[self.root]);self.assertEqual(report['records'],1)
        row=report['rows'][0];self.assertEqual(row['inputTokens'],17);self.assertEqual(row['outputTokens'],0)
        self.assertEqual(row['rawUsage'],{'total_tokens':17})

    def test_date_boundaries_and_private_exports(self):
        self.job('chat');self.job('old')
        p=self.root/'jobs/old/status.json';old=json.loads(p.read_text());old['updatedAt']=self.at-86400000;p.write_text(json.dumps(old))
        report=usage.export_day(self.day,[self.root]);self.assertEqual(report['records'],1)
        json_path,csv_path=usage.save_exports(report,self.root/'export')
        self.assertEqual(json_path.stat().st_mode&0o777,0o600);self.assertEqual(csv_path.stat().st_mode&0o777,0o600)
        self.assertNotIn('PRIVATE_PROMPT',json_path.read_text())


if __name__=='__main__':unittest.main()
