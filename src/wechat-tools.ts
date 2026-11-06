import type {PersonContext} from './wechat/channel.js';
import {loadDesktopConfig} from './desktop/config.js';
import {viewRoomMedia} from './desktop/media-view.js';
import {createRoomStore,type RoomSnapshot} from './desktop/room-context.js';
import {createIdentityStore} from './identity.js';
import { randomUUID } from 'node:crypto';
import { imageGenerationConfig, imageGenerationAvailable, pendingImageContext, type ImageProposal } from './generated-images.js';
import { createMemoryStore } from './memory.js';
import { rankMemories, redactForgotten } from './memory-recall.js';
import { createConversationStore, isLongTermMemorySource } from './conversation.js';
import { searchMedia, describeMedia, MEDIA_ROOT, type CatalogCandidate } from './media-catalog.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { searchSceneReferences, describeSceneReference } from './scene-references.js';
import { createHash } from 'node:crypto';
import { createMemeClient, memeConfig, MEME_TOOL_SPEC } from './memecub.js';
import { embeddingConfig } from './embeddings.js';
import type { RecognizedMedia } from './media-recognition.js';
import { createFishingTools } from './fishing.js';
import {createCrossConversation} from './cross-conversation.js';
import {createCrossDeliveryPlans} from './cross-delivery.js';
import type {MemoryScope} from './memory-fact-store.js';

export const WECHAT_TOOL_SPECS = [
  { type: 'function', name: 'memory_recall', description: '按人物和主题检索事实、交流及实际微信原话。群聊查本群，私聊可接续双方参与过的公开群话题；需要某个群的前文可填room名称。按主体、陈述者、有效时间、计划/转述和来源判断，不按最新日期直接覆盖。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' },room:{type:'string',description:'私聊接续时可指定双方共同群的群名或ID'} }, required: ['query'], additionalProperties: false } },
  { type: 'function', name: 'character_scene', description: '查看阮阮的角色相册，按当前语境描述场景、动作或穿搭来挑照片或视频。照片和视频用于表达阮阮的角色生活，subject.relation=self表示画面里就是你。按已建立的情境选图；没有既定近况时可结合候选建立简单的角色场景，用配文表达并接续。provenance只说明文件现实来源，普通生活交流无需复述，也不否定虚构场景。默认优先未发过的，同等匹配随机；all_sent表示当前主题已用尽，可以换相关主题找，cycling表示同类型已全部发过正轮换。只有用户明确要重发某张/某段时提供replayAssetId。空查询查看其他画面。选择本轮返回的[[ASSET:编号]]交由微信发送。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string', enum: ['image', 'video'], description: '照片选image，视频选video；两者都可时省略。视频直接发送原文件，不是截帧。' },
      selection: {type:'string',enum:['match','random'],description:'具体场景用match，随便分享或换一个用random；query保留想要的主题，无主题可为空。随机推荐已由工具打散，recommendedAssetId可以直接采用。'},
      allowGeneration: {type:'boolean',description:'确实愿意分享且没有合适素材时，申请后台生成一张角色生活照片'},
      scene: {type:'string',description:'没有素材时使用的画面描述：当前地点、衣服、动作、表情；普通非露骨日常，不编造拍摄凭证'},
      caption: {type:'string',description:'图片稍后发送时附带的简短人物配文'},
      sceneReferenceId: {type:'string',description:'使用返回的店景参考编号合成人物图；不填写时按画面地点、区域和时段匹配。参考图只约束背景，不直接当作人物照片发送'},
      replayAssetId: { type: 'string', description: '用户明确要重复发送的旧素材编号；再来一张、换一张不算重发' } }, required: ['query'], additionalProperties: false } },
];
export const MEMORY_WRITE_SPEC = { type: 'function', name: 'memory_update',
  description: '处理用户明确交代的记住、更正、遗忘。当前消息给出保存或遗忘指令；事实来源可引用当前原话，明确追记时也可引用最近聊天或memory_recall找到的用户原话。remember使用facts逐项保存：每项一个主体和一个可独立删除的事实，subject用user表示本人，其他人用具体称呼如妹妹；attribute是称呼、忌口:香菜、过敏:花生等具体属性。evidence引用该事实的连续原话。名字、不同忌口、亲属分别存。纠正时复用相同主体属性；不能把原id转给别人。forget优先用已有id；事实尚未提炼成条目、只在原始聊天中时，用facts指出主体属性和真实原话也能遗忘，阻止旧聊天及向量重新召回。旧复合记录先split成独立事实再只forget目标；split只能引用旧条目来源。只有返回saved/removed才表示成功；普通闲聊由后台整理。',
  inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['remember', 'forget', 'split'] },
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' }, instruction: { type: 'string' },
    facts: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', properties: {
      id: { type: 'string' }, subject: { type: 'string' }, attribute: { type: 'string' }, evidence: { type: 'string' },
      value:{type:'string',description:'简短规范值，原话另外保留；常住地、临时所在地是不同属性'},
      assertion:{type:'string',enum:['fact','plan','reported','uncertain']},validFrom:{type:'string'},validTo:{type:'string'},
      supersedes:{type:'string',description:'确实更正同一事实时引用已检索到的事实ID；转述和计划不覆盖本人事实'},
      topics:{type:'array',items:{type:'string'},maxItems:8},stable:{type:'boolean',description:'是否长期有效的约束，如饮食限制；临时活动为false'} },
      required: ['subject', 'attribute', 'evidence'], additionalProperties: false } } },
    required: ['operation'], additionalProperties: false } };

