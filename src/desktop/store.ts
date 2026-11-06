import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConversationProfile } from '../conversation.js';
import type { IncomingMessage } from '../wechat/channel.js';
import { MessageItemType, MessageState, MessageType } from '../wechat/types.js';
import { desktopContact, requireDesktopEnabled, type DesktopConfig, type DesktopContact } from './config.js';
import { SendRejected } from '../wechat/receipt.js';
import { createRoomStore, type RoomMedia } from './room-context.js';
import { databaseSourceId, outgoingTextMatches, validateDatabaseProof, type DatabaseMessageProof } from './database-proof.js';
import {observeDesktopPerson} from './identity.js';
import {manualControlState} from './manual-control.js';

type Kind = 'text' | 'image' | 'video';
export type DeliveryStatus = 'queued' | 'claimed' | 'ready' | 'sent' | 'rejected' | 'uncertain' | 'cancelled';
export interface DesktopDelivery {
  id: string; accountId: string; peerId: string; uiLabel: string; clientId: string;
  kind: Kind; text?: string; filePath?: string; desktopPath?: string;
  mention?: { username: string; name: string };
  context: string; thread?: string; profile: ConversationProfile;
  status: DeliveryStatus; leaseId?: string; leaseUntil?: number;
  evidence?: { screenshotPath?: string; observedAt: number; database?: DatabaseMessageProof }; error?: string;
  cancelCause?: 'superseded';
  queuedAt?: number;
}
export interface VisibleIncoming {
  peerId: string; uiLabel: string; sourceMessageId: string; text: string;
  screenshotPath?: string;
  database?: DatabaseMessageProof;
  unavailableMedia?: IncomingMessage['unavailableMedia'];
  media?: RoomMedia; actor?: {username:string;name:string}; replyTo?: import('./room-context.js').MessageReference; contextOnly?:boolean; self?:boolean;
  attachment?: { kind: 'image' | 'audio' | 'video'; path: string };
}
export interface VisibleReceipt {
  id: string; leaseId: string; status: 'sent' | 'rejected' | 'uncertain';
  uiLabel: string; screenshotPath?: string; observedText?: string;
  attachmentVisible?: boolean; error?: string;
  database?: DatabaseMessageProof;
}
export interface VisibleBubble {
  direction: 'in' | 'out';
  kind: 'text' | 'image' | 'audio' | 'video';
  text: string;
  visualKey?: string;
  attachmentPath?: string;
}
export interface DesktopObservation {
  uiLabel: string; atBottom: boolean; screenshotPath: string; messages: VisibleBubble[];
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const digestMd5 = (value: Buffer) => createHash('md5').update(value).digest('hex');
const decode = (row: any): DesktopDelivery => ({ ...JSON.parse(row.payload), status: row.status,
  leaseId: row.lease_id ?? undefined, leaseUntil: row.lease_until ?? undefined,
  evidence: row.evidence ? JSON.parse(row.evidence) : undefined, error: row.error ?? undefined });

function currentMention(contact: DesktopContact, mention?: DesktopDelivery['mention']): DesktopDelivery['mention'] {
  if (!mention) return undefined;
  const members = contact.members ?? (contact.actorUsername && contact.actorName
    ? [{ username: contact.actorUsername, name: contact.actorName }] : []);
  const matches = members.filter(member => member.username === mention.username);
  if (matches.length !== 1 || !matches[0].name?.trim())
    throw new SendRejected('Group reply member is not uniquely identified in the current address book');
  // Names are mutable presentation data; never resolve a recipient by name.
  return { username: mention.username, name: matches[0].name };
}

export function createDesktopStore(config: DesktopConfig, now = Date.now) {
  const path = join(config.queueDirectory, 'channel.sqlite3');
  function use<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(config.queueDirectory, { recursive: true, mode: 0o700 });
    try { closeSync(openSync(path, 'wx', 0o600)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS incoming (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, peer TEXT NOT NULL,
          source TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, evidence TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', error TEXT, UNIQUE(account,peer,source));
        CREATE TABLE IF NOT EXISTS outgoing (
          id TEXT PRIMARY KEY, account TEXT NOT NULL, client TEXT NOT NULL, fingerprint TEXT NOT NULL,
          payload TEXT NOT NULL, status TEXT NOT NULL, lease_id TEXT, lease_until INTEGER,
          evidence TEXT, error TEXT, UNIQUE(account,client));
        CREATE TABLE IF NOT EXISTS ui_lease (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, delivery TEXT NOT NULL,
          expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS channel_pause(account TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS send_hold(account TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS observations(account TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
      db.exec('BEGIN IMMEDIATE');
      db.exec('CREATE TABLE IF NOT EXISTS media_requests(source TEXT PRIMARY KEY,requested INTEGER NOT NULL,status TEXT NOT NULL);');
      try {
        const lease = db.prepare('SELECT * FROM ui_lease WHERE singleton=1').get();
        if (lease && Number(lease.expires) <= now()) {
          db.prepare(`UPDATE outgoing SET status=CASE WHEN status='claimed' THEN 'cancelled' ELSE 'uncertain' END,
            error='Desktop operation lease expired; inspect the UI before any resend' WHERE id=? AND status IN ('claimed','ready')`).run(lease.delivery);
          db.exec('DELETE FROM ui_lease');
          const expired = db.prepare('SELECT account,status FROM outgoing WHERE id=?').get(lease.delivery);
          if (expired?.account === config.accountId && expired.status === 'uncertain')
            writeSendHold(db, 'Desktop operation expired after authorization; checking the original receipt', String(lease.delivery));
        }
        const result = fn(db); db.exec('COMMIT'); return result;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    } finally { db.close(); }
  }
  function exchangeFile(source: string): Buffer {
    const root = realpathSync(config.exchangeDirectory), file = realpathSync(source);
    const rel = relative(root, file);
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || rel.startsWith(sep)) throw new Error('File must come from the desktop exchange directory');
    return readFileSync(file);
  }
  function screenshotBytes(source: string) {
    const bytes = exchangeFile(source);
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('Expected an actual PNG desktop screenshot');
    return bytes;
  }
  function saveEvidence(source: string) {
    const bytes = screenshotBytes(source);
    const folder = join(config.queueDirectory, 'evidence'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    const target = join(folder, randomUUID() + '.png'); writeFileSync(target, bytes, { mode: 0o600 });
    return { screenshotPath: target, observedAt: now() };
  }
  function pauseState(db: DatabaseSync) {
    const row = db.prepare('SELECT payload FROM channel_pause WHERE account=?').get(config.accountId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  function sendHold(db: DatabaseSync) {
    const row = db.prepare('SELECT payload FROM send_hold WHERE account=?').get(config.accountId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  function requireReceiving(db: DatabaseSync) {
    const paused = pauseState(db);
    if (paused) throw new SendRejected(`桌面通道已暂停：${paused.reason}`);
  }
  function requireRunning(db: DatabaseSync) {
    const manual=manualControlState(config.queueDirectory);
    const paused = pauseState(db) ?? sendHold(db) ?? (manual.active?manual:undefined);
    if (paused) throw new SendRejected(`桌面通道已暂停：${paused.reason}`);
  }
  function incoming(input: VisibleIncoming) {
    return use(db => { requireReceiving(db); return incomingWithDb(input, db); });
  }
  function incomingWithDb(input: VisibleIncoming, db: DatabaseSync) {
    requireDesktopEnabled(config); desktopContact(config, input.peerId, input.uiLabel);
    if (typeof input.sourceMessageId !== 'string' || !input.sourceMessageId.trim() || input.sourceMessageId.length > 240
      || typeof input.text !== 'string' || (!input.text.trim() && !input.attachment && !input.unavailableMedia && !input.media)) throw new Error('Expected a new visible message with a stable occurrence ID');
    if (input.unavailableMedia && (!input.database || input.attachment
      || ({image:3,audio:34,video:43,sticker:47})[input.unavailableMedia] !== input.database.messageType)) throw Error('Unavailable media must describe the actual database message type');
    if (input.attachment && !['image', 'audio', 'video'].includes(input.attachment.kind)) throw new Error('Unsupported desktop attachment');
    const file = input.attachment ? exchangeFile(input.attachment.path) : undefined;
    const fingerprint = digest(JSON.stringify([input.text, input.attachment?.kind ?? input.unavailableMedia ?? input.media?.key, file && digest(file)]));
      const old = db.prepare('SELECT * FROM incoming WHERE account=? AND peer=? AND source=?')
        .get(config.accountId, input.peerId, input.sourceMessageId);
      if(old && !input.database) {
        if(old.fingerprint!==fingerprint)throw new Error('Message occurrence ID was reused for different content');
        return {seq:Number(old.seq),duplicate:true};
      }
      if (input.database) {
        validateDatabaseProof(config, input.database, 'in',input.peerId);
        if((input.media||input.unavailableMedia||input.attachment)&&input.text!==(input.database.displayText??''))throw Error('Media text differs from its database record');
        if (input.sourceMessageId !== databaseSourceId(input.database)
          || (input.attachment || input.unavailableMedia || input.media ? ![3,34,43,47].includes(input.database.messageType)
            : ![1,2,49].includes(input.database.messageType) || (input.database.displayText??input.database.text) !== input.text)) {
          throw new Error('Incoming content does not match its database record');
        }
      }
      const evidence = input.database ? { database: input.database, observedAt: now() } : saveEvidence(input.screenshotPath!);
      if(old) {
        const previous=JSON.parse(String(old.evidence)).database;
        if(!previous || ['accountDirectory','selfUsername','ownerUsername','conversationUsername','senderUsername','shard','localId','serverId','createdAt','messageType']
          .some(key=>previous[key] !== (input.database as any)[key])
          || (previous.text!==input.database!.text && input.database!.messageType!==34))
          throw new Error('Message occurrence ID was reused for different content');
      }
      const items: IncomingMessage['item_list'] = input.text ? [{ type: MessageItemType.TEXT, text_item: { text: input.text } }] : [];
      const message: IncomingMessage = { from_user_id: input.peerId, to_user_id: config.accountId, desktopSourceId:input.sourceMessageId,
        create_time_ms: input.database?.createdAt ?? now(), message_type: MessageType.USER, message_state: MessageState.FINISH, item_list: items };
      const contact=desktopContact(config,input.peerId);
      if (input.unavailableMedia) message.unavailableMedia = input.unavailableMedia;
      if (input.replyTo) message.replyTo=input.replyTo;
      if(input.database?.atUsernames)message.mentions=[...input.database.atUsernames];
      if (input.media) message.desktopMedia=input.media;
      if (input.database?.messageType===34) {
        message.desktopVoiceWaitUntil=now()+60_000;
        if (input.media?.transcript?.text?.trim()) {
          message.localMedia={kind:'voice',item:{type:MessageItemType.VOICE},sourceId:input.sourceMessageId,
            transcript:input.media.transcript,durationSeconds:input.media.durationSeconds};
          message.unavailableMedia=undefined;
        }
      }
      if (input.database?.payment) message.desktopPayment=input.database.payment;
      const actorId=input.database?.senderUsername??contact.actorUsername??contact.username!;
      const actorName=contact.members?.find(m=>m.username===actorId)?.name??input.actor?.name??contact.actorName??contact.uiLabel;
      if(input.actor && input.actor.username!==actorId)throw Error('Actor differs from the database sender');
      if (contact.username) message.chatContext={kind:contact.kind??'private',conversationId:contact.username,
        conversationName:contact.uiLabel,actorId,actorName,person:observeDesktopPerson(config,contact,actorId,actorName)};
      if(contact.kind==='group') {
        const id=input.sourceMessageId;
        createRoomStore(config.queueDirectory).record({id,roomId:contact.username!,roomName:contact.uiLabel,
          actorId,actorName,self:actorId===config.database?.selfUsername,at:message.create_time_ms!,text:input.text,
          kind:input.media?.kind??input.unavailableMedia??input.attachment?.kind??'text',media:input.media,replyTo:input.replyTo,
          mentions:input.database?.atUsernames,baseline:input.contextOnly});
        message.roomEventId=id;message.contextOnly=input.contextOnly||actorId===config.database?.selfUsername;
        message.addressed=input.database?.atUsernames?.length
          ?input.database.atUsernames.includes(config.database!.selfUsername)
          :input.replyTo?.actorId===config.database?.selfUsername;
      }
      if (input.attachment && file) {
        const folder = join(config.queueDirectory, 'incoming'); mkdirSync(folder, { recursive: true, mode: 0o700 });
        const localPath = join(folder, digest(file) + extname(input.attachment.path)); writeFileSync(localPath, file, { mode: 0o600 });
        const kind = input.attachment.kind;
        const item = { type: kind === 'image' ? MessageItemType.IMAGE : kind === 'video' ? MessageItemType.VIDEO : MessageItemType.FILE };
        items.push(item); message.localMedia = kind==='audio' && input.database?.messageType===34
          ? {kind:'voice',item:{type:MessageItemType.VOICE},localPath,sourceId:input.sourceMessageId,
            durationSeconds:input.media?.durationSeconds,transcript:input.media?.transcript}
          : { kind, item, localPath };
        if(message.localMedia)message.unavailableMedia=undefined;
      }
      if(old) {
        const previous:IncomingMessage=JSON.parse(String(old.payload));
        const updated={...previous,desktopSourceId:input.sourceMessageId,
          ...(contact.kind==='group'?{addressed:message.addressed}:{}),
          ...(message.replyTo?{replyTo:message.replyTo}:{}),...(message.desktopMedia?{desktopMedia:message.desktopMedia}:{}),
          ...(message.localMedia?{localMedia:message.localMedia}:{}),
          ...(message.desktopPayment?{desktopPayment:message.desktopPayment,item_list:items}:{}),
          ...(message.localMedia || message.desktopMedia?.status==='available'?{unavailableMedia:undefined}:{})};
        db.prepare('UPDATE incoming SET payload=?,evidence=?,fingerprint=? WHERE seq=?')
          .run(JSON.stringify(updated),JSON.stringify(evidence),fingerprint,old.seq);
        return {seq:Number(old.seq),duplicate:true};
      }
      const seq = Number(db.prepare('INSERT INTO incoming(account,peer,source,fingerprint,payload,evidence) VALUES(?,?,?,?,?,?)')
        .run(config.accountId, input.peerId, input.sourceMessageId, fingerprint, JSON.stringify(message), JSON.stringify(evidence)).lastInsertRowid);
      message.message_id = seq; message.context_token = `desktop:${seq}`;
      if(message.contextOnly)db.prepare("UPDATE incoming SET status='processed' WHERE seq=?").run(seq);
      db.prepare('UPDATE incoming SET payload=? WHERE seq=?').run(JSON.stringify(message), seq);
      return { seq, duplicate: false };
  }
  function takeIncoming(): { seq: number; message: IncomingMessage } | undefined {
    requireDesktopEnabled(config);
    return use(db => {
      if (pauseState(db) || sendHold(db) || manualControlState(config.queueDirectory).active) return undefined;
      const waitingActors=new Set<string>();
      const rows = db.prepare("SELECT seq,payload FROM incoming WHERE account=? AND status='pending' ORDER BY seq").all(config.accountId);
      for (const row of rows) {
        const message:IncomingMessage=JSON.parse(String(row.payload));
        const actor=JSON.stringify([message.from_user_id,message.chatContext?.actorId??message.from_user_id]);
        if (waitingActors.has(actor)) continue;
        if (message.desktopVoiceWaitUntil && now()<message.desktopVoiceWaitUntil && !message.localMedia
          && message.desktopMedia?.status!=='unavailable') { waitingActors.add(actor); continue; }
        db.prepare("UPDATE incoming SET status='processing' WHERE seq=?").run(row.seq);
        return { seq: Number(row.seq), message };
      }
      return undefined;
    });
  }
  function finishIncoming(seq: number, error?: string) {
    use(db => db.prepare("UPDATE incoming SET status=?,error=? WHERE account=? AND seq=? AND status='processing'")
      .run(error ? 'failed' : 'processed', error?.slice(0, 300) ?? null, config.accountId, seq));
  }
  function storedIncoming(source: string): IncomingMessage | undefined {
    return use(db=>{const row=db.prepare('SELECT payload FROM incoming WHERE account=? AND source=?').get(config.accountId,source);
      return row?JSON.parse(String(row.payload)):undefined;});
  }
  function mediaInfo(conversationId:string,id:string) {
    return use(db=>{
      const row=db.prepare("SELECT source,payload FROM incoming WHERE account=? AND json_extract(payload,'$.chatContext.conversationId')=? AND (source=? OR json_extract(payload,'$.replyTo.sourceId')=?) ORDER BY source=? DESC LIMIT 1")
        .get(config.accountId,conversationId,id,id,id);
      if(!row)return;
      const message:IncomingMessage=JSON.parse(String(row.payload));
      const media=row.source===id?message.desktopMedia??(message.localMedia?.localPath?
        {kind:'image' as const,key:digest(id),localPath:message.localMedia.localPath,sourceId:id,status:'available' as const}:message.replyTo?.media):message.replyTo?.media;
      return {source:String(row.source),media,reference:message.replyTo};
    });
  }
  function requestMedia(conversationId:string,id:string) {
    const found=mediaInfo(conversationId,id);
    if(!found)throw Error('Media is not in this conversation');
    use(db=>db.prepare("INSERT INTO media_requests VALUES(?,?,'pending') ON CONFLICT(source) DO UPDATE SET requested=excluded.requested,status='pending'")
      .run(found.source,now()));
    return found;
  }
  function mediaRequests() { return use(db=>db.prepare("SELECT source FROM media_requests WHERE status='pending' ORDER BY requested LIMIT 4").all().map(row=>String(row.source))); }
  function finishMediaRequest(source:string) {use(db=>db.prepare("UPDATE media_requests SET status='done' WHERE source=?").run(source));}
  function enqueue(input: { peerId: string; clientId: string; kind: Kind; text?: string; file?: string;
    context: string; thread?: string; profile: ConversationProfile; mentionOnly?: boolean; mention?: {username:string;name:string}|null }): DesktopDelivery {
    requireDesktopEnabled(config); const contact = desktopContact(config, input.peerId);
    if (!input.clientId || !['text','image','video'].includes(input.kind)) throw new Error('Invalid desktop delivery');
    const mentionOnly = input.mentionOnly === true && contact.kind === 'group' && input.text === '';
    if (input.kind === 'text' && (typeof input.text !== 'string' || (!input.text.trim() && !mentionOnly) || input.text.length > 20000)) throw new Error('Expected nonempty desktop text of at most 20000 characters');
    const file = input.kind === 'text' ? undefined : readFileSync(input.file!);
    const fingerprint = digest(JSON.stringify([input.peerId, input.kind, input.text, file && digest(file)]));
    const requestedMention = contact.kind === 'group' && input.kind === 'text'
      ? input.mention === null ? undefined : input.mention ?? (contact.actorUsername
        ? { username: contact.actorUsername, name: contact.actorName ?? '' } : undefined)
      : undefined;
    return use(db => {
      const old = db.prepare('SELECT * FROM outgoing WHERE account=? AND client=?').get(config.accountId, input.clientId);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error('Delivery client ID was reused for a different recipient or content');
        const previous = decode(old);
        if (previous.mention?.username !== requestedMention?.username)
          throw new Error('Delivery client ID was reused for a different group recipient');
        if (previous.status === 'rejected' || (previous.status === 'cancelled' && previous.cancelCause !== 'superseded')) {
          requireRunning(db);
          const payload = { ...JSON.parse(String(old.payload)), mention: currentMention(contact, previous.mention),
            context: input.context, thread: input.thread, profile: input.profile, queuedAt: now(), recoveryExtended: undefined };
          db.prepare("UPDATE outgoing SET status='queued',payload=?,lease_id=NULL,lease_until=NULL,evidence=NULL,error=NULL WHERE id=?")
            .run(JSON.stringify(payload), old.id);
          return decode(db.prepare('SELECT * FROM outgoing WHERE id=?').get(old.id));
        }
        return decode(old);
      }
      requireRunning(db);
      const delivery: DesktopDelivery = { id: randomUUID(), accountId: config.accountId, peerId: input.peerId,
        uiLabel: contact.uiLabel, clientId: input.clientId, kind: input.kind, text: input.text,
        context: input.context, thread: input.thread, profile: input.profile, status: 'queued', queuedAt: now() };
      if (contact.kind === 'group' && input.kind === 'text') {
        const mention = currentMention(contact, requestedMention);
        if(mention)delivery.mention=mention;
        if(mentionOnly&&!mention)throw Error('Standalone notification needs a group member');
      }
      if (file) {
        const folder = join(config.exchangeDirectory, 'outgoing'); mkdirSync(folder, { recursive: true, mode: 0o700 });
        const name = delivery.id + extname(input.file!); delivery.filePath = join(folder, name);
        writeFileSync(delivery.filePath, file, { mode: 0o600 }); delivery.desktopPath = '/exchange/outgoing/' + name;
      }
      db.prepare("INSERT INTO outgoing(id,account,client,fingerprint,payload,status) VALUES(?,?,?,?,?,'queued')")
        .run(delivery.id, config.accountId, input.clientId, fingerprint, JSON.stringify(delivery));
      return delivery;
    });
  }
  function getDelivery(id: string) {
    return use(db => {
      const row = db.prepare('SELECT * FROM outgoing WHERE account=? AND id=?').get(config.accountId, id);
      if (!row) throw new Error('Unknown desktop delivery'); return decode(row);
    });
  }
  function claimDelivery(leaseMs = 90_000): DesktopDelivery | undefined {
    requireDesktopEnabled(config);
    return use(db => {
      if (pauseState(db) || sendHold(db) || manualControlState(config.queueDirectory).active) return undefined;
      if (db.prepare('SELECT 1 FROM ui_lease').get()) return undefined;
      while (true) {
        const row = db.prepare("SELECT * FROM outgoing WHERE account=? AND status='queued' ORDER BY rowid LIMIT 1").get(config.accountId);
        if (!row) return undefined;
        const delivery = decode(row), contact = desktopContact(config, delivery.peerId, delivery.uiLabel);
        try { delivery.mention = currentMention(contact, delivery.mention); }
        catch (error) {
          if (!(error instanceof SendRejected)) throw error;
          db.prepare("UPDATE outgoing SET status='rejected',error=? WHERE id=?").run(error.message, delivery.id);
          continue;
        }
        const payload = { ...JSON.parse(String(row.payload)), mention: delivery.mention };
        const leaseId = randomUUID(), until = now() + leaseMs;
        db.prepare("UPDATE outgoing SET status='claimed',lease_id=?,lease_until=?,payload=? WHERE id=?")
          .run(leaseId, until, JSON.stringify(payload), delivery.id);
        db.prepare('INSERT INTO ui_lease VALUES(1,?,?,?)').run(leaseId, delivery.id, until);
        return { ...delivery, status: 'claimed', leaseId, leaseUntil: until };
      }
    });
  }
  function authorizeDelivery(id: string, beforeSend?: () => void) {
    return use(db => {
      requireRunning(db);
      const row = db.prepare("SELECT * FROM outgoing WHERE account=? AND id=? AND status='claimed'").get(config.accountId, id);
      if (!row) return;
      const delivery = decode(row);
      const latest = db.prepare('SELECT MAX(seq) AS seq FROM incoming WHERE account=? AND peer=?').get(config.accountId, delivery.peerId);
      const group=desktopContact(config,delivery.peerId).kind==='group';
      const lastDirected=group?db.prepare(`SELECT MAX(seq) AS seq FROM incoming WHERE account=? AND peer=?
        AND ((? IS NOT NULL AND json_extract(payload,'$.chatContext.actorId')=?)
          OR (? IS NULL AND json_extract(payload,'$.addressed')=1))
        AND COALESCE(json_extract(payload,'$.contextOnly'),0)=0`)
        .get(config.accountId,delivery.peerId,delivery.mention?.username??null,delivery.mention?.username??null,delivery.mention?.username??null):undefined;
      const stale=delivery.profile==='companion'&&(group?Number(lastDirected?.seq??0)>Number(delivery.context.split(':')[1]??0):delivery.context!==`desktop:${latest?.seq}`);
      if (!stale) beforeSend?.();
      db.prepare('UPDATE outgoing SET status=?,error=?,payload=? WHERE id=?').run(stale ? 'cancelled' : 'ready', stale ? 'A newer incoming message superseded this companion reply' : null,
        JSON.stringify({ ...JSON.parse(String(row.payload)), ...(stale ? { cancelCause: 'superseded' } : {}) }), id);
      if (stale) db.prepare('DELETE FROM ui_lease WHERE delivery=?').run(id);
    });
  }
  function cancelUnsent(id: string, reason: string) {
    return use(db => {
      const row = db.prepare('SELECT * FROM outgoing WHERE account=? AND id=?').get(config.accountId, id);
      if (!row) throw new Error('Unknown desktop delivery');
      if (['queued', 'claimed'].includes(String(row.status))) {
        db.prepare("UPDATE outgoing SET status='cancelled',error=? WHERE id=?").run(reason.slice(0,300), id);
        db.prepare('DELETE FROM ui_lease WHERE delivery=?').run(id);
      } else if (row.status === 'ready') {
        db.prepare("UPDATE outgoing SET status='uncertain',error=? WHERE id=?").run(reason.slice(0,300), id);
        // Freeze further automatic UI work while the original result is checked.
        writeSendHold(db, reason, id);
      }
      return decode(db.prepare('SELECT * FROM outgoing WHERE id=?').get(id));
    });
  }
  function assertUiAccess(leaseId?: string) {
    use(db => {
      if (leaseId) requireRunning(db);
      const lease = db.prepare('SELECT * FROM ui_lease').get();
      if (lease && lease.id !== leaseId) throw new Error('Desktop is reserved by another conversation operation');
      if (!lease && leaseId) throw new Error('Desktop lease expired or was cancelled');
      if (lease) {
        const row = db.prepare('SELECT account,status FROM outgoing WHERE id=?').get(lease.delivery);
        if (row?.account !== config.accountId || row.status !== 'ready') throw new Error('Desktop delivery is not authorized for UI actions');
      }
    });
  }
  function receipt(input: VisibleReceipt, reconcile = false) {
    requireDesktopEnabled(config);
    return use(db => {
      const row = db.prepare('SELECT * FROM outgoing WHERE account=? AND id=?').get(config.accountId, input.id);
      if (!row) throw new Error('Unknown desktop delivery');
      if (row.status === 'sent' && row.lease_id === input.leaseId && input.status === 'sent') return decode(row);
      const delivery = decode(row), lease = db.prepare('SELECT * FROM ui_lease WHERE id=? AND delivery=?').get(input.leaseId, input.id);
      desktopContact(config, delivery.peerId, input.uiLabel);
      if (!['sent','rejected','uncertain'].includes(input.status)) throw new Error('Invalid desktop receipt status');
      if (input.status !== 'sent' && !input.error?.trim()) throw new Error('Describe the actual failure or uncertain outcome');
      // A recovery can finish after expiry/pause already finalized this lease.
      // Preserve that outcome; never downgrade uncertainty or touch a new lease.
      if (input.status !== 'sent' && row.lease_id === input.leaseId
        && ['sent','rejected','uncertain','cancelled'].includes(delivery.status)) return delivery;
      const recovery = reconcile && !!config.database && input.status === 'sent' && !!input.leaseId
        && row.lease_id === input.leaseId && delivery.status === 'uncertain';
      if (reconcile && !recovery) throw new Error('Recovery requires an uncertain database delivery and its original lease');
      if (!recovery && (!lease || delivery.status !== 'ready')) throw new Error('Receipt does not match an active authorized delivery');
      let evidence;
      if (input.status === 'sent') {
        if (config.database) {
          if (!input.database) throw new Error('Database mode requires a verified new outgoing message');
          validateDatabaseProof(config, input.database, 'out',delivery.peerId);
          if(delivery.kind==='text'&&desktopContact(config,delivery.peerId).kind==='group'
            && (delivery.mention ? input.database.atUsernames?.length!==1||input.database.atUsernames[0]!==delivery.mention.username : !!input.database.atUsernames?.length))throw Error('Database proof does not match the requested group recipient');
          if (input.database.createdAt < Math.floor((delivery.queuedAt ?? now())/1000)*1000
            || db.prepare("SELECT 1 FROM outgoing WHERE account=? AND id<>? AND json_extract(evidence,'$.database.serverId')=?")
              .get(config.accountId,delivery.id,input.database.serverId)) throw new Error('Outgoing database record is old or already acknowledged');
          const member=delivery.mention&&desktopContact(config,delivery.peerId).members?.find(m=>m.username===delivery.mention!.username);
          const mentionNames=member?.mentionNames?.length?member.mentionNames:delivery.mention?.name;
          if (delivery.kind === 'text' ? ![1,2].includes(input.database.messageType) || !outgoingTextMatches(input.database.text, delivery.text!, mentionNames)
            : input.database.fileMd5 !== digestMd5(readFileSync(delivery.filePath!))) {
            throw new Error('Outgoing database content does not match the queued reply');
          }
          // The new outgoing database row is the success evidence. Capturing
          // and archiving another screenshot does not strengthen that match.
          evidence = { observedAt: now(), database: input.database };
        } else {
          if (delivery.kind === 'text' ? input.observedText !== delivery.text : input.attachmentVisible !== true) throw new Error('The actual sent bubble must match the intended content');
          if (!input.screenshotPath) throw new Error('A visible sent bubble screenshot is required');
          screenshotBytes(input.screenshotPath);
          // Legacy visual operators may inspect a live screenshot, but normal
          // successful sends no longer archive a copy of it.
          evidence = { observedAt: now() };
        }
      }
      db.prepare('UPDATE outgoing SET status=?,evidence=?,error=? WHERE id=?')
        .run(input.status, evidence ? JSON.stringify(evidence) : null, input.error?.slice(0,300) ?? null, input.id);
      db.prepare('DELETE FROM ui_lease WHERE delivery=?').run(input.id);
      if (input.status === 'uncertain') writeSendHold(db, input.error!, input.id);
      const hold = sendHold(db);
      if (recovery && hold?.deliveryId === input.id) {
        db.prepare('DELETE FROM send_hold WHERE account=?').run(config.accountId);
      }
      return decode(db.prepare('SELECT * FROM outgoing WHERE id=?').get(input.id));
    });
  }
  function activeDelivery(leaseId: string) {
    return use(db => {
      requireRunning(db);
      const row = db.prepare(`SELECT outgoing.* FROM outgoing JOIN ui_lease ON outgoing.id=ui_lease.delivery
        WHERE ui_lease.id=? AND outgoing.account=? AND outgoing.status='ready'`).get(leaseId, config.accountId);
      if (!row) throw new Error('No authorized desktop delivery for this lease');
      return decode(row);
    });
  }
  function extendDelivery(leaseId:string) {
    return use(db=>{
      requireRunning(db);
      const lease=db.prepare('SELECT delivery FROM ui_lease WHERE id=?').get(leaseId);
      const row=lease&&db.prepare("SELECT * FROM outgoing WHERE id=? AND account=? AND status='ready'").get(lease.delivery,config.accountId);
      if(!row)throw Error('Recovery requires the active delivery lease');
      const payload=JSON.parse(String(row.payload));
      if(payload.recoveryExtended)return decode(row);
      // Four bounded 120-second visual checks plus UI/receipt time. This is
      // granted once per authorized attempt, never renewed by polling.
      const until=Math.max(Number(row.lease_until),now()+600_000);
      db.prepare('UPDATE ui_lease SET expires=? WHERE id=?').run(until,leaseId);
      db.prepare('UPDATE outgoing SET lease_until=?,payload=? WHERE id=?').run(until,JSON.stringify({...payload,recoveryExtended:true}),row.id);
      return decode(db.prepare('SELECT * FROM outgoing WHERE id=?').get(row.id));
    });
  }
  function observation() {
    return use(db => {
      const row = db.prepare('SELECT payload FROM observations WHERE account=?').get(config.accountId);
      return row ? JSON.parse(String(row.payload)) : undefined;
    });
  }
  function observe(input: DesktopObservation) {
    requireDesktopEnabled(config); desktopContact(config, config.ownerPeerId, input.uiLabel);
    if (!input.atBottom || !Array.isArray(input.messages) || input.messages.length > 80) throw new Error('Observe the latest visible conversation, at the bottom');
    const messages = input.messages.map(message => {
      if (!message || !['in','out'].includes(message.direction) || !['text','image','audio','video'].includes(message.kind)
        || typeof message.text !== 'string' || (message.kind === 'text' && !message.text.trim())
        || (message.kind !== 'text' && !message.visualKey?.trim())) throw new Error('Invalid visible message');
      return { ...message, fingerprint: digest(JSON.stringify([message.direction,message.kind,message.text.trim(),message.kind === 'text' ? '' : message.visualKey])) };
    });
    return use(db => {
      requireRunning(db);
      const row = db.prepare('SELECT payload FROM observations WHERE account=?').get(config.accountId);
      const old = row ? JSON.parse(String(row.payload)) as { messages: (VisibleBubble & { id: string; fingerprint: string })[] } : undefined;
      let overlap = 0;
      if (old?.messages.length) {
        for (let count = Math.min(old.messages.length,messages.length); count > 0; count--) {
          if (messages.slice(0,count).every((message,index) => message.fingerprint === old.messages[old.messages.length-count+index].fingerprint)) { overlap = count; break; }
        }
        if (!overlap) throw new Error('Visible history no longer overlaps the checkpoint; pause for manual review instead of replaying it');
      }
      const current = messages.map((message,index) => ({ ...message,
        id: old && index < overlap ? old.messages[old.messages.length-overlap+index].id : randomUUID() }));
      const evidence = saveEvidence(input.screenshotPath);
      const forwarded: number[] = [];
      // First observation is a baseline, not permission to answer old history.
      if (old) for (const message of current.slice(overlap)) if (message.direction === 'in') {
        if (message.kind !== 'text' && !message.attachmentPath) throw new Error('Save the actual incoming attachment through the UI before forwarding it');
        const result = incomingWithDb({ peerId: config.ownerPeerId, uiLabel: input.uiLabel, sourceMessageId: message.id,
          text: message.text, screenshotPath: input.screenshotPath,
          ...(message.kind === 'text' ? {} : { attachment: { kind: message.kind, path: message.attachmentPath! } }) },db);
        if (!result.duplicate) forwarded.push(result.seq);
      }
      const checkpoint = { at: now(), uiLabel: input.uiLabel, messages: current, evidence };
      db.prepare('INSERT OR REPLACE INTO observations VALUES(?,?)').run(config.accountId,JSON.stringify(checkpoint));
      return { baseline: !old, forwarded, checkpoint };
    });
  }
  function pause(reason: string, screenshotPath: string | undefined, kind: 'security' | 'logout' | 'ambiguous' | 'failure' = 'failure') {
    if (typeof reason !== 'string' || !reason.trim() || !['security','logout','ambiguous','failure'].includes(kind)) throw new Error('Describe the actual desktop alert');
    return use(db => {
      const previous = pauseState(db);
      if (previous) return previous;
      const evidence = screenshotPath ? saveEvidence(screenshotPath) : { observedAt: now(), screenshotUnavailable: true };
      const alert = { reason: reason.slice(0,500), kind, ...evidence };
      db.prepare('INSERT OR REPLACE INTO channel_pause VALUES(?,?)').run(config.accountId,JSON.stringify(alert));
      db.prepare(`UPDATE outgoing SET status=CASE WHEN status='ready' THEN 'uncertain' ELSE 'cancelled' END,error=?
        WHERE account=? AND status IN ('queued','claimed','ready')`).run('Desktop paused: '+alert.reason,config.accountId);
      db.prepare('DELETE FROM ui_lease WHERE delivery IN (SELECT id FROM outgoing WHERE account=?)').run(config.accountId);
      return alert;
    });
  }
  function writeSendHold(db: DatabaseSync, reason: string, deliveryId?: string, screenshotPath?: string) {
    const previous = sendHold(db);
    if (previous) return previous;
    const evidence = screenshotPath ? saveEvidence(screenshotPath) : { observedAt: now() };
    const hold = { kind: 'failure', reason: reason.slice(0,500), deliveryId, ...evidence };
    db.prepare('INSERT INTO send_hold VALUES(?,?)').run(config.accountId, JSON.stringify(hold));
    db.prepare(`UPDATE outgoing SET status=CASE WHEN status='ready' THEN 'uncertain' ELSE 'cancelled' END,error=?
      WHERE account=? AND status IN ('queued','claimed','ready')`).run('Sending paused: '+hold.reason,config.accountId);
    db.prepare('DELETE FROM ui_lease WHERE delivery IN (SELECT id FROM outgoing WHERE account=?)').run(config.accountId);
    return hold;
  }
  function holdSending(reason: string, deliveryId?: string, screenshotPath?: string) {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('Describe the technical sending failure');
    return use(db => {
      if (deliveryId) {
        const row = db.prepare('SELECT status FROM outgoing WHERE account=? AND id=?').get(config.accountId, deliveryId);
        if (!row || !['ready','uncertain'].includes(String(row.status))) throw new Error('Sending hold requires an attempted or uncertain delivery');
      }
      return writeSendHold(db,reason,deliveryId,screenshotPath);
    });
  }
  function pendingReconciliation() {
    return use(db => config.database ? db.prepare("SELECT * FROM outgoing WHERE account=? AND status='uncertain' ORDER BY rowid")
      .all(config.accountId).map(decode) : []);
  }
  function reconcileReceipt(input: VisibleReceipt) { return receipt(input, true); }
  // Only the local manual activation command exposes this; the GUI operator
  // cannot clear a security/logout latch or click through a login challenge.
  function resume() { requireDesktopEnabled(config); return use(db => {
    db.prepare('DELETE FROM send_hold WHERE account=?').run(config.accountId);
    return db.prepare('DELETE FROM channel_pause WHERE account=?').run(config.accountId);
  }); }
  function status() {
    return use(db => ({ enabled: config.enabled, accountId: config.accountId, ownerBound: !!config.ownerPeerId,
      exchangeDirectory: config.exchangeDirectory,
      paused: !!(pauseState(db) || sendHold(db)) || manualControlState(config.queueDirectory).active, alert: pauseState(db) ?? sendHold(db),
      manualControl:manualControlState(config.queueDirectory),
      receivePaused: !!pauseState(db), sendPaused: !!(pauseState(db) || sendHold(db)) || manualControlState(config.queueDirectory).active, sendHold: sendHold(db),
      contactScope: config.multiUser?'identified-chats':'owner-only', contacts: config.contacts,
      incoming: db.prepare('SELECT status,COUNT(*) AS count FROM incoming WHERE account=? GROUP BY status').all(config.accountId),
      outgoing: db.prepare('SELECT status,COUNT(*) AS count FROM outgoing WHERE account=? GROUP BY status').all(config.accountId),
      uiBusy: !!db.prepare('SELECT 1 FROM ui_lease').get() }));
  }
  const incomingBatch=(messages:VisibleIncoming[])=>use(db=>{requireReceiving(db);return messages.map(input=>incomingWithDb(input,db));});
  return { path, incomingBatch, incoming, takeIncoming, finishIncoming, storedIncoming, mediaInfo, requestMedia, mediaRequests, finishMediaRequest, enqueue, getDelivery, claimDelivery, authorizeDelivery, cancelUnsent,
    assertUiAccess, activeDelivery, extendDelivery, receipt, reconcileReceipt, pendingReconciliation, holdSending, observation, observe, pause, resume, status };
}
