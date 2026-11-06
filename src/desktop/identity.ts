import { dirname, join } from 'node:path';
import {createIdentityStore,type IdentityAlias} from '../identity.js';
import type {DesktopConfig,DesktopContact} from './config.js';

export const desktopIdentityDirectory=(config:DesktopConfig)=>config.identityDirectory??join(dirname(config.queueDirectory),'app');
export const desktopIdentityAccount=(config:DesktopConfig,actorId:string)=>({platform:'wechat' as const,channelAccountId:config.accountId,actorId});
export function observeDesktopPerson(config:DesktopConfig,contact:DesktopContact,actorId:string,actorName?:string) {
  const member=contact.members?.find(m=>m.username===actorId),profile=member?.profile??contact.profile;
  const aliases:IdentityAlias[]=[];
  if(profile?.wechatId)aliases.push({name:profile.wechatId,kind:'handle'});
  if(profile?.nickname)aliases.push({name:profile.nickname,kind:'nickname'});
  if(profile?.remark)aliases.push({name:profile.remark,kind:'remark'});
  if(profile?.roomNickname&&contact.kind==='group')aliases.push({name:profile.roomNickname,kind:'room_nickname',scope:contact.username});
  for(const name of new Set([actorName,member?.name,...(member?.mentionNames??[])]))if(name)aliases.push({name,kind:'observed',scope:contact.kind==='group'?contact.username:'private'});
  const registry=createIdentityStore(desktopIdentityDirectory(config)),account=desktopIdentityAccount(config,actorId);
  registry.observe(account,aliases,profile?.nickname??profile?.roomNickname??actorName);
  return registry.view(account,contact.kind==='group'?contact.username:'private')!;
}
export function syncDesktopIdentities(config:DesktopConfig) {
  for(const contact of config.contacts) {
    if(contact.kind==='group') {
      for(const member of contact.members??[])observeDesktopPerson(config,contact,member.username,member.name);
    } else if(contact.username)observeDesktopPerson(config,contact,contact.username,contact.actorName??contact.uiLabel);
  }
  return createIdentityStore(desktopIdentityDirectory(config));
}
