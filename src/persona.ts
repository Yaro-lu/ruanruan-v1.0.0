import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './constants.js';
import { fileURLToPath } from 'node:url';

export const CHAT_BREAK = '<<<RUANRUAN_BREAK>>>';
export const BURST_COOLDOWN_MS = 5 * 60 * 1000;

export interface PersonaMetadata {
  version: string;
  fingerprint: string;
  files: { name: string; sha256: string }[];
  bytes: number;
}
export interface PersonaSnapshot extends PersonaMetadata { instructions: string; reviewInstructions?: string; characterFacts?: string }

export const DEFAULT_PROMPT_DIRECTORY = fileURLToPath(new URL('../../personas/ruanruan/', import.meta.url));
export const EDITABLE_PROMPT_FILES = ['GENERATE.md', 'REVIEW.md'] as const;
function optionalText(path: string) {
  try { return readFileSync(path, 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function requiredText(path: string) {
  const text = readFileSync(path, 'utf8').trim();
  if (!text) throw new Error(`提示词文件为空：${path}`);
  return text;
}
function section(text: string, title: string | readonly string[]) {
  const titles = typeof title === 'string' ? [title] : title;
  const lines = text.split(/\r?\n/u), start = lines.findIndex(line => {
    const heading = line.trim().match(/^##\s+(?:[一二三四五六七八九十\d]+[、.．]\s*)?(.+?)\s*$/u)?.[1];
    return heading !== undefined && titles.includes(heading);
  });
  if (start < 0) return undefined;
  const next = lines.findIndex((line, index) => index > start && /^##\s/u.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
}
export function readGenerationSection(title: string | readonly string[]) {
  return section(requiredText(join(DEFAULT_PROMPT_DIRECTORY, 'GENERATE.md')), title) ?? '';
}
function characterBackground(generation: string) {
  return section(generation, ['人物档案与日常', '固定背景']) ?? generation;
}
export function loadReviewInstructions(directory = DATA_DIR) {
  const path = join(directory, 'REVIEW.md');
  const review = optionalText(path);
  if (review === undefined) return requiredText(join(DEFAULT_PROMPT_DIRECTORY, 'REVIEW.md'));
  if (!review) throw new Error(`提示词文件为空：${path}`);
  return review;
}
export function loadCharacterBackground(directory = DATA_DIR) {
  const generation = optionalText(join(directory, 'GENERATE.md'));
  if (generation !== undefined) return characterBackground(generation);
  return ['persona.md', 'persona/BACKSTORY.md'].map(name => optionalText(join(directory, name)) ?? '').filter(Boolean).join('\n\n');
}

export function loadPersonaSnapshot(_allowBurst: boolean, directory = DATA_DIR): PersonaSnapshot | undefined {
  const generation = optionalText(join(directory, 'GENERATE.md'));
  if (generation !== undefined) {
    if (!generation) throw new Error(`提示词文件为空：${join(directory, 'GENERATE.md')}`);
    const instructions = generation;
    const reviewInstructions = requiredText(join(directory, 'REVIEW.md'));
    const files = EDITABLE_PROMPT_FILES.map((name, index) => ({ name,
      sha256: createHash('sha256').update(index ? reviewInstructions : instructions).digest('hex') }));
    return { version: 'ruanruan-core-v6', instructions, reviewInstructions,
      characterFacts: characterBackground(instructions),
      files, fingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'), bytes: Buffer.byteLength(instructions) };
  }
  let persona: string;
  try { persona = readFileSync(join(directory, 'persona.md'), 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!persona) return undefined;
  const version = `ruanruan-core-${persona.match(/核心人格\s+(v[\w.-]+)/u)?.[1] ?? 'unversioned'}`;
  const parts = [{ name: 'persona.md', text: persona }];
  if (/^ruanruan-core-v[3456]$/u.test(version)) {
    for (const name of ['BACKSTORY.md', 'RELATIONSHIP.md', 'STYLE.md']) {
      const text = readFileSync(join(directory, 'persona', name), 'utf8').trim();
      if (!text) throw new Error(`人格文件为空：persona/${name}`);
      parts.push({ name: `persona/${name}`, text });
    }
    // Optional authored examples are part of the fixed, fingerprinted persona.
    // Old installations keep working until their persona directory is upgraded.
    if (version === 'ruanruan-core-v6') {
      try {
        const text = readFileSync(join(directory, 'persona', 'CONVERSATIONS.md'), 'utf8').trim();
        if (text) parts.push({ name: 'persona/CONVERSATIONS.md', text });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const files = parts.map(part => ({ name: part.name, sha256: createHash('sha256').update(part.text).digest('hex') }));
  const fingerprint = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const core = parts.map(part => `[人格文件：${part.name}]\n${part.text}`).join('\n\n');
  const instructions = `微信入口人格版本：${version}；配置指纹：${fingerprint.slice(0, 12)}。以下文件共同构成本轮人格，按内容交流，不向用户播报加载信息。\n\n${core}\n\n消息输出协议（内部格式，不向用户解释）：\n一次生成本轮想说的全部内容，同时按语境选择一条说完或2至3条气泡，最多4条。简单回答一条即可；惊讶后的补充、兴奋分享或确实独立的两层话可分条；认真解释、安慰和道歉保持完整。不固定分条比例，不逢逗号切割，不为凑分条增加内容。分条用单独一行 ${CHAT_BREAK} 分隔；不要拆开否定与后文、条件与结论，也不要在代码块、命令、URL或表格内拆分。不为聊天或等待创建定时任务，不额外调用模型，不报告分条协议。`;
  return { version, files, fingerprint, bytes: Buffer.byteLength(instructions), instructions };
}

export function loadPersona(allowBurst: boolean): string | undefined {
  return loadPersonaSnapshot(allowBurst)?.instructions;
}
