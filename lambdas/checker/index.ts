import { readModifyWriteState } from '../shared/state';
import { sendMessage, escapeHtml } from '../shared/telegram';
import { SERVICES, ServiceDef, Status, State, Incident, IncidentUpdate, DailyUptime } from '../shared/types';
import { ulid } from '../shared/ulid';

const TIMEOUT_MS = 10_000;
const HISTORY_DAYS = 90;

interface CheckResult {
  key: ServiceDef['key'];
  status: Status;
  detail: string;
}

async function checkOne(svc: ServiceDef): Promise<CheckResult> {
  try {
    const res = await fetch(svc.url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'follow',
      headers: { 'user-agent': 'OmastoreStatus/1.0' },
    });
    if (res.status !== 200) {
      if (svc.checkBody && res.status === 503) {
        const text = await safeText(res);
        if (text.includes('"status":"degraded"')) {
          return { key: svc.key, status: 'degraded', detail: 'HTTP 503 degraded' };
        }
      }
      return { key: svc.key, status: 'down', detail: `HTTP ${res.status}` };
    }
    if (svc.checkBody) {
      const text = await safeText(res);
      if (text.includes('"status":"degraded"')) {
        return { key: svc.key, status: 'degraded', detail: 'body reports degraded' };
      }
    }
    return { key: svc.key, status: 'up', detail: 'HTTP 200' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { key: svc.key, status: 'down', detail: `error: ${msg.slice(0, 120)}` };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

const DATE_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki' });

function todayHelsinki(): string {
  return DATE_FMT.format(new Date());
}

function bumpHistory(state: State, key: ServiceDef['key'], status: Status): void {
  const date = todayHelsinki();
  const buckets = state.history[key];
  let bucket = buckets[buckets.length - 1];
  if (!bucket || bucket.date !== date) {
    bucket = { date, totalChecks: 0, upChecks: 0, degradedChecks: 0, downChecks: 0 };
    buckets.push(bucket);
  }
  bucket.totalChecks += 1;
  if (status === 'up') bucket.upChecks += 1;
  else if (status === 'degraded') bucket.degradedChecks += 1;
  else if (status === 'down') bucket.downChecks += 1;
  while (buckets.length > HISTORY_DAYS) buckets.shift();
}

interface PendingAlert {
  kind: 'open' | 'update' | 'recovery';
  incident: Incident;
  serviceName: string;
  detail: string;
  newStatus: Status;
}

function handleTransition(state: State, svc: ServiceDef, result: CheckResult, now: string): PendingAlert | null {
  const current = state.services[svc.key];
  const previousStatus = current.status;
  current.lastCheckedAt = now;

  if (previousStatus === result.status) {
    return null;
  }

  current.status = result.status;
  current.lastStatusChangeAt = now;

  const openAuto = state.activeIncidents.find(
    (i) => i.service === svc.key && i.status === 'open' && i.type === 'outage'
  );

  if (result.status === 'up') {
    if (!openAuto) return null;
    openAuto.status = 'closed';
    openAuto.closedAt = now;
    const upd: IncidentUpdate = { at: now, source: 'auto', text: `Palvelu palautunut (${result.detail})` };
    openAuto.updates.push(upd);
    state.activeIncidents = state.activeIncidents.filter((i) => i.id !== openAuto.id);
    state.pastIncidents.unshift(openAuto);
    state.pastIncidents = state.pastIncidents.slice(0, 100);
    return { kind: 'recovery', incident: openAuto, serviceName: svc.name, detail: result.detail, newStatus: 'up' };
  }

  // transitioning into degraded or down
  if (openAuto) {
    const upd: IncidentUpdate = {
      at: now,
      source: 'auto',
      text: `Tila muuttui: ${statusFi(result.status)} (${result.detail})`,
    };
    openAuto.updates.push(upd);
    return { kind: 'update', incident: openAuto, serviceName: svc.name, detail: result.detail, newStatus: result.status };
  }

  const incident: Incident = {
    id: ulid(),
    service: svc.key,
    type: 'outage',
    status: 'open',
    startedAt: now,
    title: `${svc.name}: ${statusFi(result.status)}`,
    updates: [{ at: now, source: 'auto', text: `Havaittu: ${statusFi(result.status)} — ${result.detail}` }],
  };
  state.activeIncidents.push(incident);
  return { kind: 'open', incident, serviceName: svc.name, detail: result.detail, newStatus: result.status };
}

function statusFi(s: Status): string {
  if (s === 'down') return 'alhaalla';
  if (s === 'degraded') return 'häiriötila';
  if (s === 'maintenance') return 'huolto';
  return 'toiminnassa';
}

function formatAlert(alert: PendingAlert, incidentIdForHeader?: string): string {
  const emoji =
    alert.newStatus === 'up' ? '✅' : alert.newStatus === 'degraded' ? '🟡' : '🔴';
  const statusWord =
    alert.newStatus === 'up' ? 'RECOVERED' : alert.newStatus.toUpperCase();
  const id = incidentIdForHeader ?? alert.incident.id;
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  if (alert.kind === 'open') {
    return (
      `${emoji} <b>${escapeHtml(alert.serviceName)}</b> is ${statusWord}\n` +
      `Detail: ${escapeHtml(alert.detail)}\n` +
      `Incident: <code>${escapeHtml(id)}</code>\n` +
      `Time: ${when}\n\n` +
      `Reply to this message to post an update. Reply <code>/close</code> to close.`
    );
  }
  if (alert.kind === 'recovery') {
    return (
      `${emoji} <b>${escapeHtml(alert.serviceName)}</b> has RECOVERED\n` +
      `Incident: <code>${escapeHtml(id)}</code>\n` +
      `Time: ${when}`
    );
  }
  return (
    `${emoji} <b>${escapeHtml(alert.serviceName)}</b> — status now ${statusWord}\n` +
    `Detail: ${escapeHtml(alert.detail)}\n` +
    `Incident: <code>${escapeHtml(id)}</code>\n` +
    `Time: ${when}`
  );
}

export const handler = async (): Promise<void> => {
  const results = await Promise.all(SERVICES.map((s) => checkOne(s)));

  const alerts = await readModifyWriteState((state) => {
    const now = new Date().toISOString();
    const pending: PendingAlert[] = [];
    for (const svc of SERVICES) {
      const res = results.find((r) => r.key === svc.key)!;
      bumpHistory(state, svc.key, res.status);
      const alert = handleTransition(state, svc, res, now);
      if (alert) pending.push(alert);
    }
    return pending;
  });

  for (const alert of alerts) {
    try {
      if (alert.kind === 'open') {
        const msg = await sendMessage(formatAlert(alert));
        // Persist telegramMessageId on the incident
        await readModifyWriteState((state) => {
          const inc = state.activeIncidents.find((i) => i.id === alert.incident.id);
          if (inc) inc.telegramMessageId = msg.message_id;
        });
      } else if (alert.kind === 'recovery') {
        await sendMessage(formatAlert(alert), {
          replyToMessageId: alert.incident.telegramMessageId,
        });
      } else {
        await sendMessage(formatAlert(alert), {
          replyToMessageId: alert.incident.telegramMessageId,
        });
      }
    } catch (err) {
      console.error('Failed to send Telegram alert', err);
    }
  }
};
