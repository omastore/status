(() => {
  'use strict';

  const STATE_URL = '/state.json';
  const POLL_MS = 10_000;
  const HISTORY_DAYS = 90;

  const el = (id) => document.getElementById(id);

  document.getElementById('year').textContent = String(new Date().getFullYear());

  async function fetchState() {
    const res = await fetch(`${STATE_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`state.json ${res.status}`);
    return res.json();
  }

  function overallStatus(state) {
    const statuses = Object.values(state.services).map((s) => s.status);
    if (statuses.includes('down')) return 'down';
    if (statuses.includes('degraded')) return 'degraded';
    if (statuses.includes('maintenance')) return 'maintenance';
    return 'up';
  }

  function summaryLine(state) {
    if (state.activeIncidents && state.activeIncidents.length > 0) {
      const n = state.activeIncidents.length;
      return n === 1 ? '1 aktiivinen häiriö' : `${n} aktiivista häiriötä`;
    }
    const overall = overallStatus(state);
    if (overall === 'up') return 'Kaikki järjestelmät toiminnassa';
    if (overall === 'degraded') return 'Joissakin järjestelmissä häiriöitä';
    if (overall === 'maintenance') return 'Huolto käynnissä';
    return 'Palvelukatkos';
  }

  function renderSummary(state) {
    const overall = overallStatus(state);
    el('summary').querySelector('.summary-indicator').dataset.status = overall;
    el('summary-title').textContent = summaryLine(state);
  }

  function statusTag(status) {
    const label =
      status === 'up'
        ? 'Toiminnassa'
        : status === 'degraded'
        ? 'Häiriö'
        : status === 'down'
        ? 'Alhaalla'
        : 'Huolto';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.dataset.status = status;
    tag.textContent = label;
    return tag;
  }

  function cellStatus(bucket) {
    if (!bucket || bucket.totalChecks === 0) return '';
    const down = bucket.downChecks || 0;
    const degraded = bucket.degradedChecks || 0;
    const total = bucket.totalChecks;
    const downRatio = down / total;
    const badRatio = (down + degraded) / total;
    if (downRatio >= 0.05) return 'down';
    if (badRatio >= 0.02) return 'degraded';
    if (degraded > 0) return 'partial';
    return 'up';
  }

  function bucketsByDate(buckets) {
    const map = new Map();
    for (const b of buckets) map.set(b.date, b);
    return map;
  }

  function uptimePercent(buckets) {
    let total = 0;
    let up = 0;
    for (const b of buckets) {
      total += b.totalChecks;
      up += b.upChecks;
    }
    if (total === 0) return null;
    return (up / total) * 100;
  }

  function renderServices(state) {
    const root = el('services');
    root.innerHTML = '';
    const today = new Date();
    const dates = [];
    for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    for (const svc of Object.values(state.services)) {
      const byDate = bucketsByDate(state.history[svc.key] || []);
      const pct = uptimePercent(state.history[svc.key] || []);
      const wrap = document.createElement('article');
      wrap.className = 'service';

      const head = document.createElement('div');
      head.className = 'service-head';
      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'service-name';
      name.textContent = svc.name;
      left.appendChild(name);
      head.appendChild(left);
      head.appendChild(statusTag(svc.status));
      wrap.appendChild(head);

      const bar = document.createElement('div');
      bar.className = 'bar';
      for (const date of dates) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        const bucket = byDate.get(date);
        const s = cellStatus(bucket);
        if (s) cell.dataset.status = s;
        const title = bucket
          ? `${date}: ${bucket.upChecks}/${bucket.totalChecks} toiminnassa` +
            (bucket.degradedChecks ? `, ${bucket.degradedChecks} häiriötä` : '') +
            (bucket.downChecks ? `, ${bucket.downChecks} alhaalla` : '')
          : `${date}: ei dataa`;
        cell.title = title;
        bar.appendChild(cell);
      }
      wrap.appendChild(bar);

      const foot = document.createElement('div');
      foot.className = 'bar-footer';
      const left2 = document.createElement('span');
      left2.textContent = `${HISTORY_DAYS} päivää sitten`;
      const mid = document.createElement('span');
      mid.textContent = pct === null ? 'Ei vielä dataa' : `${pct.toFixed(2)} % käytettävyys`;
      const right2 = document.createElement('span');
      right2.textContent = 'Tänään';
      foot.appendChild(left2);
      foot.appendChild(mid);
      foot.appendChild(right2);
      wrap.appendChild(foot);

      root.appendChild(wrap);
    }
  }

  function renderIncidents(listEl, incidents) {
    listEl.innerHTML = '';
    if (incidents.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Ei yhtään.';
      listEl.appendChild(empty);
      return;
    }
    for (const inc of incidents) {
      const wrap = document.createElement('article');
      wrap.className = 'incident' + (inc.type === 'maintenance' ? ' maintenance' : '') + (inc.status === 'closed' ? ' closed' : '');

      const head = document.createElement('div');
      head.className = 'incident-head';
      const title = document.createElement('div');
      title.className = 'incident-title';
      title.textContent = inc.title;
      const meta = document.createElement('div');
      meta.className = 'incident-meta';
      const started = fmtTime(inc.startedAt);
      meta.textContent = inc.status === 'closed' && inc.closedAt
        ? `Alkoi ${started} · Ratkaistu ${fmtTime(inc.closedAt)}`
        : `Alkoi ${started}`;
      head.appendChild(title);
      head.appendChild(meta);
      wrap.appendChild(head);

      if (inc.updates && inc.updates.length > 0) {
        const ul = document.createElement('ul');
        ul.className = 'incident-updates';
        const sorted = [...inc.updates].sort((a, b) => b.at.localeCompare(a.at));
        for (const u of sorted) {
          const li = document.createElement('li');
          const t = document.createElement('time');
          t.dateTime = u.at;
          t.textContent = fmtTime(u.at);
          li.appendChild(t);
          const txt = document.createElement('div');
          txt.textContent = u.text;
          li.appendChild(txt);
          ul.appendChild(li);
        }
        wrap.appendChild(ul);
      }

      listEl.appendChild(wrap);
    }
  }

  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('fi-FI', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function render(state) {
    renderSummary(state);
    const active = state.activeIncidents || [];
    const activeSection = el('active-incidents');
    if (active.length > 0) {
      activeSection.hidden = false;
      renderIncidents(el('active-incidents-list'), active);
    } else {
      activeSection.hidden = true;
    }
    renderServices(state);
    renderIncidents(el('past-incidents'), state.pastIncidents || []);
    el('updated-at').textContent = fmtTime(state.updatedAt);
  }

  async function tick() {
    try {
      const state = await fetchState();
      render(state);
    } catch (err) {
      console.error(err);
      el('summary-title').textContent = 'Tilaa ei saada juuri nyt haettua';
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
