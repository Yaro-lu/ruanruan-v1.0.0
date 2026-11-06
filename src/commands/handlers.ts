import type { CommandContext, CommandResult } from './router.js';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { scanAllSkills, findSkill, type SkillInfo } from '../codex/skill-scanner.js';
import { isReasoningEffort, REASONING_LEVELS } from '../reasoning.js';
import { loadConfig } from '../config.js';
import { createMemoryStore, createWorkMemoryStore } from '../memory.js';
import { workSession } from '../session.js';
import { loadPersonaSnapshot } from '../persona.js';
import { readJob, sessionJobId } from '../jobs.js';
import { DEFAULT_PROFILE, COMPLEX_PROFILE, chooseRoute, type RoutingDecision } from '../routing.js';
import { conversationOptions } from '../companion-profile.js';
import { createLifeStore } from '../character-life.js';

const HELP_TEXT = `可用命令：

  /help             显示帮助
  /Q                阮阮／普通AI助手切换
  /update-cli       独立更新 CLI（失败回退）
  /progress         查看任务进度
  /stop             停止任务并暂停队列
  /resume           接回任务／核查现场后继续
  /clear            新开会话（保留长期记忆）
  /model <名称>     切换 Codex 模型
  /effort <强度>    手动指定推理强度
  /auto             清除手动选档，恢复部署默认规则
  /cwd <路径>       切换工作目录
  /mode <模式>      切换执行模式
  /status           查看当前会话状态
  /memory [ID]      查看长期记忆和来源
  /persona          查看实际人格版本和参与文件
  /forget <ID>      删除一条长期记忆
  /skills           列出已安装的 skills
  /<skill> [参数]   触发已安装的 skill

直接输入文字即可与本机 Codex 对话`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string, entryRole?: CommandContext['entryRole']): CommandResult {
  return { reply: entryRole === 'control'
    ? 'Codex 服务器助手\n\n' + HELP_TEXT.split('\n').filter(line => !/^\s+\/(?:Q|persona)\s/u.test(line)).join('\n')
    : HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 下次消息将开始新会话，近期聊天已归档，长期记忆和待办保留，推理强度恢复默认。', handled: true };
}

export function handleEffort(ctx: CommandContext, args: string): CommandResult {
  const level = args.trim().toLowerCase();
  if (!level) return { handled: true, reply: `当前推理强度: ${ctx.session.reasoningEffort ?? loadConfig().reasoningEffort ?? 'medium'}\n用法: /effort ${REASONING_LEVELS.join('|')}\n切换仅影响当前会话，/clear 恢复默认；可用强度取决于模型。` };
  if (!isReasoningEffort(level)) return { handled: true, reply: `未知推理强度: ${level}\n可用: ${REASONING_LEVELS.join(', ')}` };
  ctx.updateSession({ reasoningEffort: level });
  return { handled: true, reply: `✅ 推理强度已切换为 ${level}，从下一条消息生效；保留当前对话。/clear 恢复默认强度。` };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model gpt-5.4', handled: true };
  }
  ctx.updateSession({ model: args, threadId: undefined });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

function expandUserPath(input: string): string {
  if (input.startsWith('~/')) {
    return resolve(homedir(), input.slice(2));
  }
  if (input === '~') {
    return homedir();
  }
  return resolve(input);
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /cwd <目录路径>', handled: true };
  }
  const nextPath = expandUserPath(args.trim());
  if (!existsSync(nextPath)) {
    return { reply: `目录不存在: ${nextPath}`, handled: true };
  }
  if (!statSync(nextPath).isDirectory()) {
    return { reply: `不是目录: ${nextPath}`, handled: true };
  }
  ctx.updateSession({ workingDirectory: nextPath, threadId: undefined });
  return { reply: `✅ 工作目录已切换为: ${nextPath}\n已重置会话线程，新目录会在下一条请求生效。`, handled: true };
}

const MODE_DESCRIPTIONS: Record<string, string> = {
  plan: '只读分析模式',
  workspace: '工作区可写模式',
  danger: '无沙箱模式',
};

