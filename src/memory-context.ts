import {createIdentityStore} from './identity.js';
import {createMemoryFactStore,localFactSubjectId,type MemoryScope,type StoredMemoryFact} from './memory-fact-store.js';
import type {PersonContext} from './wechat/channel.js';
import type {ConversationMessage} from './conversation.js';
import type {RoomSnapshot} from './desktop/room-context.js';

// Person identity and visibility are independent. The caller supplies additional
// public scopes only after the conversation router has established participation.
export function createFactContext(accountId:string,directory:string,person?:PersonContext,work=false) {
  const identities=createIdentityStore(directory);
  const platform=person?.platform??'wechat';
  const identityAccount=person?{platform,channelAccountId:person.accountId,actorId:person.actorId}:undefined;
  const owner=identityAccount?identities.observe(identityAccount):undefined;
  const group=person?.audience.endsWith('@chatroom');
  const scope:MemoryScope=work?{kind:'work',id:accountId}:person
    ?{kind:group?'group':'private',id:JSON.stringify([platform,person.accountId,group?person.audience:owner!.id])}
    :{kind:'private',id:accountId};
  const store=createMemoryFactStore(directory);
  const ownSubject=owner?.id??`conversation:${accountId}`;
  function speaker(source?:ConversationMessage) {
    const actor=(source?.payload as any)?.chatContext?.actorId;
    return identityAccount&&actor?identities.observe({...identityAccount,actorId:actor}).id:ownSubject;
  }
  function resolve(subject:string,source?:ConversationMessage):string|undefined {
    if(subject===ownSubject||/^local_[a-f0-9]{24}$/u.test(subject))return subject;
    const legacy=/^participant:([^:]+):(.+)$/u.exec(subject);
    const label=legacy?.[2]??subject;
    if(/^(user|本人|我|说话人)$/u.test(label)) {
      return legacy&&identityAccount?identities.observe({...identityAccount,actorId:legacy[1]}).id:speaker(source);
    }
    if(identityAccount) {
      const matches=identities.resolveName(label,identityAccount,person!.audience);
      if(matches.length===1)return matches[0].id;
    }
    return undefined;
  }
  function subject(subject:string,source?:ConversationMessage) {
    const legacy=/^participant:([^:]+):(.+)$/u.exec(subject);
    const author=legacy&&identityAccount?identities.observe({...identityAccount,actorId:legacy[1]}).id:speaker(source);
    return resolve(subject,source)??localFactSubjectId(scope,author,legacy?.[2]??subject);
  }
  function relatedPeople(room?:RoomSnapshot):string[] {
    if(!identityAccount||!group||room?.roomId!==person!.audience)return [];
    const recent=room.messages.slice(-3);
    // Only transport-provided account IDs establish who a quote/@ refers to.
    // A nickname or a guessed model label cannot merge same-named people.
    const actors=[...recent.flatMap(row=>[row.replyTo?.actorId,...(row.mentions??[])]),...recent.map(row=>row.speakerId)];
    return [...new Set([...new Set(actors.filter((actor):actor is string=>!!actor))].slice(0,8).flatMap(actor=>{
      const known=identities.get({...identityAccount,actorId:actor});
      return known?[known.id]:[];
    }))];
  }
  function relevant(query:string,extraScopes:MemoryScope[]=[],limit=8,relatedPersonIds:string[]=[]):StoredMemoryFact[] {
    const scopes=[scope,...extraScopes];
    const people=identityAccount?identities.mentioned(query,identityAccount,person!.audience).map(row=>row.id):[];
    const known=store.knownSubjects({scopes,query,limit:16}).filter(row=>row.subjectName&&query.includes(row.subjectName)).map(row=>row.subjectId);
    const related=relatedPersonIds.slice(0,4);
    const subjectIds=[...new Set([...related,ownSubject,...people,...known])];
    const rows=[...related.flatMap(id=>store.constraints({scopes,subjectIds:[id],limit:2})),
      ...store.constraints({scopes,subjectIds,limit:4}),
      ...store.search({scopes,subjectIds,query,limit}),...store.search({scopes,query,limit:4})];
    return [...new Map(rows.map(row=>[row.id,row])).values()].slice(0,limit);
  }
  return {store,scope,ownSubject,speaker,resolve,subject,relevant,relatedPeople};
}
