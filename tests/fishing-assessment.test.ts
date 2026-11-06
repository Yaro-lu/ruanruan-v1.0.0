import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchFishingAssessment } from '../src/fishing-assessment.js';
process.env.WCB_FISHING_GROUP_ID = '90000000001@chatroom';
process.env.WCB_FISHING_GROUP_NAME = '离线钓鱼测试群';
const { createFishingTools, FISHING_ROOM_ID } = await import('../src/fishing.js');

test('assessment forwards model parameters and preserves reference-only evidence',async t=>{
 let calls=0;
 t.mock.method(globalThis,'fetch',async(url:any,options:any)=>{
  calls++;assert.equal(String(url),'http://127.0.0.1:18186/v1/assess');
  assert.deepEqual(JSON.parse(options.body),{params:{H:3},windowMode:'night'});
  return new Response(JSON.stringify({ok:true,source:{name:'FishingCore'},referenceOnly:true,days:[{score:50}]}));
 });
 const tools=createFishingTools('desktop-ruanruan',FISHING_ROOM_ID);
 const data=await tools.call('fishing_assess',{params:{H:3},windowMode:'night'});
 assert.equal(calls,1);assert.deepEqual(tools.evidence,[{tool:'fishing_assess',data}]);
 const privateChat=createFishingTools('desktop-ruanruan');
 await assert.rejects(privateChat.call('fishing_assess',{}),/未启用/);assert.equal(calls,1);
});

test('network failures and invalid results remain explicit failures',async()=>{
 const failed=await fetchFishingAssessment({}, {fetch:async()=>{throw Error('offline');}});
 assert.equal(failed.ok,false);
 const invalid=await fetchFishingAssessment({}, {fetch:async()=>new Response('{"ok":true,"days":[]}')});
 assert.equal(invalid.ok,false);
 const ambiguous={ok:false,error:{code:'ambiguous_location',details:{candidates:[{name:'同名地点'}]}}};
 assert.deepEqual(await fetchFishingAssessment({}, {fetch:async()=>new Response(JSON.stringify(ambiguous),{status:422})}),ambiguous);
});
