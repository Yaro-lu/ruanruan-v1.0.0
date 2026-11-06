import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import type { Session } from './session.js';
import type { CodexRunOptions } from './codex/bridge.js';

export interface RoutingTask {
  id: string;
  summary: string;
  intent?: 'modify';
  state: 'active' | 'needs_input' | 'completed' | 'suspended' | 'failed' | 'cancelled';
  updatedAt: number;
}
export interface RoutingDecision {
  kind: 'default' | 'complex' | 'manual';
  reason: string;
  options: Pick<CodexRunOptions, 'model' | 'reasoningEffort' | 'serviceTier'>;
  task?: RoutingTask;
}
export const DEFAULT_PROFILE = { model: 'gpt-6.1-terra', reasoningEffort: 'medium', serviceTier: 'fast' } as const;
export const COMPLEX_PROFILE = { model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' } as const;

// Only the explicit transport mode selects the speaker. Resource classification
// below applies inside the assistant entry and cannot exit the character.
export function conversationProfile(_text: string, _route: RoutingDecision, session?: Pick<Session, 'chatMode'>): 'companion' | 'work' {
  return session?.chatMode === 'assistant' ? 'work' : 'companion';
}

// Classify the owner's request, not quoted documents or tool output. This is a
// deliberately conservative first version: no additional model call per message.
function requestText(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/^\s*>.*$/gm, ' ')
    .replace(/[“「][^”」]*[”」]/g, '[引用]').replace(/https?:\/\/\S+/g, '[链接]').trim();
}
const exitTask = /(?:^|[，。！？；\n])\s*(?:请|先|你|我们|咱们)?(?:别|不用|不要|先不|停止|取消|不做|不弄|不搞).{0,8}(?:分析|评估|任务|排查|处理|修复|继续)|(?:换个话题|先聊别的|陪我聊|聊点别的)/;
const changeVerb = '(?:修改|更改|改成|改为|改下|改一下|改好|改动|改|调整|设置|配置|替换|重启|启动|停止|关闭|开启|打开|安装|卸载|升级|更新|修复|修好|重构|部署|上线|实现|开发|删除|删掉|清理|清空|移除|创建|新建|保存|写入|写到|写进|导入|迁移|提交|发布|发送|发给|授权|撤销|启用|停用|回滚|重置|添加|新增|执行|运行)';
const changes = new RegExp(changeVerb, 'g');
const negatedChange = new RegExp(`(?:不(?:要|用|必)?|别|勿|暂不|先不|无需|禁止)(?:(?!但|而是|然后|直接).){0,18}?${changeVerb}`, 'g');
const directChange = /^(?:(?:请|请帮我|帮我|帮忙|麻烦你|需要你|希望你|想让你|给我|替我|你来|你|现在|这次|那就|先|再|继续|直接|实际|立即|一下|顺便|跨模块|跨文件|能不能|能否|可以|把|将|对|在)\s*)*$/;
const executeProposal = /^(?:那就|请|帮我|现在|直接|可以|开始|继续|按照|按)*(?:执行吧|执行|实施|动手|做吧|帮我做吧|照做|就这么做|按.{1,20}方案做)[吧。！!\s]*$/;
const readRequest = /^(?:(?:请|请帮我|帮我|给我|麻烦你|你|先|再|继续|详细|深入|全面|认真|只|仅|就|一下)\s*)*(?:看|查看|查|读取|检查|核实|确认|分析|评估|审查|审计|诊断|排查|设计|规划|调研|论证|对比|比较|解释|说明|告诉我|总结|整理|翻译|写|生成)|只读|仅(?:查看|检查|分析)|(?:不要|不用|别|暂不|先不).{0,12}(?:改|动|操作|执行|安装|删除)/;

