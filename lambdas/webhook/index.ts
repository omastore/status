import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { readModifyWriteState } from '../shared/state';
import { sendMessage, escapeHtml, TelegramUpdate, TelegramMessage } from '../shared/telegram';
import { Incident, IncidentUpdate, State } from '../shared/types';
import { ulid } from '../shared/ulid';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
const ALLOWED_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const OK: APIGatewayProxyResultV2 = { statusCode: 200, body: 'ok' };

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const headerSecret = event.headers?.['x-telegram-bot-api-secret-token'];
  if (headerSecret !== WEBHOOK_SECRET) {
    return { statusCode: 401, body: 'unauthorized' };
  }

  if (!event.body) return OK;

  let update: TelegramUpdate;
  try {
    update = JSON.parse(event.body) as TelegramUpdate;
  } catch {
    return OK;
  }

  const msg = update.message ?? update.channel_post;
  if (!msg || !msg.text) return OK;

  if (String(msg.chat.id) !== String(ALLOWED_CHAT_ID)) {
    return OK;
  }

  try {
    await route(msg);
  } catch (err) {
    console.error('Webhook handler error', err);
    try {
      await sendMessage(`⚠️ Error processing command: ${escapeHtml(String(err))}`, {
        replyToMessageId: msg.message_id,
      });
    } catch {
      /* ignore */
    }
  }
  return OK;
};

async function route(msg: TelegramMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const replyTo = msg.reply_to_message;

  if (replyTo) {
    if (text === '/close' || text.startsWith('/close ') || text.startsWith('/close@')) {
      await closeIncident(msg, replyTo.message_id);
      return;
    }
    await appendReplyUpdate(msg, replyTo.message_id, text);
    return;
  }

  if (text.startsWith('/incident')) {
    const desc = stripCommand(text, 'incident');
    if (!desc) {
      await sendMessage('Usage: <code>/incident description</code>', { replyToMessageId: msg.message_id });
      return;
    }
    await createManualIncident(msg, desc, 'outage');
    return;
  }

  if (text.startsWith('/maintenance')) {
    const desc = stripCommand(text, 'maintenance');
    if (!desc) {
      await sendMessage('Usage: <code>/maintenance description</code>', { replyToMessageId: msg.message_id });
      return;
    }
    await createManualIncident(msg, desc, 'maintenance');
    return;
  }

  // Plain message, not a reply — ignore silently
}

function stripCommand(text: string, name: string): string {
  const re = new RegExp(`^/${name}(?:@\\w+)?\\s+`, 'i');
  const m = text.match(re);
  if (!m) return '';
  return text.slice(m[0].length).trim();
}

async function appendReplyUpdate(msg: TelegramMessage, replyToMessageId: number, text: string): Promise<void> {
  const now = new Date().toISOString();
  const updated = await readModifyWriteState((state) => {
    const target = findIncidentByMessageId(state, replyToMessageId);
    if (!target) return null;
    const update: IncidentUpdate = { at: now, source: 'telegram', text };
    target.updates.push(update);
    return target;
  });
  if (!updated) {
    await sendMessage('⚠️ No incident matched that reply.', { replyToMessageId: msg.message_id });
    return;
  }
  await sendMessage(`✅ Update added to incident <code>${escapeHtml(updated.id)}</code>.`, {
    replyToMessageId: msg.message_id,
  });
}

async function closeIncident(msg: TelegramMessage, replyToMessageId: number): Promise<void> {
  const now = new Date().toISOString();
  const closed = await readModifyWriteState((state) => {
    const target = findIncidentByMessageId(state, replyToMessageId);
    if (!target) return null;
    if (target.status === 'closed') return target;
    target.status = 'closed';
    target.closedAt = now;
    target.updates.push({ at: now, source: 'telegram', text: 'Incident manually closed.' });
    // Move to past if in active
    const idx = state.activeIncidents.findIndex((i) => i.id === target.id);
    if (idx >= 0) {
      state.activeIncidents.splice(idx, 1);
      state.pastIncidents.unshift(target);
      state.pastIncidents = state.pastIncidents.slice(0, 100);
    }
    // If maintenance on specific service, reset status to up (checker will correct on next tick anyway)
    if (target.type === 'maintenance' && target.service) {
      const svc = state.services[target.service];
      if (svc && svc.status === 'maintenance') {
        svc.status = 'up';
        svc.lastStatusChangeAt = now;
      }
    }
    return target;
  });
  if (!closed) {
    await sendMessage('⚠️ No incident matched that reply.', { replyToMessageId: msg.message_id });
    return;
  }
  await sendMessage(`✅ Incident <code>${escapeHtml(closed.id)}</code> closed.`, {
    replyToMessageId: msg.message_id,
  });
}

async function createManualIncident(
  msg: TelegramMessage,
  description: string,
  type: 'outage' | 'maintenance'
): Promise<void> {
  const now = new Date().toISOString();
  const id = ulid();
  const title =
    type === 'maintenance' ? `Planned maintenance: ${description}` : description;
  const icon = type === 'maintenance' ? '🛠' : '🔴';

  const alertText =
    `${icon} <b>${escapeHtml(title)}</b>\n` +
    `Incident: <code>${escapeHtml(id)}</code>\n` +
    `Time: ${now.replace('T', ' ').slice(0, 16)} UTC\n\n` +
    `Reply to this message to post an update. Reply <code>/close</code> to close.`;

  const alertMsg = await sendMessage(alertText);

  await readModifyWriteState((state) => {
    const incident: Incident = {
      id,
      service: null,
      type,
      status: 'open',
      startedAt: now,
      title,
      telegramMessageId: alertMsg.message_id,
      updates: [{ at: now, source: 'telegram', text: `Manually opened via Telegram: ${description}` }],
    };
    state.activeIncidents.push(incident);
  });

  await sendMessage(`✅ Incident <code>${escapeHtml(id)}</code> opened.`, {
    replyToMessageId: msg.message_id,
  });
}

function findIncidentByMessageId(state: State, messageId: number): Incident | undefined {
  for (const i of state.activeIncidents) {
    if (i.telegramMessageId === messageId) return i;
  }
  for (const i of state.pastIncidents) {
    if (i.telegramMessageId === messageId) return i;
  }
  return undefined;
}
