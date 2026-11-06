import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createLifeStore} from '../src/character-life.js';
const night=Date.parse('2026-10-30T23:55:00+08:00');
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'life-presence-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return createLifeStore(dir);}
const proposal=(action:string)=>JSON.stringify({action,reason:'顺着当前安排做件小事',detail:{activity:'靠着蓝色抱枕歇一会儿',summary:'靠着蓝色抱枕闭眼歇了片刻',feeling:'肩膀松了一点',moodDelta:2,participants:['self']}});
test('night schedule stays an intention and a delivered message records only present wakefulness',t=>{
 const s=fixture(t);let world=s.snapshot(night);
 assert.equal(world.phase,'unconfirmed');assert.equal(world.activity.certainty,'planned');assert.equal(world.routinePlan.phase,'asleep');
 s.observeDialogue(night,night);world=s.snapshot(night+60000);
 assert.equal(world.phase,'awake');assert.equal(world.awareness?.lastSpokeAt,night);
 assert.equal(world.activity.certainty,'planned');assert.equal(world.recent.length,0);
 assert.ok(world.metrics.energy<70);assert.equal(s.snapshot(night+11*60000).phase,'unconfirmed');
 assert.equal(s.claim(night+11*60000),undefined,'nighttime heartbeat throttling is retained');
});
test('established activity survives midnight and wins over the sleep estimate until it expires',t=>{
 const s=fixture(t);s.followSpokenActivity({text:'坐在桌边看小说',at:night,until:night+30*60000,messageId:'out:book'},night);
 const later=s.snapshot(night+10*60000);
 assert.equal(later.activity.text,'坐在桌边看小说');assert.equal(later.activity.certainty,'established');assert.equal(later.phase,'awake');
 assert.equal(later.routinePlan.phase,'asleep');assert.equal(later.day,'2026-10-31');
 assert.ok(later.metrics.energy<70);
 s.followSpokenActivity({text:'旧状态',at:night-60000,until:night+30*60000,messageId:'out:old'},night+10*60000);
 assert.equal(s.snapshot(night+10*60000).activity.text,'坐在桌边看小说');
 assert.equal(s.snapshot(night+31*60000).activity.certainty,'planned');
});
test('ordinary conversation does not cancel or complete an unrelated pending life action',t=>{
 const s=fixture(t),evening=Date.parse('2026-10-30T20:00:00+08:00');
 const b=s.claim(evening,true)!;
 assert.ok(s.settle(b,{replyText:proposal('budget'),commands:[],fileChanges:[]},true,evening+1000));
 s.observeDialogue(evening+60000,evening+60000);
 assert.equal(s.snapshot(evening+2*60000).pending?.action,'budget');
 assert.equal(s.snapshot(evening+2*60000).recent.length,0);
 assert.equal(s.snapshot(evening+26*60000).recent.length,1);
});
test('a heartbeat rest begins affecting energy immediately, including before the next poll',t=>{
 const s=fixture(t),evening=Date.parse('2026-10-30T20:00:00+08:00');
 const b=s.claim(evening,true)!;
 assert.ok(s.settle(b,{replyText:proposal('rest'),commands:[],fileChanges:[]},true,evening+1000));
 assert.ok(s.snapshot(evening+21*60000).metrics.energy>72.5);
});
