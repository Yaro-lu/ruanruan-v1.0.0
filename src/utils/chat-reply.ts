import { CHAT_BREAK } from '../persona.js';
import { splitMessage } from './chunk.js';
import type { ConversationMessage } from '../conversation.js';
import { SendSuperseded } from '../wechat/receipt.js';

// Only a repeated, explicit goodbye after an actual closing reply may be left
// unanswered. Any new question, media, mode change or older exchange must run
// normally. Full-message matching deliberately avoids interpreting sentiment.
const closing = (text: string) => /^(?:(?:嗯|好|好的|好哒|行|那)[，,、\s]*)?(?:拜拜|再见|晚安|明天聊|明天再聊|回头聊|回头再聊|晚点聊|晚点再聊|下次聊|去吧)[呀啊啦哦吧呢！!。.…\s]*$/u.test(text.trim());
export function isRepeatedFarewell(rows: ConversationMessage[], inputIds: string[], now = Date.now()): boolean {
  if (!inputIds.length) return false;
  const ids = new Set(inputIds), inputs = rows.filter(row => ids.has(row.id));
  if (inputs.length !== ids.size || inputs.some(row => row.direction !== 'in' || row.profile !== 'companion' || !closing(row.text))) return false;
  const first = Math.min(...inputs.map(row => row.seq));
  const previous = rows.filter(row => row.seq < first).at(-1);
  if (!previous || previous.direction !== 'out' || previous.profile !== 'companion' || !closing(previous.text)
    || now - previous.at < 0 || now - previous.at > 15 * 60 * 1000) return false;
  return rows.filter(row => row.seq >= first).every(row => ids.has(row.id));
}

export function replyTextForDelivery(result?: { replyText: string; replyDisposition?: 'no_reply'; error?: string }): string {
  return result?.replyDisposition === 'no_reply' && !result.error ? '' : result?.replyText || '任务已结束，无文本结果。';
}

export function planChatReply(text: string, allowBurst: boolean): { messages: string[]; burst: boolean } {
  const parts = [''];
  let fence: string | undefined;
  for (const line of text.split('\n')) {
    const match = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = undefined;
    }
    if (!fence && line.trim() === CHAT_BREAK) parts.push('');
    else parts[parts.length - 1] += `${line}\n`;
  }
  const nonempty = parts.map(p => p.trim()).filter(Boolean);
  const clean = nonempty.join('\n\n');
  if (!clean) return { messages: [], burst: false };
  if (!allowBurst || nonempty.length < 2 || clean.length > 1800 || /```|~~~/.test(clean)) {
    return { messages: splitMessage(clean), burst: false };
  }
  const messages = nonempty.length <= 4 ? nonempty : [...nonempty.slice(0, 3), nonempty.slice(3).join('\n\n')];
  return { messages, burst: true };
}

// The model chooses semantic boundaries during its one normal generation.
// A new input can supersede only the parts that have not actually been sent.
export async function deliverChatMessages(messages: string[], send: (message: string) => Promise<unknown>, options: {
  shouldContinue?: () => boolean; gapMs?: number; pause?: (ms: number) => Promise<void>;
} = {}) {
  let sent = 0;
  for (const message of messages) {
    if (sent && options.gapMs) await (options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(options.gapMs);
    if (options.shouldContinue && !options.shouldContinue()) return { sent, interrupted: true };
    try { await send(message); sent++; }
    catch (error) {
      if (error instanceof SendSuperseded) return { sent, interrupted: true };
      throw error;
    }
  }
  return { sent, interrupted: false };
}
