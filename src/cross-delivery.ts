import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {DesktopConfig} from './desktop/config.js';
import {desktopIdentityDirectory} from './desktop/identity.js';
import type {ChatContext,WechatSender} from './wechat/channel.js';
import type {ConversationMemoryPolicy} from './conversation.js';
import {createCrossConversation,type CrossConversationRoute} from './cross-conversation.js';
import {createRoomStore,type RoomSnapshot} from './desktop/room-context.js';
import {catalogFile,describeMedia,MEDIA_ROOT,type CatalogCandidate} from './media-catalog.js';
import {resolveCharacterMedia} from './character-media.js';
import {planChatReply} from './utils/chat-reply.js';
import {deliverAlbumReply} from './wechat/album-delivery.js';
import {type Delivery} from './wechat/image-delivery.js';
import {memeFile,createMemeClient} from './memecub.js';

export interface CrossDelivery {
  id:string;route:CrossConversationRoute;requestEvidence:string;text:string;
  asset?:CatalogCandidate;targetContext?:RoomSnapshot;contextToken:string;
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const routeKey=(route:CrossConversationRoute)=>[route.storageAccountId,route.peerId,route.mention?.username??null];

export const CROSS_DELIVERY_SPECS=[
  {type:'function',name:'conversation_target',description:'按本轮明确跨会话请求查找可用群聊或联系人；只有请求者实际参与的群可用。同名或模糊名称返回候选，不能猜。群内找人可同时传member；需要@时以返回的账号为准。这里只查目标，没有发消息。',
    inputSchema:{type:'object',properties:{query:{type:'string',maxLength:200},kind:{type:'string',enum:['group','private']},member:{type:'string',maxLength:200}},required:['query'],additionalProperties:false}},
  {type:'function',name:'conversation_send',description:'暂存本轮愿意执行的跨会话传话、打招呼或发图计划。targetId必须来自本轮conversation_target的唯一结果，requestEvidence引用当前用户提出该请求的真实原话；text仅填写准备对目标说的话，可附本轮素材[[ASSET:编号]]，不要自动复制私聊历史。尚未审核发送，不能宣称已送达。不愿意可不调用，改变主意可cancel。相同目标再次stage会替换，最多3个目标。',
    inputSchema:{type:'object',properties:{operation:{type:'string',enum:['stage','cancel']},targetId:{type:'string'},planId:{type:'string'},text:{type:'string',maxLength:6000},requestEvidence:{type:'string',maxLength:2000}},required:['operation'],additionalProperties:false}},
];

function requestSupportsSend(current:string,evidence:string) {
  if(!evidence.trim()||!current.includes(evidence))throw Error('requestEvidence必须引用本轮用户真实原话');
  // The normal character review evaluates authorization, cancellation and
  // willingness against the full turn. Substring rules cannot decide intent.
}

function targetToken(config:DesktopConfig,route:CrossConversationRoute) {
  const path=join(config.queueDirectory,'channel.sqlite3');
  if(!existsSync(path))return route.kind==='group'?'desktop:0':'desktop:null';
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    const row=db.prepare('SELECT MAX(seq) AS seq FROM incoming WHERE account=? AND peer=?').get(config.accountId,route.peerId);
    return `desktop:${row?.seq??(route.kind==='group'?0:'null')}`;
  } finally {db.close();}
}

