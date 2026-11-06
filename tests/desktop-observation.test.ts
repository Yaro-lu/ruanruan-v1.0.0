import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopStore, type VisibleBubble } from '../src/desktop/store.js';
import { createDesktopSender } from '../src/desktop/channel.js';
import type { DesktopConfig } from '../src/desktop/config.js';
import { SendRejected } from '../src/wechat/receipt.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function fixture(t:TestContext){
 const root=mkdtempSync(join(tmpdir(),'wechat-observation-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const config:DesktopConfig={version:1,enabled:true,accountId:'desktop-test',ownerPeerId:'owner',exchangeDirectory:join(root,'exchange'),queueDirectory:join(root,'queue'),contacts:[{peerId:'owner',uiLabel:'管理者',identityNote:'synthetic verified owner'}]};
 mkdirSync(config.exchangeDirectory);const screen=join(config.exchangeDirectory,'screen.png');writeFileSync(screen,png);
 const store=createDesktopStore(config);
 const observe=(messages:VisibleBubble[])=>store.observe({uiLabel:'管理者',atBottom:true,screenshotPath:screen,messages});
 return {root,config,screen,store,observe};
}
const message=(text:string,direction:'in'|'out'='in'):VisibleBubble=>({direction,kind:'text',text});
test('first view is a baseline; identical new bubbles get distinct stable occurrences and repeated snapshots do not replay',t=>{
 const f=fixture(t),a=message('你好');
 assert.equal(f.observe([a]).baseline,true);assert.equal(f.store.takeIncoming(),undefined);
 const second=f.observe([a,a]);assert.equal(second.forwarded.length,1);
 const third=f.observe([a,a,a]);assert.equal(third.forwarded.length,1);
 assert.notEqual(second.forwarded[0],third.forwarded[0]);assert.deepEqual(f.observe([a,a,a]).forwarded,[]);
 const recovered=createDesktopStore(f.config);assert.equal(recovered.observation().messages.length,3);
 assert.equal(recovered.takeIncoming()!.seq,second.forwarded[0]);assert.equal(recovered.takeIncoming()!.seq,third.forwarded[0]);
});
test('scrolling window preserves the overlap; old, ambiguous or wrong-recipient views are not imported',t=>{
 const f=fixture(t);f.observe([message('一'),message('二'),message('三')]);
 assert.equal(f.observe([message('二'),message('三'),message('四')]).forwarded.length,1);
 const before=f.store.observation();
 assert.throws(()=>f.observe([message('无法对齐的旧历史')]),/overlaps/);
 assert.deepEqual(f.store.observation(),before);
 assert.throws(()=>f.store.observe({uiLabel:'其他人',atBottom:true,screenshotPath:f.screen,messages:[message('x')]}),/does not match/);
 assert.throws(()=>f.store.observe({uiLabel:'管理者',atBottom:false,screenshotPath:f.screen,messages:[]}),/bottom/);
});
test('new attachments require real saved UI files and restart from a committed checkpoint without duplicate ingestion',t=>{
 const f=fixture(t);f.observe([message('上文')]);
 const image:VisibleBubble={direction:'in',kind:'image',text:'',visualKey:'猫照片'};
 assert.throws(()=>f.observe([message('上文'),image]),/actual incoming attachment/);
 assert.equal(f.store.observation().messages.length,1);
 const path=join(f.config.exchangeDirectory,'cat.png');writeFileSync(path,png);
 const result=f.observe([message('上文'),{...image,attachmentPath:path}]);
 assert.equal(result.forwarded.length,1);
 const incoming=f.store.takeIncoming()!;assert.deepEqual(readFileSync(incoming.message.localMedia!.localPath!),png);
 assert.deepEqual(createDesktopStore(f.config).observe({uiLabel:'管理者',atBottom:true,screenshotPath:f.screen,messages:[message('上文'),{...image,attachmentPath:path}]}).forwarded,[]);
});
test('security/logout pauses latch, cancel unsent deliveries and preserve uncertain ones without permitting more UI sends',async t=>{
 const f=fixture(t);f.observe([]);f.observe([message('新消息')]);
 const queued=f.store.enqueue({peerId:'owner',clientId:'q',kind:'text',text:'待发',context:'desktop:1',profile:'control'});
 const active=f.store.enqueue({peerId:'owner',clientId:'a',kind:'text',text:'可能已发',context:'desktop:1',profile:'control'});
 const first=f.store.claimDelivery()!;f.store.authorizeDelivery(first.id);f.store.receipt({id:first.id,leaseId:first.leaseId!,status:'sent',uiLabel:'管理者',observedText:'待发',screenshotPath:f.screen});
 const second=f.store.claimDelivery()!;f.store.authorizeDelivery(second.id);
 const notSent=f.store.enqueue({peerId:'owner',clientId:'b',kind:'image',file:f.screen,context:'desktop:1',profile:'control'});
 const alert=f.store.pause('为了你的账号安全，请重新登录',f.screen,'security');
 assert.equal(alert.kind,'security');assert.equal(f.store.status().paused,true);
 assert.equal(f.store.getDelivery(active.id).status,'uncertain');assert.equal(f.store.getDelivery(notSent.id).status,'cancelled');
 assert.equal(f.store.getDelivery(queued.id).status,'sent');assert.equal(f.store.claimDelivery(),undefined);assert.equal(f.store.takeIncoming(),undefined);
 assert.throws(()=>f.store.activeDelivery(second.leaseId!),SendRejected);
 await assert.rejects(()=>createDesktopSender(f.config,{store:f.store}).sendText('owner','','不应发送'),SendRejected);
 assert.equal(createDesktopStore(f.config).status().paused,true);
 f.store.resume();assert.equal(f.store.status().paused,false);
 assert.equal(f.store.getDelivery(active.id).status,'uncertain');assert.equal(f.store.claimDelivery(),undefined);
});
