import type {Session} from './session.js';
import type {CodexRunOptions,CodexRunResult} from './codex/bridge.js';

export interface ThreadFeedback {
  threadId:string;
  reviewed?: {characterUpdate:CodexRunResult['characterUpdate']|null;crossDeliveries:{id:string;text:string}[]};
  delivery?: {status:'incomplete';confirmedTexts:string[]};
}

export function retainReviewedContext(session:Session,result:CodexRunResult) {
  if(!session.threadId||session.threadId!==result.threadId)return false;
  session.threadFeedback={...(session.threadFeedback?.threadId===session.threadId?session.threadFeedback:{}),
    threadId:session.threadId,reviewed:{characterUpdate:result.characterUpdate??null,
      crossDeliveries:(result.crossDeliveries??[]).map(plan=>({id:plan.id,text:plan.text}))}};
  session.rotateBeforeNext=false;
  return true;
}

export function retainDeliveryContext(session:Session,confirmedTexts:string[]) {
  if(!session.threadId)return;
  session.threadFeedback={...(session.threadFeedback?.threadId===session.threadId?session.threadFeedback:{}),
    threadId:session.threadId,delivery:{status:'incomplete',confirmedTexts:confirmedTexts.map(text=>text.slice(0,3000)).slice(-6)}};
  // Delivery cannot invalidate an otherwise usable model conversation.
  // A separate generation failure can still require rotation.
}

export function conversationThreadTitle(options:CodexRunOptions) {
  const c=options.conversation;if(!c)return;
  const channel=c.accountId.startsWith('qq-')?'QQ':'微信';
  if(options.profile==='work')return `${channel} · 助手`;
  if(options.profile!=='companion')return;
  const label=(c.label||c.roomId||c.peerId).replace(/[\r\n\t\x00-\x1f]/gu,' ').trim().slice(0,80);
  return `${channel} · 阮阮 · ${c.roomId?'群聊':'私聊'}：${label}`;
}

export const isCharacterThreadTitle=(name:unknown)=>typeof name==='string'
  && /^(?:微信|QQ) · 阮阮(?: · (?:群聊|私聊)：.+)?$/u.test(name);
