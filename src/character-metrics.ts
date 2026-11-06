import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './constants.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n * 100) / 100;
const date = (at: number) => new Date(at + 8 * HOUR).toISOString().slice(0, 10);
const random = (key: string) => parseInt(createHash('sha256').update(key).digest('hex').slice(0, 8), 16) / 0x100000000;
export const METRIC_DEFAULTS = { initialCash: 6000, monthlyIncome: 6000, rent: 1500, utilities: 200,
  savingsPerMonth: 1200, savingsGoal: 30000, emergencyReserve: 300, dailyFood: 45, dailyTransport: 6 };
export type MetricConfig = typeof METRIC_DEFAULTS;
export interface MetricActivity { text: string; until: number; since?: number; source?: string;
  energyMode?: 'rest' | 'work' | 'commute' | 'leisure' }
export interface Vitals { at: number; energy: number; mood: number; moodKind: string; moodReason: string;
  lastWakeDay: string; cash: number; savings: number; initializedAt: number; activity?: MetricActivity; awakeUntil?: number }
export interface SocialDecision { intent: 'chat' | 'joke' | 'vent' | 'help' | 'conflict' | 'closing';
  effect: 'none' | 'bonding' | 'important' | 'disrespect' | 'harassment' | 'repair';
  mode: 'reply' | 'quiet' | 'pause'; userQuote: string; minutes?: number;
  repair?: 'attempt' | 'completed'; replyQuote?: string }
interface ConflictResidue { sourceId: string; cause: string; severity: 'disrespect' | 'harassment';
  startedAt: number; sourceAt?: number; at: number; intensity: number; halfLifeHours: number; repetitions: number;
  apologyAt?: number; lastSupportAt?: number }
interface RelationshipNumber { affection: number; at: number; cooling: boolean; pauseUntil: number;
  lastPositiveDay?: string; dailyGain: number; lastEffect?: string; conflict?: ConflictResidue }
export function validSocialDecision(v: any): v is SocialDecision {
  return !!v && ['chat','joke','vent','help','conflict','closing'].includes(v.intent)
    && ['none','bonding','important','disrespect','harassment','repair'].includes(v.effect)
    && ['reply','quiet','pause'].includes(v.mode) && typeof v.userQuote === 'string' && !!v.userQuote.trim() && v.userQuote.length <= 400
    && (v.minutes === undefined || Number.isFinite(v.minutes) && v.minutes >= 1 && v.minutes <= 120)
    && (v.repair === undefined || v.effect === 'repair' && ['attempt','completed'].includes(v.repair))
    && (v.replyQuote === undefined || typeof v.replyQuote === 'string' && !!v.replyQuote.trim() && v.replyQuote.length <= 400)
    && (v.repair !== 'completed' || typeof v.replyQuote === 'string' && !!v.replyQuote.trim())
    && !(v.intent === 'joke' && ['disrespect','harassment'].includes(v.effect));
}