export function createCrossDeliveryPlans(config:DesktopConfig,context:ChatContext,currentUser:string|(()=>string),candidates:CatalogCandidate[],
  options:{identityDirectory?:string;mediaRoot?:string;now?:()=>number}={}) {
  const cross=createCrossConversation(config,options),resolved=new Map<string,CrossConversationRoute>();
  const plans:CrossDelivery[]=[];
  function call(name:string,args:any):unknown {
    if(name==='conversation_target') {
      if(typeof args?.query!=='string'||!args.query.trim()||args.query.length>200)throw Error('需要明确的目标名称或账号');
      if(args.kind!==undefined&&!['private','group'].includes(args.kind))throw Error('未知会话类型');
      if(args.member!==undefined&&(typeof args.member!=='string'||args.member.length>200))throw Error('群成员名称无效');
      const result=cross.resolveTarget({context,query:args.query,kind:args.kind,member:args.member});
      if(result.status!=='resolved')return result;
      const targetId='target_'+hash(routeKey(result.route)).slice(0,20);
      resolved.set(targetId,result.route);
      return {...result,targetId};
    }
    if(name!=='conversation_send')throw Error('Unknown cross-conversation tool');
    if(args?.operation==='cancel') {
      const index=plans.findIndex(plan=>plan.id===args.planId||(args.targetId&&resolved.get(args.targetId)
        &&hash(routeKey(plan.route))===hash(routeKey(resolved.get(args.targetId)!))));
      if(index>=0)plans.splice(index,1);
      return {status:'cancelled',removed:index>=0,delivered:false};
    }
    if(args?.operation!=='stage')throw Error('operation需要stage或cancel');
    const route=resolved.get(args.targetId);if(!route)throw Error('目标必须先在本轮唯一解析，不能猜测或直接指定路径');
    if(typeof args.requestEvidence!=='string'||args.requestEvidence.length>2000)throw Error('需要当前用户请求的原话');
    requestSupportsSend(typeof currentUser==='function'?currentUser():currentUser,args.requestEvidence);
    if(typeof args.text!=='string'||args.text.length>6000)throw Error('需要6000字以内的待发送内容');
    if(/!\[[^\]]*\]\(|(?:^|\s)(?:file:\/\/|\/(?:home|tmp|mnt|etc|root)\/|[A-Za-z]:\\)\S+/u.test(args.text)) {
      throw Error('跨会话图片只能选本轮素材编号，不能指定本地路径');
    }
    const tokens=[...args.text.matchAll(/\[\[ASSET:([^\]\r\n]+)\]\]/gu)];
    if(tokens.length>1||tokens.some(token=>!candidates.some(asset=>asset.asset_id===token[1].trim()))
      ||(args.text.match(/\[\[ASSET:/gu)??[]).length!==tokens.length)throw Error('只能选择一个本轮实际返回的素材编号');
    const selected=resolveCharacterMedia({replyText:args.text,mediaCandidates:candidates});
    if(selected.asset&&!selected.asset.meme&&!catalogFile(selected.asset,options.mediaRoot??MEDIA_ROOT))throw Error('选中的素材文件不存在或不在相册内');
    if(!selected.text.trim()&&!selected.asset)throw Error('待发送内容为空');
    const id='cross_'+hash(routeKey(route)).slice(0,20),index=plans.findIndex(plan=>plan.id===id);
    if(index<0&&plans.length>=3)throw Error('本轮最多暂存3个不同目标');
    const plan:CrossDelivery={id,route,requestEvidence:args.requestEvidence,text:selected.text,asset:selected.asset,
      contextToken:targetToken(config,route),...(route.kind==='group'?{targetContext:createRoomStore(config.queueDirectory,undefined,
        options.identityDirectory??desktopIdentityDirectory(config)).snapshot(route.conversationId)}:{})};
    if(index<0)plans.push(plan);else plans[index]=plan;
    return {status:'staged_pending_review',delivered:false,planId:id,target:route,
      text:plan.text,...(plan.asset?{asset:describeMedia(plan.asset)}:{}),instruction:'计划已暂存，尚未审核或发送。'};
  }
  return {specs:CROSS_DELIVERY_SPECS,call,plans};
}

export async function deliverCrossConversation(plan:CrossDelivery,options:{sender:WechatSender;jobDirectory:string;sourceJobId:string;
  shouldContinue?:()=>boolean;dataDirectory?:string;mediaRoot?:string;threadId?:string;memoryPolicy?:ConversationMemoryPolicy}) {
  if(!options.sender.forConversation)throw Error('跨会话发送需要独立目标会话发送器');
  const directory=join(options.jobDirectory,'cross-delivery',hash([options.sourceJobId,plan.id]).slice(0,24));
  mkdirSync(directory,{recursive:true,mode:0o700});
  const fingerprint=hash({route:routeKey(plan.route),text:plan.text,asset:plan.asset,contextToken:plan.contextToken});
  const metadata=join(directory,'plan.json');
  if(existsSync(metadata)) {
    if(JSON.parse(readFileSync(metadata,'utf8')).fingerprint!==fingerprint)throw Error('该跨会话计划已有回执，不能改内容后复用');
  } else writeFileSync(metadata,JSON.stringify({fingerprint,sourceJobId:options.sourceJobId,planId:plan.id,route:plan.route}),{mode:0o600,flag:'wx'});
  const asset=plan.asset,images:string[]=[],videos:string[]=[];
  if(asset) {
    const path=asset.purpose==='reaction'?memeFile(asset,directory,options.mediaRoot):catalogFile(asset,options.mediaRoot);
    if(!path)throw Error('跨会话素材不可用');
    (asset.kind==='image'?images:videos).push(path);
  }
  const texts=planChatReply(plan.text,true).messages;
  const receipt=join(directory,'image-delivery.json');
  if(!existsSync(receipt)) {
    const parts=[...images.map(value=>({kind:'image' as const,value})),...videos.map(value=>({kind:'video' as const,value})),
      ...texts.map(value=>({kind:'text' as const,value}))];
    const initial:Delivery={version:1,parts:parts.map((part,index)=>({...part,status:'pending',
      clientId:'wcc-cross-'+hash([options.sourceJobId,plan.id,index]).slice(0,32)}))};
    writeFileSync(receipt,JSON.stringify(initial),{mode:0o600,flag:'wx'});
  }
  const sender=options.sender.forConversation(plan.route.storageAccountId,plan.route.mention??null);
  return sender.inThread(options.threadId,()=>deliverAlbumReply({directory,images,videos,texts,sender,
    accountId:plan.route.storageAccountId,peerId:plan.route.peerId,jobId:options.sourceJobId+':'+plan.id,
    asset,dataDirectory:options.dataDirectory,toUserId:plan.route.peerId,contextToken:()=>plan.contextToken,
    shouldContinue:options.shouldContinue,textFirst:false,
    ...(asset?.purpose==='reaction'&&asset.meme?{prepareImage:async()=>{
      const memes=createMemeClient(options.dataDirectory,{mediaRoot:options.mediaRoot});
      try {await memes.download(asset,directory);} finally {await memes.close();}
    }}:{}),
  }),'companion',options.memoryPolicy);
}
