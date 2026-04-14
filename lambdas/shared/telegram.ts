const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const API = `https://api.telegram.org/bot${TOKEN}`;

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface SendOpts {
  replyToMessageId?: number;
  chatId?: string | number;
}

export async function sendMessage(text: string, opts: SendOpts = {}): Promise<TelegramMessage> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId ?? CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (opts.replyToMessageId) {
    body.reply_parameters = { message_id: opts.replyToMessageId, allow_sending_without_reply: true };
  }
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: TelegramMessage; description?: string };
  if (!json.ok || !json.result) {
    throw new Error(`Telegram sendMessage failed: ${json.description ?? res.status}`);
  }
  return json.result;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}
