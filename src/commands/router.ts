import type { Session } from '../session.js';
import { findSkill } from '../codex/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleModel, handleMode, handleCwd, handleStatus, handleSkills, handleUnknown, handlePermissionAlias } from './handlers.js';
import { handleEffort, handleMemory, handleForget, handlePersona } from './handlers.js';

export interface CommandContext {
  accountId: string;
  entryRole?: 'character' | 'control';
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  codexPrompt?: string; // If set, this text should be sent to Codex
}

export const CHAT_MODE_SETTINGS = {
  assistant: { model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default', mode: 'danger' },
  companion: { model: 'gpt-5.6-luna', reasoningEffort: 'medium', serviceTier: 'fast', mode: 'plan' },
} as const;

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /cwd <path> - Update the working directory
 *   /mode <mode> - Update execution mode
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'q': {
      if (ctx.entryRole === 'control') return { handled: true, reply: '【系统】服务器助手是独立的 Codex 服务器助手，直接发送任务即可。' };
      if (args) return { handled: true, reply: '【系统】单独发送 /Q 即可切换阮阮与普通AI助手。' };
      const chatMode = ctx.session.chatMode === 'assistant' ? 'companion' : 'assistant';
      ctx.updateSession({ chatMode, ...CHAT_MODE_SETTINGS[chatMode], modeRevision: (ctx.session.modeRevision ?? 0) + 1,
        ...(chatMode === 'assistant' && ctx.session.assistantVersion !== 1
          ? { assistantVersion: 1, workContext: undefined } : {}) });
      return { handled: true, reply: chatMode === 'assistant'
        ? '【系统】已切换普通AI助手：GPT-6.1 Sol / High，Fast 关闭，服务器操作已启用。再发 /Q 回到阮阮。'
        : `【系统】已回到阮阮：GPT-5.6 Luna / Medium / Fast。再发 /Q 切换普通AI助手。${ctx.session.workJobId ? '\n后台工作任务仍在运行，可用 /progress 查看或 /stop 停止。' : ''}` };
    }
    case 'help':
      return handleHelp(args, ctx.entryRole);
    case 'clear':
      return handleClear(ctx);
    case 'model':
      return handleModel(ctx, args);
    case 'effort':
      return handleEffort(ctx, args);
    case 'auto':
      ctx.updateSession({ model: undefined, reasoningEffort: undefined, serviceTier: undefined });
      return { handled: true, reply: '已清除手动模型和强度设置，使用部署默认规则；保留当前对话。' };
    case 'cwd':
      return handleCwd(ctx, args);
    case 'mode':
      return handleMode(ctx, args);
    case 'permission':
      return handlePermissionAlias();
    case 'status':
      return handleStatus(ctx);
    case 'memory':
      return handleMemory(ctx, args);
    case 'persona':
      return handlePersona(ctx);
    case 'forget':
      return handleForget(ctx, args);
    case 'skills':
      return handleSkills();
    default:
      return handleUnknown(cmd, args);
  }
}
