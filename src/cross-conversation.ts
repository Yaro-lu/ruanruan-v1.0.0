import {createIdentityStore,type IdentityView} from './identity.js';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {conversationAccount} from './conversation-scope.js';
import type {ChatContext} from './wechat/channel.js';
import {type DesktopConfig,type DesktopContact} from './desktop/config.js';
import {desktopIdentityAccount,desktopIdentityDirectory} from './desktop/identity.js';
import {createRoomStore,type RoomSnapshot} from './desktop/room-context.js';

export interface CrossConversationScope {kind:'group'|'private';id:string}
export interface CrossConversationRoute {
  kind:'group'|'private'; peerId:string; conversationId:string; conversationName:string;
  storageAccountId:string; context:ChatContext; scope:CrossConversationScope;
  personId?:string; mention?:{username:string;name:string};
}
export type CrossTargetResult = {status:'resolved';route:CrossConversationRoute}
  | {status:'ambiguous'|'not_found'|'unknown_person';candidates:CrossConversationRoute[]};
export interface PublicParticipationEvidence {
  kind:'public_message'|'verified_member'; actorId:string; roomId:string; sourceId?:string; at?:number;
}
export interface CrossPublicRoom extends RoomSnapshot {
  scope:CrossConversationScope;roomName:string;participation:PublicParticipationEvidence[];
}
export interface CrossPublicContext {
  status:'ok'|'not_private'|'unknown_person'|'ambiguous'|'not_found';personId?:string;
  rooms:CrossPublicRoom[];candidates?:CrossConversationRoute[];
}
const normalized=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase();
const unique=(values:(string|undefined)[])=>[...new Set(values.filter((value):value is string=>!!value?.trim()))];
export const CROSS_ROSTER_MAX_AGE_MS=60_000;

