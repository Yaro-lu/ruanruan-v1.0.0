import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {memoryFtsQuery,memorySearchTerms} from './memory-tokenizer.js';

// Old generated transcripts are explicitly unverified. Keep their fallback
// searchable without parsing every JSONL file on every memory_recall call.
export function searchLegacyHistory(directory:string,query:string):any[] {
  const match=memoryFtsQuery(query);if(!match)return [];
  const db=new DatabaseSync(join(directory,'history-index.sqlite3'));
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS files(name TEXT PRIMARY KEY,size INTEGER NOT NULL,mtime REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY,file TEXT NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS rows_file ON rows(file);
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,terms);`);
    const history=join(directory,'history');
    const names=readdirSync(history).filter(name=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    for(const name of names) {
      const path=join(history,name),stat=statSync(path),old=db.prepare('SELECT * FROM files WHERE name=?').get(name);
      if(old?.size===stat.size&&old.mtime===stat.mtimeMs)continue;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM search WHERE id IN (SELECT id FROM rows WHERE file=?)').run(name);
        db.prepare('DELETE FROM rows WHERE file=?').run(name);
        const lines=readFileSync(path,'utf8').split('\n').filter(Boolean);
        lines.forEach((line,index)=>{
          const row=JSON.parse(line),id=row.id??`${name}:${index}`;
          db.prepare('INSERT OR REPLACE INTO rows VALUES(?,?,?)').run(id,name,JSON.stringify({...row,id}));
          db.prepare('INSERT INTO search(id,terms) VALUES(?,?)').run(id,memorySearchTerms(`${row.user??''}\n${row.assistant??''}`).join(' '));
        });
        db.prepare('INSERT OR REPLACE INTO files VALUES(?,?,?)').run(name,stat.size,stat.mtimeMs);
        db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');throw error;}
    }
    for(const old of db.prepare('SELECT name FROM files').all())if(!names.includes(String(old.name))) {
      db.prepare('DELETE FROM search WHERE id IN (SELECT id FROM rows WHERE file=?)').run(old.name);
      db.prepare('DELETE FROM rows WHERE file=?').run(old.name);db.prepare('DELETE FROM files WHERE name=?').run(old.name);
    }
    return db.prepare('SELECT r.value FROM search s JOIN rows r ON r.id=s.id WHERE search MATCH ? ORDER BY rank LIMIT 48')
      .all(match).map(row=>JSON.parse(String(row.value)));
  }finally{db.close();}
}
