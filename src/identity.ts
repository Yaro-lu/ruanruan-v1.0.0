import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './constants.js';

export interface IdentityAccount { platform:'wechat'|'qq'; channelAccountId:string; actorId:string }
export interface IdentityAlias { name:string; kind:'account_id'|'handle'|'nickname'|'room_nickname'|'remark'|'observed'; scope?:string }
export interface PersonIdentity { id:string; name:string; preferredName?:string; nameSource:'account'|'operator'; storageKey:string }
export interface IdentityView { id:string; name:string; preferredName?:string; nameSource:'account'|'operator'; aliases:IdentityAlias[] }

// Names are searchable labels, never unique identifiers or authorization facts.
// This registry has no model-write tool. Cross-account binding is a local,
// operator-authorized operation and is never inferred from matching names.
export function createIdentityStore(directory=DATA_DIR) {
  function use<T>(fn:(db:DatabaseSync)=>T):T {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const path=join(directory,'identities.sqlite3');
    try {closeSync(openSync(path,'wx',0o600));} catch(e) {if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    const db=new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,name TEXT NOT NULL,name_source TEXT NOT NULL,storage_key TEXT UNIQUE NOT NULL,preferred_name TEXT);
        CREATE TABLE IF NOT EXISTS identity_accounts(platform TEXT NOT NULL,channel_account TEXT NOT NULL,actor TEXT NOT NULL,
          person TEXT NOT NULL REFERENCES people(id),PRIMARY KEY(platform,channel_account,actor));
        CREATE TABLE IF NOT EXISTS identity_aliases(platform TEXT NOT NULL,channel_account TEXT NOT NULL,actor TEXT NOT NULL,
          name TEXT NOT NULL,kind TEXT NOT NULL,scope TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,
          PRIMARY KEY(platform,channel_account,actor,name,kind,scope));
        CREATE INDEX IF NOT EXISTS alias_name ON identity_aliases(name);
        CREATE INDEX IF NOT EXISTS person_accounts ON identity_accounts(person);`);
      if(!db.prepare('PRAGMA table_info(people)').all().some(c=>c.name==='preferred_name'))db.exec('ALTER TABLE people ADD COLUMN preferred_name TEXT');
      return fn(db);
    } finally {db.close();}
  }
  const values=(account:IdentityAccount)=>{
    if(!['wechat','qq'].includes(account.platform)||!account.channelAccountId||!account.actorId)throw Error('Identity needs a verified platform account');
    return [account.platform,account.channelAccountId,account.actorId] as const;
  };
  const decode=(r:any):PersonIdentity=>({id:r.id,name:r.name,...(r.preferred_name?{preferredName:r.preferred_name}:{}),nameSource:r.name_source,storageKey:r.storage_key});
  const find=(db:DatabaseSync,account:IdentityAccount)=>db.prepare(`SELECT p.* FROM people p JOIN identity_accounts a ON a.person=p.id
    WHERE a.platform=? AND a.channel_account=? AND a.actor=?`).get(...values(account));
  function observe(account:IdentityAccount,aliases:IdentityAlias[]=[],preferredName?:string):PersonIdentity {
    const keys=values(account),now=Date.now();
    if(aliases.some(a=>!a.name?.trim()||a.name.length>256||!['account_id','handle','nickname','room_nickname','remark','observed'].includes(a.kind)))throw Error('Invalid identity name');
    return use(db=>{
      db.exec('BEGIN IMMEDIATE');
      try {
        let row=find(db,account);
        if(!row) {
          // Retain the existing storage key so indexing identities never resets
          // affection, evidence, or the original per-person memory directory.
          const storageKey=JSON.stringify([account.channelAccountId,account.actorId]);
          const id='person_'+createHash('sha256').update(JSON.stringify(keys)).digest('hex').slice(0,24);
          db.prepare('INSERT INTO people(id,name,name_source,storage_key) VALUES(?,?,?,?)').run(id,preferredName?.trim()||account.actorId,'account',storageKey);
          db.prepare('INSERT INTO identity_accounts VALUES(?,?,?,?)').run(...keys,id);
          row=find(db,account);
        } else if(row.name_source==='account'&&row.name===account.actorId&&preferredName?.trim()) {
          db.prepare('UPDATE people SET name=? WHERE id=?').run(preferredName.trim(),row.id);row=find(db,account);
        }
        for(const alias of [{name:account.actorId,kind:'account_id' as const},...aliases]) {
          db.prepare(`INSERT INTO identity_aliases VALUES(?,?,?,?,?,?,?,?)
            ON CONFLICT(platform,channel_account,actor,name,kind,scope) DO UPDATE SET last_seen=excluded.last_seen`)
            .run(...keys,alias.name,alias.kind,alias.scope??'*',now,now);
        }
        db.exec('COMMIT');return decode(row);
      } catch(e) {db.exec('ROLLBACK');throw e;}
    });
  }
  function get(account:IdentityAccount):PersonIdentity|undefined {return use(db=>{const row=find(db,account);return row?decode(row):undefined;});}
  function view(account:IdentityAccount,audience='private'):IdentityView|undefined {
    return use(db=>{
      const row=find(db,account);if(!row)return;
      const aliases=db.prepare(`SELECT name,kind,scope FROM identity_aliases
        WHERE platform=? AND channel_account=? AND actor=? AND (scope='*' OR scope=?) ORDER BY last_seen DESC LIMIT 24`)
        .all(...values(account),audience) as unknown as IdentityAlias[];
      return {id:String(row.id),name:String(row.name),...(row.preferred_name?{preferredName:String(row.preferred_name)}:{}),nameSource:row.name_source as PersonIdentity['nameSource'],aliases};
    });
  }
  function setName(personId:string,name:string) {
    if(!name.trim()||name.length>128)throw Error('Invalid person label');
    return use(db=>{if(!db.prepare("UPDATE people SET name=?,name_source='operator' WHERE id=?").run(name.trim(),personId).changes)throw Error('Unknown person');});
  }
  function bindAccount(personId:string,account:IdentityAccount) {
    return use(db=>{
      if(!db.prepare('SELECT 1 FROM people WHERE id=?').get(personId))throw Error('Unknown person');
      const existing=find(db,account);
      if(existing&&existing.id!==personId)throw Error('Account already belongs to a different person; explicit data migration is required');
      db.prepare('INSERT OR IGNORE INTO identity_accounts VALUES(?,?,?,?)').run(...values(account),personId);
    });
  }
  function setPreferredName(personId:string,name:string) {
    if(!name.trim()||name.length>128)throw Error('Invalid preferred form of address');
    return use(db=>{if(!db.prepare('UPDATE people SET preferred_name=? WHERE id=?').run(name.trim(),personId).changes)throw Error('Unknown person');});
  }
  function lookupName(name:string) {
    return use(db=>db.prepare(`SELECT DISTINCT p.* FROM people p LEFT JOIN identity_accounts a ON a.person=p.id
      LEFT JOIN identity_aliases n ON n.platform=a.platform AND n.channel_account=a.channel_account AND n.actor=a.actor
      WHERE p.name=? OR p.preferred_name=? OR n.name=? ORDER BY p.id`).all(name,name,name).map(decode));
  }
  function resolveName(name:string,account:Pick<IdentityAccount,'platform'|'channelAccountId'>,audience='private') {
    return use(db=>db.prepare(`SELECT DISTINCT p.* FROM people p JOIN identity_accounts a ON a.person=p.id
      LEFT JOIN identity_aliases n ON n.platform=a.platform AND n.channel_account=a.channel_account AND n.actor=a.actor
        AND (n.scope='*' OR n.scope=?)
      WHERE a.platform=? AND a.channel_account=? AND (p.id=? OR p.name=? OR p.preferred_name=? OR n.name=?) ORDER BY p.id`)
      .all(audience,account.platform,account.channelAccountId,name,name,name,name).map(decode));
  }
  function accounts(personId:string):IdentityAccount[] {
    return use(db=>db.prepare('SELECT platform,channel_account,actor FROM identity_accounts WHERE person=?').all(personId)
      .map(row=>({platform:row.platform as IdentityAccount['platform'],channelAccountId:String(row.channel_account),actorId:String(row.actor)})));
  }
  function mentioned(text:string,account:Pick<IdentityAccount,'platform'|'channelAccountId'>,audience='private') {
    return use(db=>db.prepare(`SELECT DISTINCT p.* FROM people p JOIN identity_accounts a ON a.person=p.id
      LEFT JOIN identity_aliases n ON n.platform=a.platform AND n.channel_account=a.channel_account AND n.actor=a.actor
        AND (n.scope='*' OR n.scope=?)
      WHERE a.platform=? AND a.channel_account=? AND (
        (length(n.name)>=2 AND instr(?,n.name)>0) OR (length(p.name)>=2 AND instr(?,p.name)>0)
        OR (length(p.preferred_name)>=2 AND instr(?,p.preferred_name)>0)) ORDER BY p.id LIMIT 12`)
      .all(audience,account.platform,account.channelAccountId,text,text,text).map(decode));
  }
  const list=()=>use(db=>db.prepare('SELECT * FROM people ORDER BY id').all().map(decode));
  return {observe,get,view,setName,setPreferredName,bindAccount,lookupName,resolveName,accounts,mentioned,list};
}