// Registered on WeChat's own thread, never in global Codex configuration.
export function createWechatTools(accountId: string, peerId: string, options: { directory?: string; mediaRoot?: string; memoryRoot?: string; currentUser?: string; messageId?: string; messageIds?: string[]; after?: number; person?:PersonContext; roomId?:string; roomContext?:RoomSnapshot; signal?: AbortSignal } = {}) {
  const fishing = createFishingTools(accountId, options.roomId);
  const viewedImages:string[]=[];
  const recognizedMedia:RecognizedMedia[]=[];
  const recalledRoomContext:RoomSnapshot[]=[];
  let roomBefore=options.roomContext?.messages[0]?.id;
  const candidates: CatalogCandidate[] = [];
  let cross:ReturnType<typeof createCrossConversation>|undefined;
  let crossPlans:ReturnType<typeof createCrossDeliveryPlans>|undefined;
  const chatContext=options.person?{kind:options.roomId?'group' as const:'private' as const,
    conversationId:options.roomId??options.person.actorId,conversationName:options.roomId??'私聊',
    actorId:options.person.actorId,actorName:options.person.actorId}:undefined;
  if(options.person&&(options.person.platform??'wechat')==='wechat')try {
    const config=loadDesktopConfig();
    if(config.accountId===options.person.accountId) {
      cross=createCrossConversation(config);
      crossPlans=createCrossDeliveryPlans(config,chatContext!,()=>options.currentUser??'',candidates);
    }
  }catch{/* Non-desktop adapters keep their own channel capabilities. */}
  const imageRequests: ImageProposal[]=[];
  const imageConfig=imageGenerationConfig(options.directory);
  let forgotten = false;
  let memeSearches = 0;
  const externalMemeEnabled = !!memeConfig(options.directory);
  const localMemeEnabled = existsSync(join(options.mediaRoot ?? MEDIA_ROOT, '卡通形象'));
  const memeEnabled = externalMemeEnabled || localMemeEnabled;
  const memes = createMemeClient(options.directory);
  const recalledSourceIds = new Set<string>();
  function factSources(allowHistory: boolean) {
    const journal = createConversationStore(accountId, peerId, options.directory);
    const current = journal.byIds(options.messageIds ?? []);
    const boundary = current.length ? Math.max(...current.map(row => row.seq)) : journal.latestSequence();
    const rows = [...current, ...(allowHistory ? [...journal.recent(24, 'companion'), ...journal.byIds([...recalledSourceIds])] : [])];
    const forgotten = createMemoryStore(accountId, options.memoryRoot,options.person).load().forgotten ?? [];
    return rows.filter(row => isLongTermMemorySource(row) && (!options.person||!options.roomId||(row.payload as any)?.chatContext?.actorId===options.person.actorId) && row.direction === 'in' && row.profile === 'companion' && row.seq <= boundary && row.seq > (options.after ?? 0)
      && (current.some(item => item.id === row.id) || recalledSourceIds.has(row.id) || row.at > Date.now() - 30 * 60000))
      .map(row => ({ ...row, text: redactForgotten(row.text, forgotten, row.at) }));
  }
  return {
    specs: [...fishing.specs,...(crossPlans?.specs??[]), ...(options.roomId?[{type:'function',name:'media_view',description:'按需查看当前群消息中的实际图片或图片表情包。id来自群上下文的media.id或replyTo.media.id。引用指向原图，不是新发了一张图。需要小字或细节时可用detail=true或crop=[x,y,width,height]（0至1比例）看局部；未知图片不猜测。',inputSchema:{type:'object',properties:{id:{type:'string'},detail:{type:'boolean'},crop:{type:'array',items:{type:'number',minimum:0,maximum:1},minItems:4,maxItems:4}},required:['id'],additionalProperties:false}}]:[]), ...WECHAT_TOOL_SPECS.map(spec=>spec.name==='character_scene' && imageConfig ? {...spec,description:spec.description+' 当前已启用异步生图：愿意分享且没有合适照片时用allowGeneration=true，并附scene画面描述、caption配文；优先素材，后台生成不阻塞文字。杂货店的收银台、货架通道、杯子区、门面有固定店景参考，会返回sceneReferences；可用sceneReferenceId明确选择，或在scene说明区域、时段后自动匹配。返回generation_proposed后在状态imageRequestId确认。'} : spec), ...(memeEnabled ? [MEME_TOOL_SPEC] : []), ...(options.currentUser === undefined ? [] : [MEMORY_WRITE_SPEC])], candidates, imageRequests, viewedImages,
    get crossDeliveries(){return crossPlans?.plans;},
    recalledRoomContext, recognizedMedia, fishingEvidence: fishing.evidence,
    get forgotten() { return forgotten; },
    appendUser(text: string, ids: string[] = []) {
      options.currentUser = [options.currentUser, text].filter(Boolean).join('\n');
      options.messageIds = [...(options.messageIds ?? []), ...ids];
    },
    async call(name: string, args: any): Promise<unknown> {
      if(name==='conversation_target'||name==='conversation_send') {
        if(!crossPlans)throw Error('当前入口没有跨会话发送能力');
        return crossPlans.call(name,args);
      }
      if (name === 'fishing_knowledge' || name === 'fishing_weather' || name === 'fishing_assess') return fishing.call(name, args);
      if(name==='media_view') {
        if(!options.roomId||typeof args?.id!=='string')throw Error('需要当前群的消息id');
        const result=await viewRoomMedia(loadDesktopConfig().queueDirectory,options.roomId,args.id,{detail:args.detail,crop:args.crop});
        if(result.path&&!viewedImages.includes(result.path))viewedImages.push(result.path);
        recognizedMedia.push(...(result.recognition??[]));
        return result;
      }
      if (name === 'meme_search') {
        if (!memeEnabled) return { status: 'disabled', candidates: [] };
        if (++memeSearches > 2) return { status: 'turn_limit', candidates: [], instruction: '这轮不用继续搜索，可以自然说话。' };
        if (typeof args?.query !== 'string' || !args.query.trim() || args.query.length > 80) throw new Error('表情包查询需要80字以内的简短意图');
        if (args.source !== undefined && !['auto','local','api'].includes(args.source)) throw new Error('不支持的表情来源');
        if (localMemeEnabled && args.source !== 'api') {
          const local = searchMedia(args.query, accountId, { kind: 'image', purpose: 'reaction', allowRepeat: true }, options.mediaRoot, options.directory);
          if (local.candidates.length || !externalMemeEnabled || args.source === 'local') {
            candidates.push(...local.candidates);
            return { status: local.status, source: 'local_character_reactions', candidates: local.candidates.map(describeMedia) };
          }
        }
        if(args.source === 'local') return {status:'empty', candidates:[]};
        const found = await memes.search(args?.query, accountId);
        candidates.push(...found.candidates);
        return { ...found, candidates: found.candidates.map(describeMedia) };
      }
      if (name === 'memory_update') {
        // The host already has the actual user message. Do not ask the model
        // to retype that authorization verbatim and reject harmless paraphrases.
        if (!options.currentUser || !args) throw new Error('需要本轮用户的真实消息');
        if (args.operation === 'forget' && !/忘|别记|删除|不要存|不再记/u.test(options.currentUser)) throw new Error('需要本轮用户明确的遗忘交代');
        const memory = createMemoryStore(accountId, options.memoryRoot,options.person);
        if(options.roomId&&options.person&&args.id&&args.operation!=='remember') {
          const note=memory.load().notes.find(n=>n.id===args.id);
          const own=memory.factContext.ownSubject;
          const fact=memory.factContext.store.get(args.id,{scope:memory.factContext.scope});
          const allowed=fact&&(fact.subjectId===own||fact.sources.every(row=>row.speakerId===own));
          if(!allowed&&(!note?.fact||memory.factContext.subject(note.fact.subject)!==own))throw Error('只能更改自己的事实或自己提供的转述记录');
        }
        if (args.operation === 'split') {
          return { saved: true, notes: memory.splitFact(args.id, args.facts), instruction: '已拆分，尚未遗忘任何项。只删除用户指定的目标新id，其他项保留。' };
        }
        if (args.operation === 'forget') {
          if (args.facts) {
            const ids = memory.forgetFacts(args.facts, factSources(true)); forgotten = true;
            return { removed: true, ids };
          }
          if (typeof args.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(args.id)) throw new Error('forget需要先查到现有记忆id');
          const note = memory.load().notes.find(note => note.id === args.id);
          if (note?.kind === 'fact' && !note.fact && !options.currentUser.includes(note.text)) return {
            removed: false, status: 'split_required', notes: [note],
            instruction: '这是旧复合记录，不能按整条删除。先split为有来源的独立事实，再只forget指定目标；不能声称已经删除。' };
          const removed = memory.forget(args.id); forgotten ||= removed;
          return { removed, id: args.id };
        }
        if (args.operation === 'remember' && args.facts) {
          const sources = options.messageIds?.length
            ? factSources(/记住|记得|记下来|别忘|保存|保留/u.test(options.currentUser))
            : [{ id: options.messageId ?? 'explicit-user-request', seq: 0, at: Date.now(), direction: 'in' as const, text: options.currentUser, payload: {} }];
          for (const fact of args.facts) if (typeof fact.evidence !== 'string' || !sources.some(row => row.text.includes(fact.evidence))) throw new Error('事实必须引用已确认的用户原话');
          return { saved: true, notes: memory.rememberFacts(args.facts, sources) };
        }
        // Compatibility for already registered native tool schemas. New threads
        // expose only the atomic facts contract above, not this legacy argument.
        if (args.operation !== 'remember' || typeof args.evidence !== 'string' || !args.evidence.trim()
          || args.evidence.length > 1000 || !options.currentUser.includes(args.evidence)) throw new Error('记忆内容必须来自本轮原话');
        // A partial correction needs a stable target. Without this contract a
        // fluent reply can conceal a second, disconnected note whose subject
        // and unchanged details will be lost in a later independent session.
        if (/纠正|更正|改(?!天)/u.test(options.currentUser)) {
          const facts = memory.load().notes.filter(note => note.kind === 'fact');
          if (!facts.some(note => note.id === args.id)) {
            const related = memory.recall(`${args.instruction} ${args.evidence}`).filter(note => note.kind === 'fact');
            return { saved: false, status: 'correction_requires_existing_id',
              notes: (related.length ? related : facts).slice(0, 5),
              instruction: '本次尚未保存。更正必须指定原有事实id，复用原条目后再调用；不能把没有完整主题的更正片段新建成独立事实。若没有对应原条目，先查旧事或向用户澄清，不声称已改好。' };
          }
        }
        const id = args.id || `fact_${createHash('sha256').update(args.evidence).digest('hex').slice(0, 20)}`;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('记忆id格式错误');
        const source = options.messageIds?.length ? createConversationStore(accountId, peerId, options.directory).recent(100, 'companion')
          .find(row => isLongTermMemorySource(row) && options.messageIds!.includes(row.id) && row.direction === 'in' && row.text.includes(args.evidence)) : undefined;
        if (options.messageIds?.length && !source) throw new Error('evidence需要引用本轮某一条微信消息中的完整原句');
        memory.remember(id, args.evidence, source?.id ?? options.messageId ?? 'explicit-user-request', source?.at);
        return { saved: memory.load().notes.some(note => note.id === id && note.text === args.evidence), id };
      }
      if (!args || typeof args.query !== 'string' || args.query.length > 2000) throw new Error('查询必须是2000字以内的文本');
      if (name === 'memory_recall') {
        let roomHistory:RoomSnapshot|undefined;
        if(options.roomId) {
          const identities=createIdentityStore(options.memoryRoot);
          const rooms=createRoomStore(options.directory??loadDesktopConfig().queueDirectory,
            (actorId,roomId)=>options.person?identities.view({platform:'wechat',channelAccountId:options.person.accountId,actorId},roomId):undefined);
          const snapshot=rooms.history(options.roomId,args.query,roomBefore);
          if(!args.query.trim()&&snapshot.messages.length)roomBefore=snapshot.messages[0].id;
          recalledRoomContext.push(snapshot);
          roomHistory=snapshot;
        }
        const memory = createMemoryStore(accountId, options.memoryRoot,options.person);
        const state = memory.load();
        const forgotten = state.forgotten ?? [];
        const config = embeddingConfig(options.directory);
        let semantic;
        try { semantic = await memory.semantic(peerId, options.after, options.directory).search(args.query, { config, signal: options.signal, force: true }); }
        catch { semantic = { status: 'lexical_fallback', hits: [] }; }
        const publicContext=cross&&chatContext&&!options.roomId?cross.publicContext({context:chatContext,query:args.query,room:args.room}):undefined;
        const scopes:MemoryScope[]=cross&&chatContext&&!options.roomId?cross.sharedGroups(chatContext).map(row=>row.scope):[];
        const messages = createConversationStore(accountId, peerId, options.directory).search(args.query, 'companion')
          .map(row => {
            const text = redactForgotten(row.text, forgotten, row.at);
            return { ...row, text, ...(text !== row.text ? { payload: undefined } : {}) };
          });
        for (const row of messages) recalledSourceIds.add(row.id);
        for (const doc of semantic?.hits ?? []) for (const id of doc.sourceIds) recalledSourceIds.add(id);
        return { semantic,roomHistory,publicContext, facts:memory.recallFacts(args.query,scopes),
          notes: memory.recall(args.query).filter(note => note.kind !== 'task'),
          ownLife: memory.life.recall(args.query),
          handoff: rankMemories(state.handoff ? [{ id: 'handoff', kind: 'task', text: state.handoff }] : [], args.query)
            .slice(0, 1).map(row => ({ text: row.text.slice(0, 4000), source: 'saved_summary', delivery: 'legacy_not_verified' })),
          history: memory.searchHistory(args.query),
          messages: messages.map(row => ({ id: row.id, at: row.at, direction: row.direction, text: row.text.slice(0, 4500), payload: row.payload })) };
      }
      if (name === 'character_scene') {
        if (args.kind !== undefined && !['image', 'video'].includes(args.kind)) throw new Error('不支持的素材类型');
        if (args.selection !== undefined && !['match','random'].includes(args.selection)) throw new Error('不支持的素材选择方式');
        if (args.sceneReferenceId !== undefined && (typeof args.sceneReferenceId !== 'string' || !/^rr_scene_[a-z0-9_]+$/u.test(args.sceneReferenceId))) throw new Error('场景参考编号无效');
        if (args.replayAssetId !== undefined && (typeof args.replayAssetId !== 'string'
          || !/^rr_(?:image|video)_\d+$/.test(args.replayAssetId)
          || !/重发|再发.{0,12}(?:遍|次|刚才|上次|那张|那段|同一)|(?:刚才|上次|那张|那段|同一).{0,12}(?:再|发)|原图|原视频/u.test(options.currentUser ?? ''))) {
          throw new Error('只有当前用户明确要求重发原图或原视频时才能使用replayAssetId');
        }
        const referenceQuery = [args.query, args.scene].filter(Boolean).join(' ');
        const references = args.kind === 'video' ? [] : searchSceneReferences(referenceQuery,
          { referenceId: args.sceneReferenceId, size: imageConfig?.size }, options.mediaRoot);
        const reference = args.sceneReferenceId || referenceQuery.trim() ? references[0] : undefined;
        const sceneReferences = references.map(describeSceneReference);
        const found = searchMedia(args.query, accountId, { kind: args.kind, selection: args.selection, sceneReferenceId: reference?.reference_id,
          allowRepeat: !!args.replayAssetId, assetId: args.replayAssetId }, options.mediaRoot, options.directory);
        candidates.push(...found.candidates);
        if (args.allowGeneration && imageConfig && !found.candidates.length && !imageRequests.length
          && args.kind !== 'video' && ['no_match','empty','all_sent'].includes(found.status)) {
          const pending=pendingImageContext(accountId,peerId,options.directory).find(task=>['queued','generating','ready'].includes(task.status));
          if(pending)return {status:'generation_pending',task:pending,instruction:'已有这张尚未发送的图片，不重复申请，也不要声称已经送达。'};
          if(!imageGenerationAvailable(imageConfig,options.directory))return {status:'generation_unavailable',instruction:'这次不能添加新画面，不承诺马上发图，可继续当前聊天。'};
          if(typeof args.scene!=='string'||!args.scene.trim()||args.scene.length>600
            ||typeof args.caption!=='string'||args.caption.length>120)throw Error('生成图片需要简短场景与配文');
          const request={id:randomUUID(),query:args.query,scene:args.scene,caption:args.caption,
            ...(reference ? { sceneReferenceId: reference.reference_id } : {})};imageRequests.push(request);
          return {status:'generation_proposed',requestId:request.id,scene:request.scene,
            ...(reference ? { sceneReference: describeSceneReference(reference) } : {}),
            instruction:'尚未生成或发送。若决定要这张，在本轮状态写imageRequestId。文字可继续聊天，图片后台完成后另发；不得声称已拍摄或已送达。本轮至多一个媒体。'};
        }
        // The catalog also contains ingestion/review instructions, paths and
        // source filenames. Expose a deliberate scene schema, not the raw row.
        // Full rows stay internal for validating the eventual delivery.
        return { status: found.status, totalCount: found.totalCount, matchingCount: found.matchingCount,
          ...(sceneReferences.length ? { sceneReferences } : {}),
          remainingCount: found.remainingCount, provenance: { type: 'prepared_media', liveCapture: false },
          recommendedAssetId: found.candidates[0]?.asset_id, candidates: found.candidates.map(describeMedia) };
      }
      throw new Error('未知的微信工具');
    },
  };
}
