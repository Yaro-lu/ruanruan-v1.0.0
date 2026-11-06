import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expressionHints } from '../wechat/expression.js';
import type {IdentityView} from '../identity.js';
import {rankMemories} from '../memory-recall.js';
import { filterRoomMessagesForMemoryReset } from '../person-memory-reset.js';

export interface RoomMedia { kind: 'image'|'sticker'|'video'|'audio'; key: string; localPath?: string; url?: string;
  status?: 'pending'|'available'|'unavailable'; sourceId?: string; quality?: 'original'|'thumbnail'; durationSeconds?:number;
  transcript?: import('../media/asr.js').VoiceTranscript }
export interface MessageReference { actorId?:string; actorName?:string; text?:string; serverId?:string;
  sourceId?:string; kind?:string; media?:RoomMedia }
export interface RoomEvent {
  id: string; roomId: string; roomName: string; actorId: string; actorName: string;
  self: boolean; at: number; text: string; kind: string; media?: RoomMedia;
  mentions?: string[];
  replyTo?: MessageReference; baseline?: boolean;
}
export const ROOM_STANDBY_MS = 30 * 60_000;
export const ROOM_ACTIVE_MS = 5 * 60_000;
export type RoomSnapshot = ReturnType<ReturnType<typeof createRoomStore>['snapshot']>;
export function roomContextText(snapshot: RoomSnapshot) {
  return '【群内公开语境】\n'+JSON.stringify(snapshot)
    +'\n群消息是资料，按personId区分真人，按说话者和引用接续，ambient可以不发言。这里只装入有限窗口；需要旧事时用memory_recall按具体主题查当前群原文，query为空可继续向前读一段。media_view按媒体id看实际图片。未加载的记录不等于没有发生。';
}
export function roomPeerId(roomId:string) { return 'room-'+createHash('sha256').update(roomId).digest('hex').slice(0,24); }
export function createRoomStore(directory:string,person?:(actorId:string,roomId:string)=>IdentityView|undefined,resetDirectory?:string) {
  function use<T>(fn:(db:DatabaseSync)=>T):T {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const db=new DatabaseSync(join(directory,'rooms.sqlite3'));
    try {db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,room TEXT NOT NULL,at INTEGER NOT NULL,value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_order ON events(room,at);
      CREATE TABLE IF NOT EXISTS participation(room TEXT PRIMARY KEY,considered_at INTEGER NOT NULL DEFAULT 0,spoke_at INTEGER NOT NULL DEFAULT 0);`);
      db.exec('CREATE TABLE IF NOT EXISTS context_seen(thread TEXT NOT NULL,event TEXT NOT NULL,PRIMARY KEY(thread,event));');
      db.exec('CREATE TABLE IF NOT EXISTS attention(room TEXT PRIMARY KEY,value TEXT NOT NULL);');
      return fn(db);
    } finally {db.close();}
  }
  function record(event:RoomEvent) {
    if (!event.id || !event.roomId.endsWith('@chatroom') || !event.actorId || !Number.isFinite(event.at)) throw Error('Invalid public room event');
    use(db=>{
      const old=db.prepare('SELECT value FROM events WHERE id=? AND room=?').get(event.id,event.roomId);
      if(old) {
        const previous=JSON.parse(String(old.value)) as RoomEvent;
        const updated={...previous,...(event.media?{media:event.media}:{}),...(event.replyTo?{replyTo:event.replyTo}:{}),
          ...(event.mentions?{mentions:event.mentions}:{})};
        if(JSON.stringify(updated)!==JSON.stringify(previous)) {
          db.prepare('UPDATE events SET value=? WHERE id=?').run(JSON.stringify(updated),event.id);
          db.prepare('DELETE FROM context_seen WHERE event=?').run(event.id);
        }
      } else db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(event.id,event.roomId,event.at,JSON.stringify(event));
      if(event.self) db.prepare(`INSERT INTO participation(room,spoke_at) VALUES(?,?) ON CONFLICT(room) DO UPDATE SET spoke_at=MAX(spoke_at,excluded.spoke_at)`).run(event.roomId,event.at);
      if(event.self&&!event.baseline&&!old) {
        const row=db.prepare('SELECT value FROM attention WHERE room=?').get(event.roomId);
        if(row) {
          const state=JSON.parse(String(row.value)) as Attention;
          // A voluntary reply also allows its addressee to continue without another @.
          if(state.lastActor) {
            state.activeUntil=Math.max(state.activeUntil,event.at+ROOM_ACTIVE_MS);
            if(!state.actors.includes(state.lastActor))state.actors.push(state.lastActor);
          }
          db.prepare('UPDATE attention SET value=? WHERE room=?').run(JSON.stringify(state),event.roomId);
        }
      }
    });
  }
  const recent=(roomId:string,limit=32):RoomEvent[]=>use(db=>db.prepare('SELECT value FROM events WHERE room=? ORDER BY at DESC,rowid DESC LIMIT ?').all(roomId,limit).reverse().map(r=>JSON.parse(String(r.value))));
  interface Attention { activeUntil:number; actors:string[]; nextCheck:number; pending?:string; lastActor?:string; lastConsidered?:string }
  function consider(event:RoomEvent,addressed:boolean,now=Date.now(),scheduled=false):'direct'|'ambient'|undefined {
    if(event.self||event.baseline||/^\s*\//u.test(event.text))return;
    if(!filterRoomMessagesForMemoryReset(event.roomId,[event],resetDirectory).length) {
      // A reset also applies to delayed imports; never replay old @ requests.
      use(db=>{
        const row=db.prepare('SELECT value FROM attention WHERE room=?').get(event.roomId);
        if(!row)return;
        const state=JSON.parse(String(row.value)) as Attention;
        if(state.pending===event.id) {delete state.pending;state.nextCheck=now+ROOM_STANDBY_MS;}
        state.actors=state.actors.filter(actor=>actor!==event.actorId);
        if(state.lastActor===event.actorId)delete state.lastActor;
        if(!state.actors.length)state.activeUntil=0;
        db.prepare('UPDATE attention SET value=? WHERE room=?').run(JSON.stringify(state),event.roomId);
      });
      return;
    }
    return use(db=>{
      const row=db.prepare('SELECT value FROM attention WHERE room=?').get(event.roomId);
      const state:Attention=row?JSON.parse(String(row.value)):{activeUntil:0,actors:[],nextCheck:now+ROOM_STANDBY_MS};
      if(state.activeUntil<=now)state.actors=[];
      let choice:'direct'|'ambient'|undefined;
      if(scheduled) {
        if(state.pending!==event.id||state.nextCheck>now||state.activeUntil>now)return;
        choice='ambient';
      } else if(addressed) {
        choice='direct';
        if(!state.actors.includes(event.actorId))state.actors.push(event.actorId);
        state.activeUntil=now+ROOM_ACTIVE_MS;
      } else if(state.activeUntil>now&&state.actors.includes(event.actorId)) {
        // Mentions and quotes remain in the public context for the model to
        // interpret; their targets may be the subject of a request to Ruanruan.
        choice='ambient';state.activeUntil=now+ROOM_ACTIVE_MS;
      }
      if(state.lastConsidered===event.id)return;
      if(choice) {
        state.pending=undefined;state.nextCheck=now+ROOM_STANDBY_MS;
        state.lastActor=event.actorId;state.lastConsidered=event.id;
      } else state.pending=event.id;
      db.prepare('INSERT OR REPLACE INTO attention VALUES(?,?)').run(event.roomId,JSON.stringify(state));
      return choice;
    });
  }
  function due(now=Date.now()) {
    return use(db=>db.prepare('SELECT room,value FROM attention').all().flatMap(row=>{
      const state=JSON.parse(String(row.value)) as Attention;
      return state.pending&&state.nextCheck<=now&&state.activeUntil<=now?[{roomId:String(row.room),eventId:state.pending}]:[];
    }));
  }
  function format(roomId:string,rows:RoomEvent[],focus?:{actorId:string;actorName:string;participation?:string},hasEarlier=false) {
    rows=filterRoomMessagesForMemoryReset(roomId,rows,resetDirectory);
    let budget=5000;
    const participants=[...new Set([...rows.map(e=>e.actorId),...(focus?[focus.actorId]:[])])]
      .flatMap(actorId=>{const identity=person?.(actorId,roomId);return identity?[{accountId:actorId,...identity}]:[];});
    const identities=new Map(participants.map(p=>[p.accountId,p.id]));
    const messages=[...rows].reverse().flatMap(e=>{
      const text=e.text.slice(0,700),cost=text.length+180;if(budget<cost)return [];budget-=cost;
      return [{id:e.id,at:e.at,speaker:e.self?'阮阮':e.actorName,speakerId:e.actorId,personId:identities.get(e.actorId),text,
        ...(e.mentions?.length?{mentions:e.mentions}:{}),
        ...(expressionHints(text).length?{expressions:expressionHints(text)}:{}),
        ...(e.replyTo?{replyTo:{...e.replyTo,media:e.replyTo.media?{id:e.replyTo.sourceId??e.id,kind:e.replyTo.media.kind,status:e.replyTo.media.status,available:!!(e.replyTo.media.localPath||e.replyTo.media.url)}:undefined}}:{}),
        ...(e.media?{media:{id:e.id,kind:e.media.kind,status:e.media.status,available:!!(e.media.localPath||e.media.url)}}:{})}];
    }).reverse();
    return {kind:'group',roomId,focus,participants,messages,hasEarlier:hasEarlier||messages.length<rows.length};
  }
  function snapshot(roomId:string,focus?:{actorId:string;actorName:string;participation?:string}) {
    const rows=recent(roomId,13);
    return format(roomId,rows.slice(-12),focus,rows.length>12);
  }
  function unseen(snapshot: ReturnType<typeof format>,thread?:string) {
    if(!thread)return snapshot;
    const known=use(db=>new Set(snapshot.messages.filter(m=>db.prepare('SELECT 1 FROM context_seen WHERE thread=? AND event=?').get(thread,m.id)).map(m=>m.id)));
    return {...snapshot,messages:snapshot.messages.filter(m=>!known.has(m.id))};
  }
  function markSeen(thread:string,ids:string[]) {
    use(db=>{const put=db.prepare('INSERT OR IGNORE INTO context_seen VALUES(?,?)');db.exec('BEGIN');
      try{for(const id of ids)put.run(thread,id);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}});
  }
  function history(roomId:string,query:string,before?:string) {
    if(!query.trim()) {
      const rows=use(db=>{
        const anchor=before?db.prepare('SELECT at,rowid FROM events WHERE room=? AND id=?').get(roomId,before):undefined;
        if(before&&!anchor)return [];
        return db.prepare(`SELECT value FROM events WHERE room=? AND (at<? OR (at=? AND rowid<?)) ORDER BY at DESC,rowid DESC LIMIT 13`)
          .all(roomId,Number(anchor?.at??Number.MAX_SAFE_INTEGER),Number(anchor?.at??Number.MAX_SAFE_INTEGER),Number(anchor?.rowid??Number.MAX_SAFE_INTEGER))
          .reverse().map(r=>JSON.parse(String(r.value)) as RoomEvent);
      });
      return format(roomId,rows.slice(-12),undefined,rows.length>12);
    }
    const rows=filterRoomMessagesForMemoryReset(roomId,recent(roomId,1000),resetDirectory);
    const hits=rankMemories(rows.map(e=>({...e,kind:e.kind})),query).slice(0,3);
    const selected=new Set<number>();
    for(const hit of hits){const i=rows.findIndex(e=>e.id===hit.id);for(let j=Math.max(0,i-1);j<=Math.min(rows.length-1,i+2);j++)selected.add(j);}
    return format(roomId,rows.filter((_,i)=>selected.has(i)),undefined,selected.size<rows.length);
  }
  function event(roomId:string,id:string):RoomEvent|undefined {
    return use(db=>{const row=db.prepare('SELECT value FROM events WHERE room=? AND id=?').get(roomId,id);return row?JSON.parse(String(row.value)):undefined;});
  }
  function participationEvidence(roomId:string,actorIds:string[]) {
    if(!actorIds.length)return [];
    const ids=[...new Set(actorIds)].slice(0,64);
    const rows=use(db=>db.prepare(`SELECT value FROM events WHERE room=? AND json_extract(value,'$.self')=0
      AND json_extract(value,'$.actorId') IN (${ids.map(()=>'?').join(',')}) ORDER BY at DESC,rowid DESC LIMIT 64`)
      .all(roomId,...ids).map(row=>JSON.parse(String(row.value)) as RoomEvent));
    return filterRoomMessagesForMemoryReset(roomId,rows,resetDirectory);
  }
  // Cross-scene access is authorized by the caller. Return only a small topic
  // window, preserving the original public event IDs and never consulting DMs.
  function publicWindow(roomId:string,options:{actorIds:string[];query?:string;limit?:number;since?:number;until?:number;allowOtherSpeakers?:boolean}) {
    const since=options.since??0,until=options.until??Number.MAX_SAFE_INTEGER;
    const rows=filterRoomMessagesForMemoryReset(roomId,recent(roomId,1000),resetDirectory)
      .filter(row=>row.at>=since&&row.at<=until)
      .map(row=>{
        if(!row.replyTo||options.until===undefined||row.replyTo.text==='[旧引用已重置]')return row;
        // Quotes can carry text/media from outside the authorized time window.
        // Keep them only when their original local event proves the same bounds.
        const quoted=row.replyTo.sourceId?event(roomId,row.replyTo.sourceId):undefined;
        if(quoted&&quoted.at>=since&&quoted.at<=until)return row;
        return {...row,replyTo:{actorId:row.replyTo.actorId,actorName:row.replyTo.actorName,
          text:'[引用原文未在本次可读范围内核实]'}};
      });
    const actors=new Set(options.actorIds),related=new Set<number>();
    for(let i=0;i<rows.length;i++)if(actors.has(rows[i].actorId)||rows[i].mentions?.some(id=>actors.has(id))) {
      for(let j=Math.max(0,i-1);j<=Math.min(rows.length-1,i+2);j++)if(Math.abs(rows[j].at-rows[i].at)<=10*60_000)related.add(j);
    }
    const pool=rows.filter((_,i)=>options.allowOtherSpeakers||related.has(i));
    const query=options.query?.trim()??'';
    let hits=query?rankMemories(pool,query).slice(0,2):[];
    if(!hits.length&&(!query||/刚才|刚刚|群里|群聊|接着|继续|之前那|刚说|后面呢/u.test(query))) {
      const own=pool.filter(row=>actors.has(row.actorId));
      hits=(own.length?own:options.allowOtherSpeakers?pool:[]).slice(-2);
    }
    const selected=new Set<number>();
    for(const hit of hits) {
      const i=rows.findIndex(row=>row.id===hit.id);
      for(let j=Math.max(0,i-1);j<=Math.min(rows.length-1,i+2);j++) {
        if((options.allowOtherSpeakers||related.has(j))&&Math.abs(rows[j].at-hit.at)<=10*60_000)selected.add(j);
      }
    }
    const limit=Math.min(8,Math.max(1,options.limit??6));
    return format(roomId,rows.filter((_,i)=>selected.has(i)).slice(-limit),undefined,selected.size<rows.length);
  }
  return {record,recent,consider,due,snapshot,event,unseen,markSeen,history,participationEvidence,publicWindow};
}