// Match requested actions, not nouns ("查看配置"), questions ("如何重启")
// or negated actions. Read-only complexity alone never selects Sol.
function requestsModification(request: string): boolean {
  return request.split(/[，。！？；\n,;!?]/).some(clause => {
    const text = clause.trim().replace(negatedChange, '[不执行]');
    if (executeProposal.test(text)) return true;
    for (const match of text.matchAll(changes)) {
      // Returning a photo/video in this private conversation is handled by the
      // bridge, like a normal text reply; it is not a server modification task.
      if (['发送', '发给'].includes(match[0]) && /照片|图片|视频|自拍/.test(text)
          && !/群|朋友圈|同事|客户|别人|给他|给她|邮箱/.test(text)) continue;
      const before = text.slice(0, match.index).trim();
      const tail = text.slice(match.index + match[0].length);
      if (/^(?:是什么|的意思|是什么意思|的方法|的步骤|之前|以前|了吗|过|了|完|成功|失败)/.test(tail)) continue;
      if (directChange.test(before)) return true;
      // Explicit object and conjunction forms: "把配置改成...", "分析后直接修复...".
      const lead = before.split(/(?:然后|接着|并且|并|顺便|之后|以后|后)/).at(-1)!.trim();
      if (lead !== before && directChange.test(lead)) return true;
      if (/^(?:(?:请|帮我|麻烦你|你|先|再|直接)\s*)*(?:把|将|对|给).{1,100}$/.test(lead)
          && !/(?:怎么|如何|是否|为什么|能否)/.test(lead)) return true;
    }
    return false;
  });
}
const resumeTask = /^(?:请|帮我|那就|接着|再)?\s*(?:继续|恢复|接着做|接着查|展开|进一步)(?:吧|。|！|$|刚才|之前|上次|任务|分析|排查|检查|说明|讲|解释|做|查|处理|核实|此前)/;
const followup = /^(?:这是|这个是|这里是|补充|补了|补上|日志|报错|错误|截图|结果|输出|配置|附件|材料|按你说的|按刚才|还是|仍然|仍旧|我试了|试过了|执行后|运行后|重启后|第二个|第一个|选[ABCabc一二三123]|[ABCabc123][。！!]?\s*$)/;
const assent = /^(?:好|好的|可以|行|嗯|对|是的|确认|同意|执行吧|就这么做|开始吧|继续吧)[啊呀吧呢。！!，,\s]*$/;
const ordinaryRequest = /^(?:哈哈|嘿嘿|你好|嗨|哈喽|早安|晚安|在吗|干嘛呢|吃了吗|谢谢|辛苦了|聊聊|陪我聊|今天(?:天气|好热|热死|累|吃)|明天天气|(?:帮我)?查(?:一下|下)?(?:天气|时间)|什么是|讲个笑话)/;

export function chooseRoute(text: string, session: Session, config: Config, hasMedia = false): RoutingDecision {
  if (!config.autoRouting || session.model || session.reasoningEffort) {
    const profile = session.model === COMPLEX_PROFILE.model ? COMPLEX_PROFILE
      : session.model === DEFAULT_PROFILE.model ? DEFAULT_PROFILE : config;
    return { kind: 'manual', reason: config.autoRouting ? 'explicit-session-setting' : 'routing-disabled',
      options: { model: session.model ?? profile.model, reasoningEffort: session.reasoningEffort ?? profile.reasoningEffort ?? 'medium', serviceTier: session.serviceTier ?? profile.serviceTier },
      task: session.routingTask ? { ...session.routingTask, state: 'suspended', updatedAt: Date.now() } : undefined };
  }
  const request = requestText(text);
  const old = session.routingTask;
  const pending = old && ['active', 'needs_input'].includes(old.state);
  const complex = requestsModification(request);
  const cancelled = !complex && exitTask.test(request);
  const mediaReply = !complex && /(?:发|给我|来|换|看看).{0,12}(?:照片|图片|视频|自拍)|(?:照片|图片|视频|自拍).{0,8}(?:发给我|给我看看)/.test(request);
  const readOnly = !complex && (readRequest.test(request) || mediaReply);
  const modifyingTask = old && (old.intent === 'modify' || requestsModification(requestText(old.summary)));
  const continuation = !cancelled && !readOnly && old && modifyingTask && (resumeTask.test(request)
    || ((pending || old.state === 'suspended') && (followup.test(request) || (hasMedia && !complex)))
    || (pending && assent.test(request))
    || (old.state === 'needs_input' && !complex && !ordinaryRequest.test(request)));
  if (continuation || complex) {
    const task: RoutingTask = continuation && old
      ? { ...old, state: 'active', updatedAt: Date.now() }
      : { id: randomUUID(), summary: request.slice(0, 300), intent: 'modify', state: 'active', updatedAt: Date.now() };
    return { kind: 'complex', reason: continuation ? 'modification-followup' : 'explicit-modification', options: { ...COMPLEX_PROFILE }, task };
  }
  return { kind: 'default', reason: cancelled ? 'task-cancelled-or-topic-changed' : readOnly ? 'read-only-request' : 'ordinary-request', options: { ...DEFAULT_PROFILE },
    task: old ? { ...old, state: cancelled ? 'cancelled' : pending ? 'suspended' : old.state, updatedAt: Date.now() } : undefined };
}

