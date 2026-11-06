import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createCharacterMetrics,validSocialDecision,type SocialDecision} from '../src/character-metrics.js';
const now=Date.parse('2026-10-30T09:00:00+08:00');
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'metrics-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return createCharacterMetrics(dir);}
function closePeer(t:any,affection=120){
 const dir=mkdtempSync(join(tmpdir(),'conflict-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const metrics=createCharacterMetrics(dir);metrics.snapshot('p',now);
 const db=new DatabaseSync(join(dir,'metrics.sqlite3'));
 const row=JSON.parse(String(db.prepare('SELECT value FROM peers WHERE id=?').get('p')!.value));
 db.prepare('UPDATE peers SET value=? WHERE id=?').run(JSON.stringify({...row,affection}),'p');db.close();
 return {metrics,dir};
}
const coercion:SocialDecision={intent:'conflict',effect:'harassment',mode:'reply',userQuote:'我不管你愿不愿意 必须发'};
const apology:SocialDecision={intent:'conflict',effect:'repair',mode:'reply',repair:'attempt',userQuote:'抱歉 不催了'};

test('inspection neither advances the world nor creates or decays relationships', t => {
 const {metrics:m,dir}=closePeer(t,120);
 const db=new DatabaseSync(join(dir,'metrics.sqlite3'));
 const read=()=>({world:db.prepare('SELECT * FROM world').all(),peers:db.prepare('SELECT * FROM peers').all(),ledger:db.prepare('SELECT * FROM ledger').all()});
 const before=read();
 assert.equal(m.inspect('p')!.relationship!.affection,120);
 assert.equal(m.inspect('missing')!.relationship,undefined);
 assert.deepEqual(read(),before);
 db.close();
});

test('high affinity keeps familiarity while an apology acknowledges rather than erases the incident',t=>{
 const {metrics:m}=closePeer(t);
 m.observe('p','pressure',coercion.userQuote,coercion,now);
 const hurt=m.snapshot('p',now);assert.equal(hurt.relationship!.affection,116);assert.equal(hurt.relationship!.closeness,'深厚');
 assert.equal(hurt.relationship!.conflict!.phase,'unresolved');
 m.observe('p','apology',apology.userQuote,apology,now);
 const acknowledged=m.snapshot('p',now);
 assert.equal(acknowledged.relationship!.affection,116);assert.equal(acknowledged.mood.value,hurt.mood.value);
 assert.equal(acknowledged.mood.kind,'烦躁');assert.equal(acknowledged.relationship!.conflict!.phase,'settling');
 assert.ok(acknowledged.relationship!.conflict!.intensity>hurt.relationship!.conflict!.intensity/2);
 for(let i=0;i<20;i++)m.observe('p','repeat-apology-'+i,'抱歉'+i,{...apology,userQuote:'抱歉'+i},now);
 assert.deepEqual(m.snapshot('p',now),acknowledged,'varying repeated apologies cannot farm score or immediate relief');
 m.exert('happy-life',0,'自己听歌很开心',now,15);
 assert.deepEqual(m.snapshot('p',now).relationship,acknowledged.relationship,'general mood does not clear this peer incident');
 assert.equal(m.snapshot('other',now).relationship!.conflict,undefined);
 assert.equal(JSON.stringify(m.snapshot('other',now)).includes(coercion.userQuote),false);
});

test('conflict decays by elapsed time independently of polling and survives reopening the store',t=>{
 const a=closePeer(t),b=closePeer(t);
 for(const {metrics:m}of[a,b])m.observe('p','pressure',coercion.userQuote,coercion,now);
 const end=now+3*3600000;
 for(let at=now+30000;at<end;at+=30000)b.metrics.snapshot('p',at);
 assert.deepEqual(a.metrics.snapshot('p',end),b.metrics.snapshot('p',end));
 assert.deepEqual(createCharacterMetrics(a.dir).snapshot('p',end),a.metrics.snapshot('p',end));
 assert.ok(a.metrics.snapshot('p',end).relationship!.conflict!.intensity<50);
 assert.equal(a.metrics.snapshot('p',now+2*86400000).relationship!.conflict,undefined,'ordinary residual anger can eventually settle without forced apology');
});

test('new pressure after an apology escalates the incident while ordinary refusal creates no damage',t=>{
 const {metrics:m}=closePeer(t);
 m.observe('p','request','发张自拍',{intent:'chat',effect:'none',mode:'reply',userQuote:'发张自拍'},now);
 assert.equal(m.snapshot('p',now).relationship!.conflict,undefined);
 assert.equal(m.snapshot('p',now).relationship!.affection,120);
 m.observe('p','pressure',coercion.userQuote,coercion,now);
 m.observe('p','apology',apology.userQuote,apology,now);
 const before=m.snapshot('p',now).relationship!.conflict!;
 m.observe('p','again',coercion.userQuote,coercion,now);
 const after=m.snapshot('p',now).relationship!.conflict!;
 assert.ok(after.intensity>before.intensity);assert.ok(after.halfLifeHours>before.halfLifeHours);
 assert.equal(after.apologyAt,undefined);assert.equal(after.phase,'unresolved');
 assert.equal(m.observe('p','again',coercion.userQuote,coercion,now),false,'receipt replay cannot apply the same injury twice');
});

test('completed repair needs a delivered acceptance and enough elapsed settling; it gives no repeated rewards',t=>{
 const {metrics:m}=closePeer(t);m.observe('p','pressure',coercion.userQuote,coercion,now);
 const done:SocialDecision={...apology,repair:'completed',replyQuote:'好了 这事说开了'};
 assert.equal(m.observe('p','undelivered',done.userQuote,done,now),true);
 assert.ok(m.snapshot('p',now).relationship!.conflict,'a missing acceptance bubble records only the actual apology, never closure');
 assert.equal(m.snapshot('p',now).relationship!.affection,116);
 m.observe('p','premature',done.userQuote,done,now,done.replyQuote);
 assert.ok(m.snapshot('p',now).relationship!.conflict,'an immediate closure label cannot zero strong residual anger');
 assert.equal(m.snapshot('p',now).relationship!.affection,116);
 const later=now+6*3600000;
 m.observe('p','settled',done.userQuote,done,later,done.replyQuote);
 assert.equal(m.snapshot('p',later).relationship!.conflict,undefined);
 const healed=m.snapshot('p',later).relationship!.affection;
 m.observe('p','another','另一句道歉',{...done,userQuote:'另一句道歉'},later,done.replyQuote);
 assert.equal(m.snapshot('p',later).relationship!.affection,healed);
});

test('affinity affects recovery pace but never exempts explicit coercion, and dialogue volume cannot rush it',t=>{
 const low=closePeer(t,0).metrics,high=closePeer(t,120).metrics;
 for(const m of[low,high]){
  m.observe('p','pressure',coercion.userQuote,coercion,now);
  m.observe('p','apology',apology.userQuote,apology,now);
 }
 assert.equal(low.snapshot('p',now).relationship!.conflict!.intensity,high.snapshot('p',now).relationship!.conflict!.intensity);
 assert.ok(high.snapshot('p',now+3600000).relationship!.conflict!.intensity<low.snapshot('p',now+3600000).relationship!.conflict!.intensity);
 const at=now+3600000,good:SocialDecision={intent:'chat',effect:'bonding',mode:'reply',userQuote:'这件事我记住了'};
 high.observe('p','follow-through',good.userQuote,good,at);
 const one=high.snapshot('p',at).relationship!.conflict!.intensity;
 for(let i=0;i<30;i++)high.observe('p','more-'+i,'新说法'+i,{...good,userQuote:'新说法'+i},at);
 assert.equal(high.snapshot('p',at).relationship!.conflict!.intensity,one);
 const later=at+3600000,withoutBonus=high.snapshot('p',later).relationship!.conflict!.intensity;
 high.observe('p','repeat-phrase',good.userQuote,good,later);
 assert.equal(high.snapshot('p',later).relationship!.conflict!.intensity,withoutBonus,'repeated words are not new follow-through');
});
test('elapsed time, sleep and monthly ledgers do not depend on polling frequency',t=>{
 const a=fixture(t),b=fixture(t);a.snapshot('a',now);b.snapshot('a',now);
 const end=Date.parse('2026-11-01T09:00:00+08:00');
 for(let time=now+7*60000;time<end;time+=7*60000)b.snapshot('a',time);
 const one=a.snapshot('a',end),many=b.snapshot('a',end);
 assert.deepEqual(one,many);assert.equal(a.ledger().filter(x=>x.category==='salary').length,1);
 assert.equal(one.finance.savings,1200);a.snapshot('a',end);assert.equal(a.ledger().filter(x=>x.category==='salary').length,1);
 assert.ok(one.mood.value>=-10&&one.mood.value<=10);
});
test('purchase respects forecast budget and cannot charge twice',t=>{
 const m=fixture(t);const before=m.snapshot(undefined,now);
 assert.equal(m.spend('shirt',before.finance.spendable+1,'shopping','衣服',now),false);
 assert.equal(m.spend('shirt',100,'shopping','衣服',now),true);
 assert.equal(m.spend('shirt',100,'shopping','衣服',now),true);
 assert.equal(m.snapshot(undefined,now).finance.cash,before.finance.cash-100);
});
test('real input evidence, peer separation, monotonic recovery and no private quote leakage',t=>{
 const m=fixture(t);const event:SocialDecision={intent:'conflict',effect:'harassment',mode:'pause',minutes:15,userQuote:'私人事件暗号'};
 m.snapshot('a',now);m.observe('a','1',event.userQuote,event,now);m.observe('a','2',event.userQuote,event,now);
 assert.equal(m.snapshot('a',now).relationship?.affection,-6);
 assert.equal(m.snapshot('b',now).relationship?.affection,0);
 assert.equal(JSON.stringify(m.snapshot('b',now)).includes(event.userQuote),false);
 assert.equal(m.observe('a','2',event.userQuote,event,now),false);
 const healed=m.snapshot('a',now+40*86400000).relationship!;assert.equal(healed.affection,0);
 assert.throws(()=>m.observe('a','3','不相关的话',event,now));
});
test('jokes do not become hostility and repeated positive phrases cannot farm affection',t=>{
 const m=fixture(t);const joke={intent:'joke',effect:'harassment',mode:'reply',userQuote:'你嘴欠'};
 assert.equal(validSocialDecision(joke),false);
 const good:SocialDecision={intent:'chat',effect:'bonding',mode:'reply',userQuote:'我记得你喜欢蓝色'};
 m.observe('a','1',good.userQuote,good,now);m.observe('a','2',good.userQuote,good,now+86400000);
 assert.equal(m.snapshot('a',now+86400000).relationship?.affection,0.5);
});
test('rest restores energy and midnight does not reset it to 70',t=>{
 const m=fixture(t);const evening=Date.parse('2026-10-30T22:00:00+08:00');
 m.snapshot(undefined,evening,{text:'在住处休息',until:evening+30*60000});
 assert.equal(m.snapshot(undefined,evening+30*60000).energy,74);
 const night=m.snapshot(undefined,evening+2*3600000);assert.notEqual(night.energy,70);
});
test('frequent chat snapshots do not erase slow affection recovery',t=>{
 const a=fixture(t),b=fixture(t),event:SocialDecision={intent:'conflict',effect:'harassment',mode:'reply',userQuote:'测试攻击原话'};
 a.observe('p','1',event.userQuote,event,now);b.observe('p','1',event.userQuote,event,now);
 const end=now+2*3600000;for(let at=now+30000;at<end;at+=30000)b.snapshot('p',at);
 assert.deepEqual(a.snapshot('p',end),b.snapshot('p',end));
 assert.equal(a.snapshot('p',end).relationship?.affection,-3.94);
});
test('completed independent life events affect mood only once',t=>{
 const m=fixture(t);m.snapshot(undefined,now);
 m.exert('music',4,'听了喜欢的歌',now,4);m.exert('music',4,'听了喜欢的歌',now,4);
 assert.equal(m.snapshot(undefined,now).mood.value,4);assert.equal(m.snapshot(undefined,now).energy,74);
 assert.equal(m.snapshot(undefined,now+6*3600000).mood.kind,'平静');
});

test('chat at night consumes energy; a plan cannot award sleep or rest during known wakefulness',t=>{
 const m=fixture(t),night=Date.parse('2026-10-31T01:00:00+08:00');
 m.snapshot(undefined,night,{text:'通常在住处休息',since:night,until:night+3600000,source:'simulated_routine'});
 m.markAwake(night+10*60000,night);
 assert.equal(m.snapshot(undefined,night+10*60000).energy,69.5);
 assert.equal(m.snapshot(undefined,night+40*60000).energy,74.5,'only after presence expires can the sleep estimate resume');
});
test('a newly reported activity cannot rewrite energy in the preceding interval',t=>{
 const m=fixture(t),night=Date.parse('2026-10-31T01:00:00+08:00');
 m.snapshot(undefined,night);
 assert.equal(m.snapshot(undefined,night+30*60000,{text:'坐着看书',since:night+30*60000,until:night+60*60000,source:'dialogue:test'}).energy,75);
 assert.equal(m.snapshot(undefined,night+60*60000).energy,73.5);
});

test('negative messages are capped per peer over two hours while conflict remains independent',t=>{
 const m=fixture(t);
 for(let i=0;i<12;i++)m.observe('p','pressure-'+i,coercion.userQuote,coercion,now);
 assert.equal(m.snapshot('p',now).relationship!.affection,-6);
 assert.equal(m.snapshot('p',now).relationship!.conflict!.intensity,100);
 m.observe('q','other',coercion.userQuote,coercion,now);
 assert.equal(m.snapshot('q',now).relationship!.affection,-4);
 const later=now+2*3600000+1;
 const before=m.snapshot('p',later).relationship!.affection;
 m.observe('p','new-incident',coercion.userQuote,coercion,later);
 assert.equal(m.snapshot('p',later).relationship!.affection,Math.round((before-4)*100)/100);
});
