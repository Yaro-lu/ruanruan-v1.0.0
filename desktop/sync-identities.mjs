// Local operator interface. Ordinary chat and model tools cannot name people or
// bind platform accounts. Synchronization does not send or generate messages.
import {parseArgs} from 'node:util';
import {loadDesktopConfig} from '../dist-desktop/src/desktop/config.js';
import {syncDesktopIdentities,desktopIdentityAccount} from '../dist-desktop/src/desktop/identity.js';
const {values}=parseArgs({options:{'owner-name':{type:'string'},'owner-call-name':{type:'string'}}});
const config=loadDesktopConfig(),identities=syncDesktopIdentities(config);
if(values['owner-name']||values['owner-call-name']) {
  if(!config.database?.ownerUsername)throw Error('Owner account must already be verified');
  const owner=identities.get(desktopIdentityAccount(config,config.database.ownerUsername));
  if(!owner)throw Error('Verified owner account is not in the address book');
  if(values['owner-name'])identities.setName(owner.id,values['owner-name']);
  if(values['owner-call-name'])identities.setPreferredName(owner.id,values['owner-call-name']);
}
console.log(JSON.stringify({people:identities.list().map(({storageKey,...person})=>person),historiesMoved:0,relationshipsReset:0,messagesSent:0},null,2));
