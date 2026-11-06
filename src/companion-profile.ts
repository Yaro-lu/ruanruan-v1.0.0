import { readGenerationSection } from './persona.js';

// Character behavior is authored in GENERATE.md; these aliases keep existing
// evaluation utilities reading the same source instead of another policy copy.
export const COMPANION_BASE = '接续本轮生成提示词定义的人物微信对话，输出角色正文和约定的内部接续数据。';
export const CHARACTER_PERSPECTIVE_CONTRACT = readGenerationSection(['核心任务与输出铁律', '身份与交流约定']);
export const CHARACTER_VOICE_CONTRACT = readGenerationSection(['微信语感与群聊', '表达方式']);
export const CHARACTER_SCENE_CONTRACT = readGenerationSection(['记忆、媒体与工具', '生活与画面']);
export function characterDialogueInput(text: string, supplement = false, groupSpeaker?:{actorId:string;actorName:string}) {
  if(groupSpeaker)return `【${supplement?'群里刚补充的消息':'本轮关注的群消息'}】\n${JSON.stringify({speaker:groupSpeaker.actorName,speakerId:groupSpeaker.actorId,text})}\n这是群里的公开发言，不默认对阮阮说。先结合公开上下文、提及和引用判断在与谁接话；若在接别人的话，不替被问的人回答，也不解释自己做不到。确有自己的话才插话，不确定或没有想说的就按协议quiet。`;
  return `【${supplement ? '对方刚补充的台词，与本轮一起接续' : '本轮待接续的对话'}】\n${JSON.stringify({ speaker: '对方', text })}\n按本轮生成提示词接续下一轮微信台词，并沿用内部接续协议。`;
}

import type { RoutingDecision } from './routing.js';
import { loadCharacterModels } from './character-models.js';
import type { CodexRunOptions } from './codex/bridge.js';
export function conversationOptions(route: RoutingDecision, profile: 'companion' | 'work'): Omit<CodexRunOptions,'cwd'|'mode'|'prompt'|'profile'> {
  const options = { ...route.options,
    ...(profile === 'companion' && route.kind !== 'manual' ? { model: 'gpt-6.1-terra', reasoningEffort: 'medium' as const, serviceTier: 'fast' as const } : {}) };
  if (profile !== 'companion') return options;
  const targets = loadCharacterModels();
  const selected = withChatLlm({ ...options, ...targets.generation,
    ...(targets.review ? { reviewTarget: targets.review } : {}),
    ...(targets.repair ? { repairTarget: targets.repair } : {}),
    cwd: '', mode: 'plan', prompt: '', profile: 'companion' });
  const { cwd, mode, prompt, profile: selectedProfile, ...target } = selected;
  return target;
}

export const COMPANION_CONFIG: Record<string, unknown> = {
  'features.apps': false,
  'features.plugins': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'agents.enabled': false,
  'features.shell_tool': false,
  'skills.include_instructions': false,
  'skills.bundled.enabled': false,
  'features.skill_search': false,
  'features.image_generation': false,
  'features.browser_use': false,
  'features.sleep_tool': false,
  'features.goals': false,
  'features.memories': false,
  'project_doc_max_bytes': 0,
};
// Foreground role and its reviewer only. Background life/memory jobs retain
// COMPANION_CONFIG, and ordinary work threads retain the user's configuration.
export const CHARACTER_CONFIG: Record<string, unknown> = { ...COMPANION_CONFIG, personality: 'none' };
import { withChatLlm } from './llm.js';
