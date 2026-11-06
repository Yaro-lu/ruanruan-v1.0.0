import {tokenUsage,sumReportedUsage,type TokenUsage,type UsageDetails} from '../usage.js';
export interface CodexCommandExecution {
  command: string;
  exitCode: number | null;
  status: string;
}

export interface CodexFileChange {
  path: string;
  kind: string;
}

export interface ParsedCodexOutput extends TokenUsage {
  usageDetails?:UsageDetails;
  inputTokens?: number;
  threadId?: string;
  replyText: string;
  messages: string[];
  commands: CodexCommandExecution[];
  fileChanges: CodexFileChange[];
  stderrText: string;
  error?: string;
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function parseCodexOutput(stdout: string, stderr: string, exitCode: number | null): ParsedCodexOutput {
  let threadId: string | undefined;
  let inputTokens: number | undefined;
  const usageEvents:unknown[]=[];
  let eventError: string | undefined;
  const messages: string[] = [];
  const finalMessages: string[] = [];
  const legacyMessages: string[] = [];
  const commands: CodexCommandExecution[] = [];
  const fileChanges: CodexFileChange[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJsonLine(line) as any;
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn.completed' && Number.isFinite(event.usage?.input_tokens)) {
      inputTokens = event.usage.input_tokens;
      usageEvents.push(event.usage);
    }
    if (event.type === 'turn.failed') {
      eventError = event.error?.message || 'Codex turn failed';
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      threadId = event.thread_id;
      continue;
    }

    if (event.type !== 'item.completed' && event.type !== 'item.started') {
      continue;
    }

    const item = event.item;
    if (!item || typeof item !== 'object') continue;

    if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
      messages.push(item.text);
      if (item.phase === 'final_answer') finalMessages.push(item.text);
      else if (!item.phase) legacyMessages.push(item.text);
      continue;
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      commands.push({
        command: item.command,
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        status: typeof item.status === 'string' ? item.status : 'unknown',
      });
      continue;
    }

    if (event.type === 'item.completed' && item.type === 'file_change' && Array.isArray(item.changes)) {
      for (const change of item.changes) {
        if (change && typeof change.path === 'string' && typeof change.kind === 'string') {
          fileChanges.push({ path: change.path, kind: change.kind });
        }
      }
    }
  }

  const replies = finalMessages.length ? finalMessages : legacyMessages;
  const replyText = replies.length > 0 ? replies[replies.length - 1].trim() : '';

  let error: string | undefined = eventError;
  const trimmedStderr = stderr.trim();
  if (exitCode && exitCode !== 0) {
    error = trimmedStderr || `Codex exited with code ${exitCode}`;
  } else if (!replyText && trimmedStderr) {
    error = trimmedStderr;
  }

  return {
    inputTokens,
    ...sumReportedUsage(usageEvents.map(tokenUsage)),
    ...(usageEvents.length?{usageDetails:{source:'codex-cli',scope:'reported_turns',raw:usageEvents,observedCalls:usageEvents.length}}:{}),
    threadId,
    replyText,
    messages,
    commands,
    fileChanges,
    stderrText: trimmedStderr,
    error,
  };
}
