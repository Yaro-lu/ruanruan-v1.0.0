import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

// A local authenticated SSH takeover owns the same UI lock as the sender.
// A broken session leaves a visible hold until it is explicitly released.
export function manualControlState(queueDirectory:string): {active:boolean;revision?:string;reason?:string} {
  const path=join(dirname(queueDirectory),'manual-control.json');
  if(!existsSync(path))return {active:false};
  try {
    const value=JSON.parse(readFileSync(path,'utf8'));
    if(typeof value.active!=='boolean'||typeof value.sessionId!=='string')throw Error('Invalid takeover state');
    return {active:value.active,revision:value.sessionId+':'+String(value.endedAt??''),
      ...(value.active?{reason:'管理员正在接管微信桌面'}:{})};
  }catch{return {active:true,reason:'人工接管状态无法读取，需要核查'};}
}
