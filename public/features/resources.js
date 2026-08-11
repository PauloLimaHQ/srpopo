/* Sr. Popo — resources. No build step: native ES module. */
import { api, esc } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { fmtBytes } from './task-modal.js';


// ---------- resource monitor ----------
// Opt-in (Settings → General → Resource monitor). While on, the top-bar chip
// shows what Sr. Popo + its agent sessions are costing this machine, and
// clicking it opens a per-session breakdown. Poll-based rather than SSE: this
// is sampled state, not an event, and polling stops the moment the feature is
// off, the tab is hidden, or the server stops answering. Everything the panel
// shows comes from GET /api/resources (server/resources.ts).
const RESOURCE_POLL_IDLE_MS = 6000; // chip only
const RESOURCE_POLL_OPEN_MS = 2000; // panel open — the numbers are being read
let resourceTimer = null;
let resourceSnapshot = null;
// Consecutive failed polls; a few in a row (server restarting, route gone)
// park the monitor instead of retrying forever in the background.
let resourceFails = 0;

const resourceMonitorOn = () => !!state.settings.resourceMonitor;
const resourcePanelOpen = () => !$('#resource-panel').classList.contains('hidden');

// CPU figures are shares of the whole machine (all cores) — see the module
// comment in server/resources.ts — so they read like an activity monitor's.
const fmtCpu = (pct) => (pct === null || pct === undefined ? '—' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`);
const meterHtml = (pct, cls) =>
  `<div class="res-meter${cls ? ` ${cls}` : ''}"><span style="width:${Math.max(0, Math.min(100, pct || 0)).toFixed(1)}%"></span></div>`;

// One row of the panel. Each figure is optional: pass `cpuPercent` for a CPU
// number + bar, `mem` (formatted) for the memory number, `memPercent` for a
// memory bar. Omitted figures leave their slot out entirely.
function resourceRowHtml({ iconName, name, sub, cpuPercent, mem, memPercent, total }) {
  const figs = (cpuPercent === undefined ? '' : `<span class="res-cpu">${fmtCpu(cpuPercent)}</span>`)
    + (mem === undefined ? '' : `<span class="res-mem">${esc(mem)}</span>`);
  return `<div class="res-row${total ? ' total' : ''}">
      <div class="res-row-head">
        <span class="res-row-label">${iconName ? icon(iconName) : ''}<span class="res-row-name">${esc(name)}</span></span>
        <span class="res-row-figs">${figs}</span>
      </div>
      ${sub ? `<div class="res-row-sub">${esc(sub)}</div>` : ''}
      ${cpuPercent === undefined ? '' : meterHtml(cpuPercent || 0)}
      ${memPercent === undefined ? '' : meterHtml(memPercent, 'mem')}
    </div>`;
}

const RESOURCE_KIND_ICON = { task: 'bot', grooming: 'lightbulb', orchestration: 'crown', ask: 'message-circle-question' };
const RESOURCE_KIND_LABEL = { task: 'Task', grooming: 'Grooming', orchestration: 'Orchestrator', ask: 'Ask' };

function renderResourcePanel() {
  const snap = resourceSnapshot;
  const body = $('#resource-panel-body');
  if (!snap) {
    body.innerHTML = '<p class="res-empty">Sampling…</p>';
    $('#resource-panel-foot').textContent = '';
    return;
  }
  const sys = snap.system;
  const memPct = sys.memTotalBytes ? (sys.memUsedBytes / sys.memTotalBytes) * 100 : 0;
  const html = [];

  html.push('<div class="res-group-title">This machine</div>');
  html.push(resourceRowHtml({
    iconName: 'cpu',
    name: 'CPU',
    sub: `${sys.cpuCount} core${sys.cpuCount === 1 ? '' : 's'}${sys.loadAvg1 === null ? '' : ` · load ${sys.loadAvg1.toFixed(2)}`}`,
    cpuPercent: sys.cpuPercent,
  }));
  html.push(resourceRowHtml({
    iconName: 'bar-chart-3',
    name: 'Memory',
    mem: `${fmtBytes(sys.memUsedBytes)} / ${fmtBytes(sys.memTotalBytes)}`,
    memPercent: memPct,
  }));

  html.push('<div class="res-group-title">Sr. Popo</div>');
  html.push(resourceRowHtml({
    iconName: 'sliders-horizontal',
    name: 'App (board, server, terminals)',
    sub: `pid ${snap.app.pid} · ${snap.app.processes} process${snap.app.processes === 1 ? '' : 'es'}`,
    cpuPercent: snap.app.cpuPercent,
    mem: fmtBytes(snap.app.rssBytes),
  }));

  html.push(`<div class="res-group-title">Agent sessions (${snap.agents.length})</div>`);
  if (!snap.agents.length) {
    html.push('<p class="res-empty">No agent session is running right now.</p>');
  } else {
    for (const a of snap.agents) {
      const since = a.startedAt ? ` · started ${new Date(a.startedAt).toLocaleTimeString()}` : '';
      const label = RESOURCE_KIND_LABEL[a.kind] || 'Session';
      const backend = a.agent ? ` · ${a.agent}` : '';
      html.push(resourceRowHtml({
        iconName: RESOURCE_KIND_ICON[a.kind] || 'bot',
        name: a.title,
        sub: `${label}${backend} · ${a.processes} process${a.processes === 1 ? '' : 'es'}${since}`,
        cpuPercent: a.cpuPercent,
        mem: fmtBytes(a.rssBytes),
      }));
    }
  }

  html.push(resourceRowHtml({
    name: 'Total (app + agents)',
    cpuPercent: snap.totals.cpuPercent,
    mem: fmtBytes(snap.totals.rssBytes),
    total: true,
  }));

  if (snap.note) html.push(`<p class="res-note">${icon('triangle-alert')} ${esc(snap.note)}</p>`);
  body.innerHTML = html.join('');
  $('#resource-panel-foot').textContent =
    `CPU is a share of all ${sys.cpuCount} cores; memory is resident set size, summed per process. `
    + `Sampled ${new Date(snap.sampledAt).toLocaleTimeString()}. Nothing leaves this machine.`;
}

function renderResourceChip() {
  const chip = $('#btn-resources');
  chip.classList.toggle('hidden', !resourceMonitorOn());
  if (!resourceMonitorOn()) return;
  const snap = resourceSnapshot;
  if (!snap) {
    $('#resource-chip-text').textContent = '…';
    chip.classList.remove('warm', 'hot');
    chip.title = 'Resource monitor — sampling…';
    return;
  }
  const cpu = snap.totals.cpuPercent;
  $('#resource-chip-text').textContent = `${fmtCpu(cpu)} · ${fmtBytes(snap.totals.rssBytes)}`;
  // The chip is the only always-visible signal, so it colors up as the machine
  // gets busy — the thresholds are about the whole machine, not just us.
  const sysCpu = snap.system.cpuPercent || 0;
  chip.classList.toggle('hot', sysCpu >= 85);
  chip.classList.toggle('warm', sysCpu >= 60 && sysCpu < 85);
  chip.title = `Sr. Popo + ${snap.agents.length} agent session${snap.agents.length === 1 ? '' : 's'}: `
    + `${fmtCpu(cpu)} CPU · ${fmtBytes(snap.totals.rssBytes)} memory\n`
    + `This machine: ${fmtCpu(snap.system.cpuPercent)} CPU · ${fmtBytes(snap.system.memUsedBytes)} of ${fmtBytes(snap.system.memTotalBytes)} used\n`
    + 'Click for a per-session breakdown';
}

async function pollResources() {
  if (!resourceMonitorOn()) return;
  try {
    const snap = await api('GET', '/api/resources');
    resourceFails = 0;
    // The server is the source of truth for the toggle: if it says disabled,
    // stop polling and let the next `settings` broadcast restart us.
    if (!snap.enabled) {
      state.settings.resourceMonitor = false;
      resourceSnapshot = null;
      stopResourcePolling();
      closeResourcePanel();
      renderResourceChip();
      return;
    }
    resourceSnapshot = snap;
    renderResourceChip();
    if (resourcePanelOpen()) renderResourcePanel();
  } catch {
    if (++resourceFails >= 3) stopResourcePolling();
  }
}

function scheduleResourcePoll() {
  clearTimeout(resourceTimer);
  if (!resourceMonitorOn()) return;
  const wait = resourcePanelOpen() ? RESOURCE_POLL_OPEN_MS : RESOURCE_POLL_IDLE_MS;
  resourceTimer = setTimeout(async () => {
    // A hidden tab has nobody reading the chip — skip the sample, keep the loop.
    if (!document.hidden) await pollResources();
    scheduleResourcePoll();
  }, wait);
}

function startResourcePolling() {
  resourceFails = 0;
  pollResources();
  scheduleResourcePoll();
}

function stopResourcePolling() {
  clearTimeout(resourceTimer);
  resourceTimer = null;
}

// Called on boot and whenever settings change: start/stop the loop and keep the
// chip and any open panel in sync with the toggle.
function syncResourceMonitor() {
  if (resourceMonitorOn()) {
    if (!resourceTimer) startResourcePolling();
  } else {
    stopResourcePolling();
    resourceSnapshot = null;
    closeResourcePanel();
  }
  renderResourceChip();
}

function openResourcePanel() {
  const panel = $('#resource-panel');
  const chip = $('#btn-resources');
  panel.classList.remove('hidden');
  chip.setAttribute('aria-expanded', 'true');
  // Anchored under the chip and clamped into the viewport, like the IDE picker.
  const rect = chip.getBoundingClientRect();
  const width = panel.offsetWidth;
  panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  panel.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
  renderResourcePanel();
  pollResources();      // don't make the first read wait for the next tick
  scheduleResourcePoll(); // …and switch to the faster cadence while it's open
}

function closeResourcePanel() {
  $('#resource-panel').classList.add('hidden');
  $('#btn-resources').setAttribute('aria-expanded', 'false');
  scheduleResourcePoll();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-resources').addEventListener('click', () => {
    if (resourcePanelOpen()) closeResourcePanel();
    else openResourcePanel();
  });
  $('#resource-panel-close').addEventListener('click', closeResourcePanel);
  document.addEventListener('click', (e) => {
    if (!resourcePanelOpen()) return;
    if (e.target.closest('#resource-panel') || e.target.closest('#btn-resources')) return;
    closeResourcePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && resourcePanelOpen()) closeResourcePanel();
  });
  // Coming back to a hidden tab: refresh immediately rather than showing a stale
  // sample until the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && resourceMonitorOn()) pollResources();
  });
}


export { resourceMonitorOn, syncResourceMonitor };
