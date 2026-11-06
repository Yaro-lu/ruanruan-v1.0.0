import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {retainRuntimeFailure} from '../src/runtime-notice.js';

test('an unconfigured test records a failure locally once and does not contact the control account',async t=>{
 const root=mkdtempSync(join(tmpdir(),'runtime-notice-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 await retainRuntimeFailure('review timeout','same-job',root);
 await retainRuntimeFailure('duplicate watcher','same-job',root);
 const files=readdirSync(join(root,'runtime-notices'));assert.deepEqual(files,['same-job.json']);
 const record=JSON.parse(readFileSync(join(root,'runtime-notices',files[0]),'utf8'));
 assert.equal(record.reason,'review timeout');assert.equal(record.notification,'disabled');
});

test('an unavailable notifier leaves a durable queued source for independent recovery',async t=>{
 const root=mkdtempSync(join(tmpdir(),'runtime-notice-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'runtime-notifications.json'),JSON.stringify({enabled:true,settingsPath:join(root,'missing-settings.json')}));
 await retainRuntimeFailure('initial failure','retained-job',root);
 await retainRuntimeFailure('duplicate watcher','retained-job',root);
 const record=JSON.parse(readFileSync(join(root,'runtime-notices/retained-job.json'),'utf8'));
 assert.equal(record.reason,'initial failure');assert.equal(record.notification.status,'queued');
 assert.equal(record.notificationDeliveryVersion,1);
});

test('accepted and legacy uncertain notices are never blindly retried',async t=>{
 const root=mkdtempSync(join(tmpdir(),'runtime-notice-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,'runtime-notices'));
 for(const [id,notification,version] of [['accepted',{status:'accepted'},1],['legacy',{status:'failed'},undefined]] as const){
  const path=join(root,'runtime-notices',id+'.json'),value={id,reason:'original',notification,notificationDeliveryVersion:version};
  writeFileSync(path,JSON.stringify(value));
  await retainRuntimeFailure('duplicate watcher',id,root);
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),JSON.parse(JSON.stringify(value)));
 }
});