// This module only projects existing identities, routes and public originals.
// Sending remains a separately reviewed, current-turn action owned by main.
export function createCrossConversation(config:DesktopConfig,options:{identityDirectory?:string;now?:()=>number}={}) {
  const directory=options.identityDirectory??desktopIdentityDirectory(config);
  const identities=createIdentityStore(directory),now=options.now??Date.now;
  const identity=(actorId:string,audience='private')=>identities.view(desktopIdentityAccount(config,actorId),audience);
  const rooms=createRoomStore(config.queueDirectory,(actorId,roomId)=>identity(actorId,roomId),directory);
  const base={accountId:config.accountId,userId:config.ownerPeerId,transport:'desktop' as const,entryRole:'character' as const};
  const groupScope=(roomId:string):CrossConversationScope=>({kind:'group',id:JSON.stringify(['wechat',config.accountId,roomId])});
  const privateActor=(contact:DesktopContact)=>contact.username??contact.actorUsername
    ??(contact.peerId===config.ownerPeerId?config.database?.ownerUsername:undefined);
  function requester(context:ChatContext) {
    const person=identity(context.actorId,context.kind==='group'?context.conversationId:'private');
    if(!person||(context.person&&context.person.id!==person.id))return;
    // Look up the operator-verified binding once, rather than scanning every
    // contact and reopening the identity registry for each name on every turn.
    const db=new DatabaseSync(join(directory,'identities.sqlite3'),{readOnly:true});
    let actors:string[];
    try {actors=db.prepare('SELECT actor FROM identity_accounts WHERE person=? AND platform=? AND channel_account=?')
      .all(person.id,'wechat',config.accountId).map(row=>String(row.actor));}
    finally {db.close();}
    return {person,actors};
  }
  function eligible(context:ChatContext) {
    const request=requester(context);if(!request)return;
    const groups=config.contacts.filter(contact=>contact.kind==='group'&&contact.username?.endsWith('@chatroom')).flatMap(contact=>{
      const observed=contact.rosterObservedAt;
      if(typeof observed!=='number'||!Number.isSafeInteger(observed)||observed<=0
        ||observed>now()||now()-observed>CROSS_ROSTER_MAX_AGE_MS)return [];
      const current=(contact.members??[]).filter(member=>request.actors.includes(member.username));
      // Old public speech proves an event, not permission to read a room today.
      // Unknown or stale membership fails closed only for cross-room access.
      if(!current.length)return [];
      const evidence:PublicParticipationEvidence[]=[];
      for(const member of current) {
        evidence.push({kind:'verified_member',actorId:member.username,roomId:contact.username!,at:observed});
      }
      for(const event of rooms.participationEvidence(contact.username!,request.actors).filter(event=>event.at<=observed).slice(0,2)) {
        evidence.push({kind:'public_message',actorId:event.actorId,roomId:contact.username!,sourceId:event.id,at:event.at});
      }
      return evidence.length?[{contact,evidence}]:[];
    });
    return {...request,groups};
  }
  function groupRoute(contact:DesktopContact,context:ChatContext,member?:NonNullable<DesktopContact['members']>[number]):CrossConversationRoute {
    const person=member?identity(member.username,contact.username!):identity(context.actorId,contact.username!);
    const target:ChatContext={kind:'group',conversationId:contact.username!,conversationName:contact.uiLabel,
      actorId:member?.username??context.actorId,actorName:member?.name??context.actorName,...(person?{person}:{})};
    return {kind:'group',peerId:contact.peerId,conversationId:contact.username!,conversationName:contact.uiLabel,
      storageAccountId:conversationAccount(base,contact.peerId,target).accountId,context:target,scope:groupScope(contact.username!),
      ...(member?{mention:{username:member.username,name:member.name},personId:person?.id}:{})};
  }
  function aliasNames(person:IdentityView|undefined) {
    return person?[person.name,person.preferredName,...person.aliases.map(alias=>alias.name)]:[];
  }
  type Candidate={route:CrossConversationRoute;ids:string[];names:string[]};
  function choose(candidates:Candidate[],query:string):CrossTargetResult {
    const key=normalized(query);if(!key)return {status:'not_found',candidates:[]};
    const idMatches=candidates.filter(candidate=>candidate.ids.some(id=>normalized(id)===key));
    const exact=idMatches.length?idMatches:candidates.filter(candidate=>candidate.names.some(name=>normalized(name)===key));
    if(exact.length===1)return {status:'resolved',route:exact[0].route};
    const matches=exact.length?exact:candidates.filter(candidate=>candidate.names.some(name=>normalized(name).includes(key)));
    return {status:matches.length?'ambiguous':'not_found',candidates:matches.map(candidate=>candidate.route).slice(0,12)};
  }
  function resolveTarget(input:{context:ChatContext;query:string;kind?:'group'|'private';member?:string}):CrossTargetResult {
    const allowed=eligible(input.context);if(!allowed)return {status:'unknown_person',candidates:[]};
    const candidates:Candidate[]=[];
    if(input.kind!=='private')for(const {contact} of allowed.groups)candidates.push({
      route:groupRoute(contact,input.context),ids:[contact.peerId,contact.username!],names:[contact.uiLabel]});
    if(input.kind!=='group')for(const contact of config.contacts.filter(row=>row.kind!=='group')) {
      const actor=privateActor(contact);if(!actor)continue;
      const person=identity(actor);if(!person)continue;
      const shared=allowed.groups.filter(({contact:group})=>(group.members??[]).some(member=>member.username===actor));
      if(person.id!==allowed.person.id&&!shared.length)continue;
      const context:ChatContext={kind:'private',conversationId:actor,conversationName:contact.uiLabel,
        actorId:actor,actorName:contact.actorName??contact.uiLabel,person};
      candidates.push({route:{kind:'private',peerId:contact.peerId,conversationId:actor,conversationName:contact.uiLabel,
        storageAccountId:conversationAccount(base,contact.peerId,context).accountId,context,personId:person.id,
        scope:{kind:'private',id:JSON.stringify(['wechat',config.accountId,person.id])}},
        ids:[contact.peerId,actor,person.id],names:unique([contact.uiLabel,contact.actorName,...aliasNames(person),
          ...shared.flatMap(({contact:group})=>aliasNames(identity(actor,group.username!)))])});
    }
    const result=choose(candidates,input.query);
    if(result.status!=='resolved'||!input.member)return result;
    if(result.route.kind!=='group')return {status:'not_found',candidates:[]};
    const contact=allowed.groups.find(row=>row.contact.peerId===result.route.peerId)!.contact;
    const members=(contact.members??[]).filter(member=>member.username!==config.database?.selfUsername);
    return choose(members.map(member=>{const person=identity(member.username,contact.username!);return {
      route:groupRoute(contact,input.context,member),ids:unique([member.username,person?.id]),
      names:unique([member.name,...(member.mentionNames??[]),member.profile?.nickname,member.profile?.roomNickname,
        member.profile?.remark,member.profile?.wechatId,...aliasNames(person)])};}),input.member);
  }
  function publicContext(input:{context:ChatContext;query?:string;room?:string;limit?:number}):CrossPublicContext {
    if(input.context.kind!=='private')return {status:'not_private',rooms:[]};
    const allowed=eligible(input.context);if(!allowed)return {status:'unknown_person',rooms:[]};
    let groups=allowed.groups;
    if(input.room) {
      const resolved=resolveTarget({context:input.context,query:input.room,kind:'group'});
      if(resolved.status!=='resolved')return {status:resolved.status,personId:allowed.person.id,rooms:[],candidates:resolved.candidates};
      groups=groups.filter(row=>row.contact.peerId===resolved.route.peerId);
    }
    // Automatic continuation stays close to this person's own public exchange.
    // Explicitly selecting a shared room permits a relevant public lookup there.
    groups=groups.sort((a,b)=>Math.max(0,...b.evidence.map(e=>e.at??0))-Math.max(0,...a.evidence.map(e=>e.at??0)));
    const result:CrossPublicRoom[]=[];let budget=6000;
    for(const {contact,evidence} of groups) {
      if(result.length>=Math.min(3,Math.max(1,input.limit??2)))break;
      const snapshot=rooms.publicWindow(contact.username!,{actorIds:allowed.actors,query:input.query,limit:6,
        ...(input.room?{}:{since:now()-24*60*60_000}),until:contact.rosterObservedAt!,allowOtherSpeakers:!!input.room});
      if(!snapshot.messages.length)continue;
      const text=JSON.stringify(snapshot);if(text.length>budget)continue;budget-=text.length;
      result.push({...snapshot,scope:groupScope(contact.username!),roomName:contact.uiLabel,participation:evidence});
    }
    return {status:'ok',personId:allowed.person.id,rooms:result};
  }
  function sharedGroups(context:ChatContext) {
    const allowed=eligible(context);if(!allowed)return [];
    return allowed.groups.filter(({contact})=>context.kind==='private'||contact.username===context.conversationId)
      .map(({contact})=>({scope:groupScope(contact.username!),roomId:contact.username!,roomName:contact.uiLabel}));
  }
  return {resolveTarget,publicContext,sharedGroups};
}

export function crossPublicContextText(context:CrossPublicContext) {
  if(context.status!=='ok'||!context.rooms.length)return '';
  return '【同一人在公开群里的相关前文】\n'+JSON.stringify(context)
    +'\n这些是标明来源的群内公开原话，供当前私聊接续。按 speakerId/personId 分清说话者，保留 scope 与消息 ID；不把群友的话当成对方私下告诉你的，不将这些原文另存为私聊专属记忆。';
}
