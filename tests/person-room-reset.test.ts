import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root=mkdtempSync(join(tmpdir(),'person-room-reset-'));
process.env.WCB_DATA_DIR=root;
const {createRoomStore,ROOM_STANDBY_MS}=await import('../src/desktop/room-context.js');
test.after(()=>rmSync(root,{recursive:true,force:true}));

test('person reset hides old disputes and delayed @ requests while preserving archive and others',()=>{
  const rooms=createRoomStore(root),roomId='test@chatroom';
  const old={id:'old',roomId,roomName:'群',actorId:'xiaoj',actorName:'小J',self:false,at:100,text:'旧争论',kind:'text'};
  rooms.record(old);rooms.consider(old,false,100);
  rooms.record({...old,id:'other',actorId:'friend',actorName:'朋友',text:'其他成员原话'});
  rooms.record({...old,id:'reply',actorId:'self',self:true,text:'旧答复',mentions:['xiaoj']});
  writeFileSync(join(root,'person-memory-resets.json'),JSON.stringify({resets:[{
    personId:'person-j',channelAccountId:'desktop-test',actorId:'xiaoj',roomId,
    storageAccountId:'desktop-test-room',peerId:'room',before:200,through:1,messageIds:[],roomEventIds:['old','reply'],
  }]}));
  assert.equal(rooms.consider(old,true,201),undefined,'delayed incoming does not replay an old @');
  assert.deepEqual(rooms.due(ROOM_STANDBY_MS+1000),[],'a forgotten pending event does not spin');
  const next={...old,id:'new',at:202,text:'你好'};
  rooms.record(next);assert.equal(rooms.consider(next,true,202),'direct');
  rooms.record({...next,id:'quote',actorId:'friend',text:'新话',replyTo:{actorId:'xiaoj',sourceId:'old',text:'旧争论'}});
  const context=JSON.stringify(rooms.snapshot(roomId));
  assert.doesNotMatch(context,/旧争论|旧答复/);
  assert.match(context,/其他成员原话/);assert.match(context,/你好/);assert.match(context,/旧引用已重置/);
  assert.doesNotMatch(JSON.stringify(rooms.history(roomId,'旧争论')),/旧争论|旧答复/);
  assert.equal(rooms.recent(roomId).length,5,'raw room archive is untouched');
});
