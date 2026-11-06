"""Offline snapshots/restore drills use only temporary fabricated state."""
import importlib.util
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('backup',Path(__file__).resolve().parents[1]/'scripts/backup-character-state.py')
backup=importlib.util.module_from_spec(spec);spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name);self.desktop=self.root/'desktop';self.control=self.root/'control';self.dest=self.root/'backups'
        for root in (self.desktop,self.control):root.mkdir()
        (self.desktop/'app').mkdir();(self.desktop/'bridge').mkdir();(self.desktop/'database-state').mkdir()
        (self.control/'character-life').mkdir();(self.control/'accounts').mkdir()
        backup.write_json(self.desktop/'database-state/cursor.json',{'cursor':{'room':42},'pendingMedia':[42]})
        backup.write_json(self.desktop/'bridge.json',{'ownerPeerId':'owner','accountId':'personal','enabled':True})
        backup.write_json(self.control/'accounts/bot.json',{'accountId':'control','userId':'owner','botToken':'TOP_SECRET'})
        backup.write_json(self.desktop/'app/message-queue.json',[{'id':'pending','jobContextToken':'CONTEXT_SECRET','text':'hello'}])
        (self.control/'config.env').write_text('API_KEY=ENV_SECRET\n')
        self.db=sqlite3.connect(self.desktop/'bridge/channel.sqlite3');self.addCleanup(self.db.close)
        self.db.execute('PRAGMA journal_mode=WAL');self.db.execute('PRAGMA wal_autocheckpoint=0')
        self.db.execute('CREATE TABLE incoming (id TEXT PRIMARY KEY, payload TEXT)')
        for key in ('first','second'):
            self.db.execute('INSERT INTO incoming VALUES (?,?)',(key,json.dumps({'text':'same message','context_token':'DB_SECRET'})))
        self.db.execute('CREATE TABLE outgoing (id TEXT PRIMARY KEY, status TEXT, server_id TEXT)')
        self.db.executemany('INSERT INTO outgoing VALUES (?,?,?)',[('sent','sent','123'),('unknown','uncertain',None)])
        self.db.commit()
        life=sqlite3.connect(self.control/'character-life/life.sqlite3')
        life.execute('CREATE TABLE ledger (id INTEGER PRIMARY KEY, money REAL)');life.execute('INSERT INTO ledger VALUES (1,123.45)')
        life.commit();life.close()

    def create(self):return backup.create_backup(self.desktop,self.control,self.dest)

    def test_standalone_backup_includes_life_without_a_control_directory(self):
        shutil.copytree(self.control/'character-life',self.desktop/'app/character-life')
        shutil.rmtree(self.control)
        snapshot=backup.create_backup(self.desktop,destination=self.dest)
        manifest=backup.verify_backup(snapshot)
        self.assertEqual(manifest['sourceRoots'],{'desktop':str(self.desktop)})
        self.assertFalse((snapshot/'control').exists())
        restored=backup.restore_isolated(snapshot,self.root/'standalone-restored')
        with sqlite3.connect(restored/'desktop/app/character-life/life.sqlite3') as db:
            self.assertEqual(db.execute('SELECT money FROM ledger').fetchone()[0],123.45)
        instructions=json.loads((restored/'RESTORE-NOT-ACTIVATED.json').read_text())
        self.assertFalse(instructions['activated'])
        self.assertFalse(any('control/character-life' in row for row in instructions['required']))
        with self.assertRaises(ValueError):backup.restore_isolated(snapshot,self.desktop/'new-target')

    def test_cli_does_not_select_a_control_root_implicitly(self):
        with patch('sys.argv',['backup-character-state.py','backup','--desktop',str(self.desktop),
                              '--destination',str(self.dest)]),\
             patch.object(backup,'create_backup',return_value=self.dest/'snapshot') as create,\
             patch.object(backup,'prune_owned',return_value=[]),redirect_stdout(io.StringIO()),\
             patch.object(backup.os,'umask'):
            backup.main()
        self.assertIsNone(create.call_args.args[1])

    def test_shared_life_link_requires_explicit_root_and_is_captured_once(self):
        (self.desktop/'app/character-life').symlink_to(self.control/'character-life',target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'select its root explicitly'):
            backup.create_backup(self.desktop,destination=self.dest)
        snapshot=self.create();manifest=backup.verify_backup(snapshot)
        paths=[row['path'] for row in manifest['files']]
        self.assertIn('control/character-life/life.sqlite3',paths)
        self.assertNotIn('desktop/app/character-life/life.sqlite3',paths)

    def test_wal_commits_receipts_and_cursor_survive_isolated_restore(self):
        snapshot=self.create();restored=backup.restore_isolated(snapshot,self.root/'restored')
        check=sqlite3.connect(restored/'desktop/bridge/channel.sqlite3')
        self.addCleanup(check.close)
        self.assertEqual(check.execute('SELECT count(*) FROM incoming').fetchone()[0],2)
        self.assertEqual(check.execute('SELECT status,server_id FROM outgoing WHERE id="sent"').fetchone(),('sent','123'))
        self.assertEqual(check.execute('SELECT status FROM outgoing WHERE id="unknown"').fetchone(),('uncertain',))
        self.assertEqual(json.loads((restored/'desktop/database-state/cursor.json').read_text())['cursor'],{'room':42})
        self.assertFalse(json.loads((restored/'RESTORE-NOT-ACTIVATED.json').read_text())['activated'])
        self.assertTrue((restored/'control/character-life/life.sqlite3').exists())

    def test_credentials_are_removed_without_changing_sources_or_private_modes(self):
        snapshot=self.create();manifest=backup.verify_backup(snapshot)
        self.assertNotIn('botToken',json.loads((snapshot/'control/accounts/bot.json').read_text()))
        self.assertNotIn('jobContextToken',json.loads((snapshot/'desktop/app/message-queue.json').read_text())[0])
        self.assertNotIn(b'DB_SECRET',(snapshot/'desktop/bridge/channel.sqlite3').read_bytes())
        self.assertIn('DB_SECRET',self.db.execute('SELECT payload FROM incoming LIMIT 1').fetchone()[0])
        self.assertIn('TOP_SECRET',(self.control/'accounts/bot.json').read_text())
        self.assertFalse((snapshot/'control/config.env').exists())
        self.assertEqual(snapshot.stat().st_mode&0o777,0o700)
        self.assertTrue(all((snapshot/r['path']).stat().st_mode&0o777==0o600 for r in manifest['files']))

    def test_validation_rejects_tampering_and_restore_never_overwrites_runtime(self):
        snapshot=self.create()
        with self.assertRaises(ValueError):backup.restore_isolated(snapshot,self.desktop)
        with self.assertRaises(ValueError):backup.restore_isolated(snapshot,self.desktop/'new-subdir')
        (snapshot/'desktop/bridge.json').write_text('{}')
        with self.assertRaises(ValueError):backup.restore_isolated(snapshot,self.root/'restored')
        self.assertFalse((self.root/'restored').exists())

    def test_bad_source_never_publishes_partial_snapshot_or_deletes_previous(self):
        first=self.create();(self.desktop/'bridge.json').write_text('{invalid')
        with self.assertRaises(ValueError):self.create()
        self.assertTrue(first.exists());self.assertEqual(len(list(self.dest.glob('ruanruan-state-*'))),1)
        self.assertFalse(list(self.dest.glob('.incomplete-*')))

    def test_retention_removes_only_owned_new_format_snapshots(self):
        owned=self.create();manifest=json.loads((owned/'manifest.json').read_text())
        now=time.time();manifest['captureFinishedAt']=now-8*86400;backup.write_json(owned/'manifest.json',manifest)
        foreign=self.dest/'ruanruan-state-20200101T000000Z-01234567';shutil.copytree(owned,foreign)
        foreign_manifest=dict(manifest,storeId='unrelated');backup.write_json(foreign/'manifest.json',foreign_manifest)
        old=self.dest/'old-persona-backups';old.mkdir();(old/'keep').write_text('unrelated')
        self.assertEqual(backup.prune_owned(self.dest,now=now),[str(owned)])
        self.assertTrue(owned.exists())
        self.assertEqual(backup.prune_owned(self.dest,now=now,apply=True),[str(owned)])
        self.assertTrue(foreign.exists());self.assertTrue((old/'keep').exists())

    def test_manifest_cannot_traverse_or_follow_external_symlink(self):
        snapshot=self.create();manifest=json.loads((snapshot/'manifest.json').read_text())
        manifest['files'][0]['path']='../../outside';backup.write_json(snapshot/'manifest.json',manifest)
        with self.assertRaises(ValueError):backup.verify_backup(snapshot)

    def test_external_state_link_is_rejected(self):
        (self.desktop/'app/sessions').mkdir();(self.root/'secret.json').write_text('{}')
        (self.desktop/'app/sessions/external.json').symlink_to(self.root/'secret.json')
        with self.assertRaises(ValueError):self.create()

    def test_only_exact_trusted_persona_links_are_allowed(self):
        persona=self.root/'trusted-persona';persona.mkdir();(persona/'GENERATE.md').write_text('persona instructions')
        (self.desktop/'app/GENERATE.md').symlink_to(persona/'GENERATE.md')
        with patch.object(backup,'PERSONA_ROOT',persona):
            snapshot=self.create()
            self.assertEqual((snapshot/'desktop/app/GENERATE.md').read_text(),'persona instructions')
        with self.assertRaises(ValueError):self.create()

    def test_sqlite_vec_snapshot_is_validated_with_trusted_extension(self):
        if not backup.DEFAULT_EXTENSION.is_file():self.skipTest('sqlite-vec not installed')
        root=self.desktop/'app/memory';root.mkdir()
        db=sqlite3.connect(root/'semantic.sqlite3');db.enable_load_extension(True)
        db.load_extension(str(backup.DEFAULT_EXTENSION));db.enable_load_extension(False)
        db.execute('CREATE VIRTUAL TABLE embedding USING vec0(embedding float[2])')
        db.execute("INSERT INTO embedding(rowid,embedding) VALUES (1,'[0.5,0.25]')");db.commit();db.close()
        snapshot=backup.create_backup(self.desktop,self.control,self.dest,backup.DEFAULT_EXTENSION)
        manifest=backup.verify_backup(snapshot,backup.DEFAULT_EXTENSION)
        self.assertTrue(any(r['path'].endswith('semantic.sqlite3') for r in manifest['files']))


if __name__=='__main__':unittest.main()
