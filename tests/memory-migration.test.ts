import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ConversationMessage} from '../src/conversation.js';
import type {RoomSnapshot} from '../src/desktop/room-context.js';

const root=mkdtempSync(join(tmpdir(),'ruanruan-memory-migration-'));
process.env.WCB_DATA_DIR=root;
const {createMemoryStore}=await import('../src/memory.js');
const {createFactContext}=await import('../src/memory-context.js');
const {createIdentityStore}=await import('../src/identity.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));
const t1='2024-01-01T00:00:00.000Z',t2='2025-01-01T00:00:00.000Z';
const person={accountId:'bot',actorId:'A',audience:'A',platform:'wechat' as const};
const oldNote=(id:string,subject:string,attribute:string,text:string)=>({id,kind:'fact' as const,text,updatedAt:t1,
  fact:{subject,attribute},source:{messageId:`old-${id}`,at:t1,quote:text,speaker:'user' as const}});
const message=(text:string):ConversationMessage=>({id:'current',seq:1,at:Date.parse(t2),direction:'in',text,payload:{}});

test('recent conversation writes do not replay unchanged legacy facts',()=>{
  const memory=createMemoryStore('content-signature',root);
  memory.save({version:1,notes:[oldNote('old','user','过敏:虾','我对虾过敏')],handoff:'',recent:[]});
  let calls=0;const original=memory.factContext.store.importLegacy;
  memory.factContext.store.importLegacy=(...args)=>{calls++;return original(...args);};
  memory.recallFacts('虾');
  const signature=readFileSync(join(memory.dir,'fact-import.json'),'utf8');
  const state=memory.load();state.recent.push({user:'今天好热',assistant:'是啊',at:t2});state.handoff='新摘要';memory.save(state);
  memory.recallFacts('热');
  assert.equal(calls,1);
  assert.equal(readFileSync(join(memory.dir,'fact-import.json'),'utf8'),signature);
});

test('legacy self and canonical person ID compare as the same independently correctable fact',()=>{
  const memory=createMemoryStore('canonical-self',root,person);
  memory.save({version:1,notes:[oldNote('home','user','常住地','我住上海')],handoff:'',recent:[]});
  memory.recallFacts('住');
  const saved=memory.rememberFacts([{id:'home',subject:'user',attribute:'常住地',evidence:'现在搬到南京住了'}],[message('现在搬到南京住了')]);
  assert.equal(saved[0].fact?.subject,memory.factContext.ownSubject);
  assert.equal(memory.factContext.store.search({scope:memory.factContext.scope})[0].value,'现在搬到南京住了');
});

test('unbound relatives keep their canonical local subject during comparison and forgetting',()=>{
  const memory=createMemoryStore('canonical-relative',root,{...person,actorId:'relative-owner',audience:'relative-owner'});
  memory.save({version:1,notes:[oldNote('sister','妹妹','过敏:虾','妹妹虾过敏')],handoff:'',recent:[]});
  const original=memory.recallFacts('妹妹')[0];
  assert.ok(original.subjectId.startsWith('local_'));
  assert.equal(memory.factContext.subject(original.subjectId),original.subjectId);
  memory.forgetFacts([{subject:'妹妹',attribute:'过敏:虾',evidence:'忘掉妹妹的过敏'}],[message('忘掉妹妹的过敏')]);
  assert.equal(memory.load().notes.length,0);
  assert.equal(memory.factContext.store.search({scope:memory.factContext.scope}).length,0);
});

test('quote and mention account metadata recall implicit constraints without sharing private facts',()=>{
  const directory=join(root,'implicit'),identities=createIdentityStore(directory);
  const account={platform:'wechat' as const,channelAccountId:'bot'};
  const a=identities.observe({...account,actorId:'A'},[{name:'同名',kind:'room_nickname',scope:'room@chatroom'}]);
  const b=identities.observe({...account,actorId:'B'},[{name:'同名',kind:'room_nickname',scope:'room@chatroom'}]);
  const context=createFactContext('group',directory,{...person,actorId:'C',audience:'room@chatroom'});
  const other=createFactContext('other-speaker',directory,{...person,actorId:'D',audience:'room@chatroom'});
  assert.notEqual(context.subject('同名'),a.id);
  assert.notEqual(context.subject('同名'),b.id);
  assert.notEqual(context.subject('同名'),other.subject('同名'));
  context.store.upsert({subjectId:a.id,subjectName:'同名',attribute:'过敏:虾',value:'虾过敏',scope:context.scope,
    source:{messageId:'allergy',at:t1,quote:'我对虾过敏',speakerId:a.id}});
  context.store.upsert({subjectId:a.id,attribute:'过敏:花生',value:'私聊花生过敏',scope:{kind:'private',id:'private-A'},
    source:{messageId:'private-allergy',at:t1,quote:'花生也过敏',speakerId:a.id}});
  const room:RoomSnapshot={kind:'group',roomId:'room@chatroom',focus:undefined,participants:[],hasEarlier:false,
    messages:[{id:'now',at:Date.parse(t2),speaker:'C',speakerId:'C',personId:context.ownSubject,text:'这瓶虾酱推荐给你',
      mentions:['A'],replyTo:{actorId:'A',actorName:'同名',media:undefined}}]};
  const related=context.relatedPeople(room);
  assert.ok(related.includes(a.id));assert.ok(!related.includes(b.id));
  const facts=context.relevant('这瓶酱推荐给你',[],8,related);
  assert.ok(facts.some(row=>row.subjectId===a.id&&row.attribute==='过敏:虾'));
  assert.ok(!facts.some(row=>row.value.includes('私聊')));
  assert.deepEqual(context.relatedPeople({...room,roomId:'other@chatroom'}),[]);
});