// One world ledger, keyed relationship rows. No model/network call, no per-tick
// random rewards; all clocks use Beijing time and all applied events are unique.
export function createCharacterMetrics(directory = join(DATA_DIR, 'character-life'), config?: Partial<MetricConfig>) {
  let disk = {};
  try { disk = JSON.parse(readFileSync(join(directory, 'metrics-config.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Invalid character metrics configuration'); }
  const settings = { ...METRIC_DEFAULTS, ...disk, ...config };
  for (const key of Object.keys(METRIC_DEFAULTS) as (keyof MetricConfig)[]) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1000000) throw new Error('Invalid character budget');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'metrics.sqlite3');
  function use<T>(fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(path);
    try {
      db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS world(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, at INTEGER NOT NULL, category TEXT NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS social_events(id TEXT PRIMARY KEY, peer TEXT NOT NULL, at INTEGER NOT NULL, value TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS social_events_peer_at ON social_events(peer,at);
        BEGIN IMMEDIATE;`);
      const value = fn(db); db.exec('COMMIT'); return value;
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } finally { db.close(); }
  }
  function save(db: DatabaseSync, s: Vitals) { db.prepare('INSERT OR REPLACE INTO world VALUES(1,?)').run(JSON.stringify(s)); }
  function advance(db: DatabaseSync, now: number, activity?: MetricActivity): Vitals {
    const row = db.prepare('SELECT value FROM world WHERE id=1').get();
    const s: Vitals = row ? JSON.parse(String(row.value)) : { at: now, initializedAt: now, energy: 70, mood: 0,
      moodKind: '平静', moodReason: '', lastWakeDay: date(now), cash: settings.initialCash, savings: 0 };
    if (!row) db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?)').run('opening', now, 'initial', settings.initialCash, '试运行初始余额，可配置；模拟资金');
    // Settle the preceding interval using the activity known then. A new scene
    // must not retroactively turn the last hour into sleep or rest.
    const previousActivity = s.activity;
    if (now <= s.at) { if(activity && now === s.at)s.activity={...activity,since:activity.since??now};save(db,s); return s; }
    const post = (id: string, at: number, category: string, amount: number, reason: string) => {
      if (db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?)').run(id, at, category, amount, reason).changes) s.cash = round(s.cash + amount);
    };
    // Integrate over wall-clock hours, including sleep boundaries. Polling more
    // often cannot earn extra recovery, income or change the daily wake sample.
    for (let at = s.at; at < now;) {
      const next = Math.min(now, (Math.floor(at / HOUR) + 1) * HOUR,
        previousActivity && previousActivity.until>at ? previousActivity.until : Infinity,
        previousActivity?.since && previousActivity.since>at ? previousActivity.since : Infinity,
        s.awakeUntil && s.awakeUntil>at ? s.awakeUntil : Infinity);
      const local = new Date(at + 8 * HOUR), hour = local.getUTCHours();
      const active = previousActivity && at >= (previousActivity.since ?? 0) && at < previousActivity.until ? previousActivity : undefined;
      const awake = at < (s.awakeUntil ?? 0) || (active && active.source !== 'simulated_routine');
      const weekday = local.getUTCDay(), asleep = (hour < 8 || hour >= 23) && !awake;
      const resting = !asleep && active && active.source !== 'simulated_routine'
        && (active.energyMode ? active.energyMode === 'rest' : /休息|躺|小睡/.test(active.text));
      const working = active?.energyMode ? active.energyMode === 'work'
        : weekday >= 1 && weekday <= 5 && ((hour >= 10 && hour < 12) || (hour >= 13 && hour < 18));
      const rate = asleep ? 10 : resting ? 8 : working ? -5 : -3;
      s.energy = clamp(s.energy + rate * (next-at)/HOUR, -30, 100);
      s.mood *= Math.pow(0.5, (next-at)/(3*HOUR));
      const boundary = new Date(next + 8 * HOUR), day = date(next), h = boundary.getUTCHours();
      if (next % HOUR === 0) {
        if (h === 0 && boundary.getUTCDate() === 1) {
          post(`salary:${day}`, next, 'salary', settings.monthlyIncome, '月薪');
          post(`rent:${day}`, next, 'rent', -settings.rent, '合租房租（试运行配置）');
          post(`utilities:${day}`, next, 'utilities', -settings.utilities, '水电（试运行配置）');
          const saving = Math.max(0, Math.min(settings.savingsPerMonth, s.cash-settings.emergencyReserve));
          if (db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?)').run(`saving:${day}`,next,'saving',-saving,'转入开店储蓄').changes) {
            s.cash=round(s.cash-saving);s.savings=round(s.savings+saving);
          }
        }
        if (h === 8 && asleep && s.lastWakeDay !== day) { s.mood=Math.floor(random(`wake:${day}`)*21)-10; s.moodKind='平静';s.moodReason='睡眠后的自然状态';s.lastWakeDay=day; }
        if ([8,13,20].includes(h)) post(`food:${day}:${h}`,next,'food',-round(settings.dailyFood * (h===8?0.2:0.4)),'日常餐饮预算结算；单次吃饭不重复扣费');
        if (h===18 && boundary.getUTCDay()>=1 && boundary.getUTCDay()<=5) post(`transport:${day}`,next,'transport',-settings.dailyTransport,'日常通勤');
      }
      at=next;
    }
    s.at=now; if(activity)s.activity={...activity,since:activity.since??now};save(db,s);return s;
  }
  function finance(s: Vitals, now: number) {
    const local = new Date(now+8*HOUR), nextPay=Date.UTC(local.getUTCFullYear(),local.getUTCMonth()+1,1)-8*HOUR;
    const remainingDays=Math.ceil((nextPay-now)/DAY);
    const reserved=remainingDays*(settings.dailyFood+settings.dailyTransport)+settings.emergencyReserve;
    return { cash:s.cash, savings:s.savings, savingsGoal:settings.savingsGoal, reserved, spendable:round(Math.max(0,s.cash-reserved)),
      monthlyIncome:settings.monthlyIncome, currency:'CNY', simulated:true };
  }
  function peer(db: DatabaseSync, id: string, now: number): RelationshipNumber {
    const row=db.prepare('SELECT value FROM peers WHERE id=?').get(id);
    const r:RelationshipNumber=row?JSON.parse(String(row.value)):{affection:0,at:now,cooling:false,pauseUntil:0,dailyGain:0};
    const days=Math.max(0,now-r.at)/DAY;
    if(r.affection>80)r.affection=Math.max(80,r.affection-0.3*days);
    if(r.cooling&&r.affection<0)r.affection=Math.min(0,r.affection+0.75*days);
    if(r.affection>=0)r.cooling=false;
    if(r.conflict){
      const conflict=r.conflict;
      conflict.intensity *= Math.pow(0.5, Math.max(0,now-conflict.at)/(conflict.halfLifeHours*HOUR));
      conflict.at=Math.max(now,conflict.at);
      if(conflict.intensity<2)delete r.conflict;
    }
    r.at=Math.max(now,r.at);
    if(r.lastPositiveDay!==date(now)) {r.dailyGain=0;r.lastPositiveDay=date(now);}
    db.prepare('INSERT OR REPLACE INTO peers VALUES(?,?)').run(id,JSON.stringify(r));return r;
  }
  function describe(s: Vitals, r: RelationshipNumber | undefined, now: number) {
      return { energy:round(s.energy), energyState:s.energy>80?'精神充足':s.energy< -10?'停止消耗、需要恢复':s.energy<20?'疲惫':'正常',
        mood:{value:round(s.mood),kind:Math.abs(s.mood)<3?'平静':s.moodKind,reason:Math.abs(s.mood)<3?'':s.moodReason},finance:finance(s,now),
        ...(r?{relationship:{affection:round(r.affection),pausedUntil:r.pauseUntil,
          closeness:r.affection>100?'深厚':r.affection>80?'亲近':r.affection>50?'熟悉':r.affection>20?'聊得来':r.affection>=0?'初识或普通':'疏远',
          ...(r.conflict?{conflict:{...r.conflict,intensity:round(r.conflict.intensity),
            phase:r.conflict.apologyAt===undefined?'unresolved':'settling'}}:{})}}:{}),
        at:now,timezone:'Asia/Shanghai' };
  }
  function snapshot(peerId?: string, now=Date.now(), activity?: MetricActivity) {
    return use(db=>{
      const s=advance(db,now,activity), r=peerId?peer(db,peerId,now):undefined;
      return describe(s, r, now);
    });
  }
  // Observability must not advance time, settle money, decay affection or
  // create a missing peer. Read exactly the values already held by the world.
  function inspect(peerId?: string) {
    if (!existsSync(path)) return;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN');
      const row = db.prepare('SELECT value FROM world WHERE id=1').get();
      if (!row) return;
      const s: Vitals = JSON.parse(String(row.value));
      const relationship = peerId ? db.prepare('SELECT value FROM peers WHERE id=?').get(peerId) : undefined;
      return describe(s, relationship ? JSON.parse(String(relationship.value)) : undefined, s.at);
    } finally { db.close(); }
  }
  function observe(peerId:string, sourceId:string, text:string, decision:SocialDecision, now=Date.now(), deliveredReply='') {
    if(!validSocialDecision(decision)||!text.includes(decision.userQuote))throw Error('Social change requires actual input evidence');
    // A partially sent reply may omit the acceptance bubble. Preserve the real
    // apology as an attempt without committing an unreceived closure or blocking other state.
    if(decision.repair==='completed'&&!deliveredReply.includes(decision.replyQuote!))
      decision={...decision,repair:'attempt',replyQuote:undefined};
    return use(db=>{
      const s=advance(db,now),r=peer(db,peerId,now),id=`${peerId}:${sourceId}`;
      if(!db.prepare('INSERT OR IGNORE INTO social_events VALUES(?,?,?,?)').run(id,peerId,now,JSON.stringify(decision)).changes)return false;
      const repeats=Number(db.prepare('SELECT COUNT(*) n FROM social_events WHERE peer=? AND json_extract(value,\'$.userQuote\')=?').get(peerId,decision.userQuote)?.n??0)>1;
      // An apology acknowledges an incident. Closure also needs spoken acceptance
      // after the residual reaction has had time to settle; it never opens media boundaries.
      let completedRepair=false;
      if(decision.effect==='disrespect'||decision.effect==='harassment'){
        const previous=r.conflict,repetitions=(previous?.repetitions??0)+1;
        const trustPace=r.affection>80?0.9:r.affection>20?1:1.2;
        const severity=previous?.severity==='harassment'?'harassment':decision.effect;
        r.conflict={sourceId,cause:decision.userQuote,severity,
          startedAt:previous?.startedAt??now,sourceAt:now,at:now,repetitions,
          intensity:clamp((previous?.intensity??0)+(decision.effect==='harassment'?50:24),0,100),
          halfLifeHours:(severity==='harassment'?3:0.75)
            *trustPace*(1+Math.min(repetitions-1,3)*0.5)};
      }else if(decision.effect==='repair'&&r.conflict){
        if(decision.repair==='completed'&&r.conflict.intensity<=12){completedRepair=true;delete r.conflict;}
        else if(r.conflict.apologyAt===undefined){r.conflict.apologyAt=now;r.conflict.intensity*=0.9;}
      }else if(!repeats&&r.conflict?.apologyAt!==undefined&&['bonding','important'].includes(decision.effect)){
        // Count observed follow-through over real elapsed time, never message volume.
        const conflict=r.conflict;
        if(now-(conflict.lastSupportAt??conflict.apologyAt!)>=HOUR){
          conflict.intensity=Math.max(2,conflict.intensity-(decision.effect==='important'?6:3));
          conflict.lastSupportAt=now;
        }
      }
      const amount={none:0,bonding:0.5,important:4,disrespect:-1,harassment:-4,repair:completedRepair?2:0}[decision.effect];
      // Long-term trust changes more slowly than anger. Bound damage across a
      // burst of messages, using persisted applied deltas rather than turn count.
      const recentLoss=Number(db.prepare(`SELECT COALESCE(SUM(-json_extract(value,'$.affectionDelta')),0) n
        FROM social_events WHERE peer=? AND at>? AND at<=? AND json_extract(value,'$.affectionDelta')<0`)
        .get(peerId,now-2*HOUR,now)?.n??0);
      // Repeating identical positive words cannot farm familiarity across days.
      let delta=amount>0?Math.min(amount*(r.affection>80?0.5:1),Math.max(0,5-r.dailyGain))
        : Math.max(amount,-Math.max(0,6-recentLoss));
      if(repeats&&delta>0)delta=0;
      r.affection=clamp(r.affection+delta,-30,120);if(delta>0)r.dailyGain+=delta;
      db.prepare('UPDATE social_events SET value=? WHERE id=?').run(JSON.stringify({...decision,affectionDelta:delta}),id);
      if(r.affection<0)r.cooling=true;r.lastEffect=decision.effect;
      if(decision.mode==='pause')r.pauseUntil=now+clamp(decision.minutes??15,1,120)*60000;
      const mood={none:0,bonding:2,important:10,disrespect:-8,harassment:-20,repair:completedRepair?3:0}[decision.effect];
      if(mood){s.mood=clamp(s.mood+mood,-100,100);s.moodKind=s.mood< -3?'烦躁':s.mood>3?'放松或愉快':'平静';
        s.moodReason=mood<0?'刚才的相处有些不愉快':s.mood< -3?'相处有所缓和，整体仍有些烦躁':'刚才的相处让心情缓和';}
      db.prepare('INSERT OR REPLACE INTO peers VALUES(?,?)').run(peerId,JSON.stringify(r));save(db,s);return true;
    });
  }
  function spend(id:string,amount:number,category:string,reason:string,now=Date.now()) {
    if(!Number.isFinite(amount)||amount<=0||amount>100000||!id||reason.length>200)throw Error('Invalid simulated purchase');
    return use(db=>{
      const s=advance(db,now);
      if(db.prepare('SELECT id FROM ledger WHERE id=?').get(id))return true;
      if(amount>finance(s,now).spendable)return false;
      db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?)').run(id,now,category,-round(amount),reason);
      s.cash=round(s.cash-amount);save(db,s);return true;
    });
  }
  function exert(id:string,energy:number,reason:string,now=Date.now(),mood=0) {
    if(!Number.isFinite(energy)||Math.abs(energy)>30||!Number.isFinite(mood)||Math.abs(mood)>15)throw Error('Invalid activity adjustment');
    return use(db=>{const s=advance(db,now);if(db.prepare('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?)').run(`energy:${id}`,now,'activity',0,reason).changes){
      s.energy=clamp(s.energy+energy,-30,100);
      if(mood){s.mood=clamp(s.mood+mood,-100,100);s.moodKind=s.mood< -3?'烦躁':s.mood>3?'放松或愉快':'平静';s.moodReason=reason;}
      save(db,s);
    }});
  }
  function markAwake(until: number, now = Date.now()) {
    use(db => { const s = advance(db, now); s.awakeUntil = Math.max(s.awakeUntil ?? 0, until); save(db, s); });
  }
  function linkPeer(target:string,sources:string[]) {
    return use(db=>{
      let seeded=false;
      for(const source of sources) {
        if(!db.prepare('SELECT 1 FROM peers WHERE id=?').get(target)) {
          const row=db.prepare('SELECT value FROM peers WHERE id=?').get(source);
          if(row){db.prepare('INSERT INTO peers VALUES(?,?)').run(target,String(row.value));seeded=true;}
        }
        for(const event of db.prepare('SELECT id,at,value FROM social_events WHERE peer=?').all(source)) {
          const id=target+':'+String(event.id).slice(source.length+1);
          db.prepare('INSERT OR IGNORE INTO social_events VALUES(?,?,?,?)').run(id,target,event.at,event.value);
        }
      }
      return seeded;
    });
  }
  return {snapshot,inspect,observe,spend,exert,markAwake,linkPeer,settings,ledger:()=>use(db=>db.prepare('SELECT * FROM ledger ORDER BY at,id').all())};
}