export function handleMode(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.mode ?? loadConfig().mode ?? 'workspace';
    const lines = [
      '🔒 当前执行模式: ' + current,
      '',
      '可用模式:',
      ...Object.entries(MODE_DESCRIPTIONS).map(([mode, desc]) => `  ${mode} — ${desc}`),
      '',
      '用法: /mode <模式>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim().toLowerCase();
  if (!(mode in MODE_DESCRIPTIONS)) {
    return {
      reply: `未知模式: ${mode}\n可用: ${Object.keys(MODE_DESCRIPTIONS).join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ mode: mode as any, threadId: undefined });
  const warning = mode === 'danger' ? '\n\n⚠️ danger 模式会以无沙箱方式运行本机 Codex。' : '';
  return { reply: `✅ 执行模式已切换为: ${mode}\n${MODE_DESCRIPTIONS[mode]}\n已重置会话线程，新模式会在下一条请求生效。${warning}`, handled: true };
}

export function handlePermissionAlias(): CommandResult {
  return {
    handled: true,
    reply: 'Codex bridge 不支持 Claude SDK 那种逐工具权限回调。请使用 /mode plan|workspace|danger 控制执行级别。',
  };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const control = ctx.entryRole === 'control';
  const s = control ? workSession(ctx.session) : ctx.session;
  const config = loadConfig();
  const mode = s.mode ?? config.mode ?? 'workspace';
  const automatic = config.autoRouting && !s.model && !s.reasoningEffort;
  const taskId = sessionJobId(s, control);
  let recent: RoutingDecision | undefined;
  try { if (taskId) recent = readJob(taskId).routing; } catch { /* no saved request */ }
  const profile = (p: RoutingDecision['options']) => `${p.model ?? '默认'} / ${p.reasoningEffort ?? 'medium'} / Fast ${p.serviceTier === 'fast' ? '开启' : '关闭'}`;
  const reasons: Record<string, string> = { 'explicit-modification': '本轮要求实际修改', 'modification-followup': '继续修改任务',
    'read-only-request': '只读查询或分析', 'ordinary-request': '日常交流', 'task-cancelled-or-topic-changed': '取消任务或切换话题',
    'explicit-session-setting': '手动指定', 'routing-disabled': '自动路由未启用' };
  const life = control ? undefined : createLifeStore().usage();
  const lines = [
    '📊 会话状态',
    '',
    control ? '对话入口: Codex 服务器助手（固定工作入口）' : `对话入口: ${s.chatMode === 'assistant' ? '普通AI助手' : '阮阮'}（仅 /Q 切换）`,
    ...(life ? [`生活心跳: ${life.provider} / ${life.model} / medium / 标准速度；每7分钟检查，每天最多24次生活调用；今日 ${life.attempts.length} 次`] : ['执行后端: 本机 Codex；记忆范围: 独立工作记录']),
    `工作目录: ${s.workingDirectory}`,
    `路由: ${automatic ? '自动（按是否实际修改）' : '固定或手动设置'}`,
    ...(automatic ? [...(control ? [] : [`日常聊天: ${profile(conversationOptions(chooseRoute('', s, config), 'companion'))}`]),
      `只读工作: ${profile(DEFAULT_PROFILE)}`, `实际修改: ${profile(COMPLEX_PROFILE)}`]
      : [`固定配置: ${profile(chooseRoute('', s, config).options)}`]),
    ...(recent ? [`${s.activeJobId || s.workJobId ? '当前' : '最近'}请求: ${profile(recent.options)}`, `选择原因: ${reasons[recent.reason] ?? recent.reason}`] : []),
    `执行模式: ${mode}`,
    `线程ID: ${s.threadId ?? '无'}`,
    ...(!control ? [`工作线程: ${s.workContext?.threadId ?? '无'}`] : []),
    `状态: ${s.state}`,
    `任务: ${taskId ?? '无'}`,
    `队列: ${s.queuePaused ? '暂停，/resume 恢复' : '正常'}`,
    `本线程已处理: ${s.memoryTurns ?? 0} 轮（无轮数上限）`,
    `上轮输入用量参考: ${s.contextTokens ?? '未知'} token（不用于强制换线程）`,
    `会话续接: ${s.rotateBeforeNext ? '上次任务异常，下一条消息交接恢复' : '持续使用当前线程，上下文由 Codex 自动管理'}`,
    `最近交接: ${s.lastHandoffAt ?? '无'}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleMemory(ctx: CommandContext, args: string): CommandResult {
  const all = commandMemory(ctx).load().notes;
  const notes = args ? all.filter(note => note.id === args.trim()) : all.slice(0, 20);
  if (!notes.length) return { handled: true, reply: args ? '没有找到这条记忆。' : '目前没有长期记忆。' };
  const labels = { fact: '用户原话/事实', task: '实际任务', exchange: '共同交流记录', character: '人物日常（虚构）', observation: '暂时观察（未确认）' };
  const lines = notes.map(note => `[${note.id}] ${labels[note.kind]}\n${note.text.slice(0, args ? 2000 : 280)}\n来源时间：${note.source?.at ?? note.updatedAt}${note.source ? `；${note.source.speaker}` : '；既有记录，未补造原话来源'}${note.expiresAt ? `\n观察有效期：${note.expiresAt}` : ''}`);
  return { handled: true, reply: `长期记忆 ${all.length} 条${!args && all.length > 20 ? '，显示前20条；用 /memory ID 查看指定记录' : ''}\n\n${lines.join('\n\n')}\n\n可直接纠正内容，或用 /forget ID 删除。` };
}

export function handlePersona(ctx: CommandContext): CommandResult {
  if (ctx.entryRole === 'control') return { handled: true, reply: '服务器助手直接连接本机 Codex，使用独立工作记录，不加载人物提示词或关系记录。' };
  const snapshot = loadPersonaSnapshot(false);
  if (!snapshot) return { handled: true, reply: '微信入口当前没有自定义人格。' };
  let lastVersion: string | undefined;
  try {
    if (ctx.session.lastJobId) lastVersion = readJob(ctx.session.lastJobId).options?.personaContext?.version;
  } catch { /* Older task records can have been cleared by the owner. */ }
  return { handled: true, reply: `当前人格：${snapshot.version}\n配置指纹：${snapshot.fingerprint.slice(0, 12)}\n参与文件：\n${snapshot.files.map(file => `- ${file.name}`).join('\n')}\n最近请求加载版本：${lastVersion ?? '尚无带版本记录的请求'}\n人格核心每轮进入调用；相关记忆和状态另外按需组装。` };
}

export function handleForget(ctx: CommandContext, args: string): CommandResult {
  const id = args.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) return { handled: true, reply: '用法：/forget ID；可用 /memory 查看记忆ID。' };
  if (!commandMemory(ctx).forget(id)) return { handled: true, reply: '没有找到这条记忆。' };
  ctx.updateSession(ctx.entryRole === 'control' || ctx.session.chatMode === 'assistant'
    ? { workContext: undefined } : { threadId: undefined, developerInstructionsHash: undefined });
  return { handled: true, reply: '已删除这条长期记忆并清除相关会话缓存，下一条消息从保留的记忆接续。原聊天存档仍保留。' };
}

function commandMemory(ctx: CommandContext) {
  return ctx.entryRole === 'control' || ctx.session.chatMode === 'assistant'
    ? createWorkMemoryStore(ctx.accountId) : createMemoryStore(ctx.accountId);
}

export function handleSkills(): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }
  const lines = skills.map(s => `/${s.name} — ${s.description}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args
      ? `Use the ${skill.name} skill for this request: ${args}`
      : `Use the ${skill.name} skill for the user's request.`;
    return { handled: true, codexPrompt: prompt };
  }

  return {
    handled: true,
    reply: `未找到 skill: ${cmd}\n输入 /skills 查看可用列表`,
  };
}
