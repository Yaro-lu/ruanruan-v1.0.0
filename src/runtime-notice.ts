import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DATA_DIR} from './constants.js';
import {atomicWrite} from './jobs.js';

// Technical failures belong to the separate control entry, never character speech.
export async function retainRuntimeFailure(reason:string,jobId?:string,directory=DATA_DIR) {
  const folder=join(directory,'runtime-notices');mkdirSync(folder,{recursive:true,mode:0o700});
  const id=jobId??randomUUID(),path=join(folder,id+'.json');
  const existing=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):undefined;
  if(existing&&(existing.notification==='disabled'||existing.notification?.status==='accepted'
      ||existing.notification?.status==='uncertain'||existing.notificationDeliveryVersion!==1))return;
  const value:any=existing??{id,jobId,reason:reason.slice(0,600),detectedAt:new Date().toISOString(),
    notification:{status:'queued'},notificationDeliveryVersion:1};
  atomicWrite(path,value);
  try {
    if(!existsSync(join(directory,'runtime-notifications.json'))){value.notification='disabled';return;}
    const config=JSON.parse(readFileSync(join(directory,'runtime-notifications.json'),'utf8'));
    if(config.enabled!==true||typeof config.settingsPath!=='string'){value.notification='disabled';return;}
    value.notification={status:'queued'};atomicWrite(path,value);
    const script=fileURLToPath(new URL('../../desktop/security_notify.py',import.meta.url));
    value.notification=await new Promise((resolve,reject)=>{
      const child=spawn('/usr/bin/python3',[script,'runtime',config.settingsPath],{stdio:['pipe','pipe','pipe']});
      let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Control notification timed out'));},12000);
      child.stdout.on('data',b=>{output+=b;if(output.length>8000)child.kill();});child.stderr.resume();
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.on('exit',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{reject(Error('Control notification unavailable'));}});
      child.stdin.end(JSON.stringify(value));
    });
  }catch(error){value.notification={status:'queued',error:String(error).slice(0,300)};}
  finally{atomicWrite(path,value);}
}
