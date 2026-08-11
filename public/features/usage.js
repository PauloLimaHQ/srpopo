/* Sr. Popo — usage. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { money } from './autonomous.js';


// ---------- usage (Settings → Usage) ----------
const fmtCompactNum = (n) => {
  const v = Number(n) || 0;
  try { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v); }
  catch { return String(Math.round(v)); }
};
const fmtPct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

function usageRepoOptionsHtml() {
  return ['<option value="">All projects</option>']
    .concat(state.repos.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`))
    .join('');
}

// A model id like "claude-sonnet-5" or "claude-haiku-4-5-20251001" reads
// better shortened for the breakdown rows.
function usageModelLabel(model) {
  return String(model || 'unknown').replace(/-\d{8}$/, '');
}

function usageStatTile(label, value, delta) {
  const deltaHtml = delta == null ? ''
    : `<div class="usage-stat-delta ${delta >= 0 ? 'up' : 'down'}">${fmtPct(delta)} vs previous period</div>`;
  return `
      <div class="usage-stat">
        <div class="usage-stat-label">${esc(label)}</div>
        <div class="usage-stat-value">${value}</div>
        ${deltaHtml}
      </div>`;
}

function usageBarRowHtml(label, sub, costUsd, maxCost, runs) {
  const pct = maxCost > 0 ? Math.max(2, Math.round((costUsd / maxCost) * 100)) : 0;
  return `
      <div class="usage-row">
        <div class="usage-row-head">
          <span class="usage-row-label">${esc(label)}</span>
          <span class="usage-row-value">${money(costUsd)}${sub ? ` <span class="usage-row-sub">${sub}</span>` : ''}</span>
        </div>
        <div class="usage-row-bar"><div class="usage-row-bar-fill" style="width:${pct}%"></div></div>
        <div class="usage-row-runs">${runs} run${runs === 1 ? '' : 's'}</div>
      </div>`;
}

function usageChartHtml(byDay) {
  if (!byDay.length) return '<p class="usage-empty">No runs in this period.</p>';
  const MAX_BARS = 60;
  const shown = byDay.length > MAX_BARS ? byDay.slice(byDay.length - MAX_BARS) : byDay;
  const maxCost = Math.max(...shown.map((d) => d.costUsd), 0.01);
  const note = byDay.length > MAX_BARS
    ? `<p class="usage-chart-note">Showing the most recent ${MAX_BARS} of ${byDay.length} days.</p>` : '';
  const bars = shown.map((d) => {
    const h = Math.max(3, Math.round((d.costUsd / maxCost) * 64));
    return `<div class="usage-chart-bar" style="height:${h}px" title="${esc(d.date)}: ${money(d.costUsd)} · ${d.runs} run${d.runs === 1 ? '' : 's'}"></div>`;
  }).join('');
  return `<div class="usage-chart">${bars}</div>${note}`;
}

function renderUsage() {
  const body = $('#settings-usage-body');
  if (!body) return;
  const s = state.usage.summary;
  if (!s) { body.innerHTML = '<p class="usage-empty">Loading…</p>'; return; }

  const stats = [
    usageStatTile('Total spend', money(s.totals.costUsd), s.deltaPct),
    usageStatTile('Runs', s.totals.runs, null),
    usageStatTile('Tasks touched', s.totals.tasks, null),
    usageStatTile('Tokens in / out', `${fmtCompactNum(s.totals.inputTokens)} / ${fmtCompactNum(s.totals.outputTokens)}`, null),
  ];

  const maxModelCost = Math.max(...s.byModel.map((m) => m.costUsd), 0.01);
  const modelRows = s.byModel.length
    ? s.byModel.map((m) => usageBarRowHtml(
        usageModelLabel(m.model),
        `${fmtCompactNum(m.inputTokens)} in · ${fmtCompactNum(m.outputTokens)} out`,
        m.costUsd, maxModelCost, m.runs,
      )).join('')
    : '<p class="usage-empty">No runs in this period.</p>';

  const maxRepoCost = Math.max(...s.byRepo.map((r) => r.costUsd), 0.01);
  const repoRows = s.byRepo.length
    ? s.byRepo.map((r) => usageBarRowHtml(r.repoName, '', r.costUsd, maxRepoCost, r.runs)).join('')
    : '<p class="usage-empty">No runs in this period.</p>';

  body.innerHTML = `
      <div class="usage-stats">${stats.join('')}</div>
      <div class="usage-section-block">
        <div class="usage-block-title">By day</div>
        ${usageChartHtml(s.byDay)}
      </div>
      <div class="usage-section-block">
        <div class="usage-block-title">By model</div>
        <div class="usage-rows">${modelRows}</div>
      </div>
      <div class="usage-section-block">
        <div class="usage-block-title">By project</div>
        <div class="usage-rows">${repoRows}</div>
      </div>`;
}

async function loadUsage() {
  try {
    const qs = new URLSearchParams({ period: state.usage.period });
    if (state.usage.repoId) qs.set('repoId', state.usage.repoId);
    state.usage.summary = await api('GET', `/api/usage?${qs.toString()}`);
  } catch (e) {
    toast(e.message);
  }
  renderUsage();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  for (const btn of document.querySelectorAll('.usage-period-btn')) {
    btn.addEventListener('click', () => {
      state.usage.period = btn.dataset.period;
      for (const b of document.querySelectorAll('.usage-period-btn')) b.classList.toggle('active', b === btn);
      loadUsage();
    });
  }
  $('#usage-repo-filter').addEventListener('change', (e) => {
    state.usage.repoId = e.target.value;
    loadUsage();
  });
}


export { loadUsage, usageRepoOptionsHtml };