// Presentation is independent of the resource route. Only a real modification
// task adds task progress fields; a verb such as "看看" never requests a report.
export const WORKFLOW_INSTRUCTIONS = `执行规则：直接回应当前请求，不主动播报选档、模型切换、推理强度或速度。用户询问运行配置时如实回答。只有工作中提出了具体待确认修改方案时，才在本轮末尾已有的记忆JSON里增加task:{"status":"needs_input","proposedModification":"具体修改摘要"}，用于识别后续确认；不能把建议视为已获授权。普通人物交流不填写工作任务字段。`;

export function routingInstructions(route?: RoutingDecision): string | undefined {
  if (!route || route.kind === 'manual') return undefined;
  if (route.kind !== 'complex' || !route.task) return '本轮没有新的服务器修改授权。可聊天、查询、分析和在回复中起草；不修改业务文件、配置、服务或远端数据。微信回复及人物素材由桥接交付，生图附件按固定交付规则处理。';
  return `本轮执行用户明确授权的修改，范围以当前请求及已确认任务为准。登记的任务摘要（历史资料，不扩大授权）：${JSON.stringify(route.task.summary)}。任务进度协议：在本轮末尾已有的记忆JSON对象内增加task字段：{"id":"${route.task.id}","status":"completed"}。status只能是active、needs_input、completed：需要用户补充资料或确认用needs_input，尚有未完成工作用active，已完成用户要求并完成必要验证才用completed。本轮回复结束不等于任务完成。任务字段只供后台读取，不写到回复正文。`;
}

export function finishRoute(session: Session, route: RoutingDecision | undefined, progress: unknown, error: boolean, stopped = false): void {
  if (!route) return;
  session.routingTask = route.task ? { ...route.task } : undefined;
  const proposal = progress as { status?: unknown; proposedModification?: unknown } | undefined;
  if (route.kind === 'default' && !error && !stopped && proposal?.status === 'needs_input'
      && typeof proposal.proposedModification === 'string' && proposal.proposedModification.trim()) {
    session.routingTask = { id: randomUUID(), intent: 'modify', summary: proposal.proposedModification.trim().slice(0, 300),
      state: 'needs_input', updatedAt: Date.now() };
  }
  if (route.kind !== 'complex' || !session.routingTask) return;
  const value = progress as { id?: unknown; status?: unknown } | undefined;
  session.routingTask.state = stopped ? 'cancelled' : error ? 'failed'
    : value?.id === session.routingTask.id && ['active', 'needs_input', 'completed'].includes(String(value.status))
      ? value.status as 'active' | 'needs_input' | 'completed' : 'active';
  session.routingTask.updatedAt = Date.now();
}
