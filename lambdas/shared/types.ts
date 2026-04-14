export type ServiceKey = 'omastore-website' | 'omastore-admin' | 'omastore-api';

export type Status = 'up' | 'degraded' | 'down' | 'maintenance';

export interface ServiceDef {
  key: ServiceKey;
  name: string;
  url: string;
  checkBody: boolean;
}

export const SERVICES: ServiceDef[] = [
  { key: 'omastore-website', name: 'Omastore Website', url: 'https://www.omastore.fi', checkBody: false },
  { key: 'omastore-admin', name: 'Omastore Admin', url: 'https://api.omastore.fi/health/nginx', checkBody: true },
  { key: 'omastore-api', name: 'Omastore API', url: 'https://api.omastore.fi/health/frankenphp', checkBody: true },
];

export interface ServiceState {
  key: ServiceKey;
  name: string;
  url: string;
  status: Status;
  lastCheckedAt: string;
  lastStatusChangeAt: string;
}

export interface IncidentUpdate {
  at: string;
  source: 'auto' | 'telegram';
  text: string;
}

export interface Incident {
  id: string;
  service: ServiceKey | null;
  type: 'outage' | 'maintenance';
  status: 'open' | 'closed';
  startedAt: string;
  closedAt?: string;
  title: string;
  telegramMessageId?: number;
  updates: IncidentUpdate[];
}

export interface DailyUptime {
  date: string;
  totalChecks: number;
  upChecks: number;
  degradedChecks: number;
  downChecks: number;
}

export interface State {
  version: 1;
  services: Record<ServiceKey, ServiceState>;
  activeIncidents: Incident[];
  pastIncidents: Incident[];
  history: Record<ServiceKey, DailyUptime[]>;
  updatedAt: string;
}

export function emptyState(): State {
  const now = new Date().toISOString();
  const services = {} as Record<ServiceKey, ServiceState>;
  const history = {} as Record<ServiceKey, DailyUptime[]>;
  for (const s of SERVICES) {
    services[s.key] = {
      key: s.key,
      name: s.name,
      url: s.url,
      status: 'up',
      lastCheckedAt: now,
      lastStatusChangeAt: now,
    };
    history[s.key] = [];
  }
  return {
    version: 1,
    services,
    activeIncidents: [],
    pastIncidents: [],
    history,
    updatedAt: now,
  };
}
