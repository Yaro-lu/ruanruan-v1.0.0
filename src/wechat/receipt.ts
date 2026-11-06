export interface SendAcknowledgement {
  ret?: number;
  errcode?: number;
  messageIdPresent: boolean;
  desktopEvidence?: { screenshotPath?: string; observedAt: number };
}

export class SendRejected extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SendRejected';
  }
}

// The transport knows that a newer turn cancelled this reply before any send.
// Distinct from an uncertain outcome, which must remain available for inspection.
export class SendSuperseded extends Error {
  constructor(message: string) { super(message); this.name = 'SendSuperseded'; }
}

export function safeReceiptText(value: unknown, secrets: string[] = []): string {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 180);
}

// Tencent's SendMessageResp has optional ret and message_id fields. A positive
// server message ID is an acknowledgement even when default ret=0 is omitted.
// Neither acknowledgement form proves that the recipient has read the message.
export function validateSendReceipt(body: unknown, secrets: string[] = []): SendAcknowledgement {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('missing send receipt');
  const value = body as Record<string, unknown>;
  const codes: Record<string, number> = {};
  for (const key of ['ret', 'errcode']) {
    if (key in value) {
      if (typeof value[key] !== 'number' || !Number.isInteger(value[key])) throw new Error(`invalid ${key} in send receipt`);
      codes[key] = value[key] as number;
    }
  }
  const errmsg = safeReceiptText(value.errmsg ?? value.retmsg, secrets);
  if (Object.values(codes).some(code => code !== 0)) {
    const details = { ...codes, errmsg };
    throw new SendRejected(`微信拒绝发送：ret=${codes.ret ?? 0}, errcode=${codes.errcode ?? 0}${errmsg ? ', errmsg=' + errmsg : ''}`, details);
  }
  const id = value.message_id;
  const messageIdPresent = typeof id === 'string' ? /^\d+$/.test(id) && /[1-9]/.test(id)
    : typeof id === 'number' && Number.isInteger(id) && id > 0;
  if (!Object.keys(codes).length && !messageIdPresent) {
    throw new Error('missing send acknowledgement; fields=' + Object.keys(value).join(',').slice(0, 120));
  }
  return { ...codes, messageIdPresent };
}
