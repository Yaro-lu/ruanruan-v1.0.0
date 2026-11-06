// Run only after the operator has visually verified the logged-in account and
// the owner's actual WeChat ID. This command never attempts a login or sends a test.
import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadDesktopConfig, desktopConfigPath, parseDesktopConfig } from '../dist-desktop/src/desktop/config.js';
import { createDesktopStore } from '../dist-desktop/src/desktop/store.js';
import { saveJson } from '../dist-desktop/src/store.js';
const projectDirectory = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export function activateDesktop(values, {
  dataDirectory = join(homedir(), '.wechat-codex-desktop'),
  configPath = desktopConfigPath(),
  createStore = createDesktopStore,
  runService = spawnSync,
} = {}) {
const args = {};
for (let i=0;i<values.length;i+=2) {
  if (!['--owner-wechat-id','--ui-label','--account-wechat-id','--transport'].includes(values[i]) || !values[i+1]?.trim()) throw Error('Provide owner WeChat ID, exact unique UI label, and the verified account WeChat ID');
  args[values[i]] = values[i+1].trim();
}
for (const name of ['--owner-wechat-id','--ui-label','--account-wechat-id']) if (!args[name]) throw Error('Missing '+name);
if (args['--owner-wechat-id'] === args['--account-wechat-id']) throw Error('The role account and owner must be separate accounts');
const transport=args['--transport'] ?? 'database';
if (transport!=='database') throw Error('Only the database desktop transport is supported');
const old = loadDesktopConfig(configPath), id = args['--account-wechat-id'];
const databasePath=join(dataDirectory,'database.json');
if (!existsSync(databasePath) || !old.database) throw Error('Prepare the database transport and verify its identities first');
const prepared=JSON.parse(readFileSync(databasePath,'utf8'));
if (prepared.accountWechatId!==id || prepared.ownerWechatId!==args['--owner-wechat-id'] || prepared.uiLabel!==args['--ui-label']) throw Error('Activation differs from the prepared database identities');
if (old.accountWechatId && old.accountWechatId !== id) throw Error('Different WeChat account: review existing history before rebinding');
const peerId = 'owner-'+createHash('sha256').update(args['--owner-wechat-id']).digest('hex').slice(0,16);
if (old.ownerPeerId && old.ownerPeerId !== peerId) throw Error('Different owner: do not mix private histories automatically');
const config = parseDesktopConfig({ ...old, enabled:true, accountWechatId:id, ownerPeerId:peerId,
  contacts:[{...old.contacts.find(c=>c.peerId===peerId),peerId,uiLabel:args['--ui-label'],identityNote:'已通过可见资料核对微信号：'+args['--owner-wechat-id']},...old.contacts.filter(c=>c.peerId!==peerId)] });
const directory=join(dataDirectory,'app'),session=join(directory,'sessions',config.accountId+'.json');
mkdirSync(join(directory,'sessions'),{recursive:true,mode:0o700});
if (!existsSync(session)) saveJson(session,{workingDirectory:projectDirectory,state:'idle',
  chatMode:'companion',model:'gpt-5.6-luna',reasoningEffort:'medium',serviceTier:'fast',mode:'plan',memoryVersion:1,memoryTurns:0,contextTokens:0,contextChars:0});
saveJson(configPath,config);
createStore(config).resume();
saveJson(databasePath,{...prepared,enabled:true});
const result=runService('systemctl',['--user','enable','--now','wechat-desktop-runtime.service','wechat-desktop-bridge.service','wechat-desktop-database.service'],{encoding:'utf8'});
if (result.status!==0) throw Error(result.stderr||'Desktop services did not start');
return {accountId:config.accountId,ownerPeerId:peerId,uiLabel:args['--ui-label'],enabled:true,transport,loginAttempted:false,testMessageSent:false};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(activateDesktop(process.argv.slice(2))));
}
