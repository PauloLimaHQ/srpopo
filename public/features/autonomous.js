/* Sr. Popo — autonomous. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { linearConfigured } from './linear.js';
import { saveSettings } from './settings-modal.js';
import { installedPluginIds, pluginInstalled, renderPluginState } from './settings.js';
import { currentWorkspaceRepoId } from './workspaces.js';


// ---------- autonomous mode ----------
const autonomousActive = () => !!(state.autonomous && state.autonomous.active);
// The active session is scoped to one repo; its controls only belong to that
// workspace. `null` here means "no session for the workspace I'm looking at".
function autonomousForWorkspace() {
  if (!autonomousActive()) return null;
  if (state.view.mode !== 'workspace') return null;
  return state.autonomous.repoId === state.view.repoId ? state.autonomous : null;
}

// Toggle the workspace-header Autonomous button and (when a session is live for
// this workspace) the live status banner.
function renderAutonomous() {
  const btn = $('#btn-autonomous');
  const banner = $('#autonomous-banner');
  const inWorkspace = state.view.mode === 'workspace';
  const installed = pluginInstalled('autonomous');
  // The button lives in the workspace header and only makes sense there.
  btn.classList.toggle('hidden', !(installed && inWorkspace));

  const sess = autonomousForWorkspace();
  if (installed && inWorkspace) {
    btn.innerHTML = sess
      ? `${icon('square')} <span class="btn-label">Stop Autonomous</span> <span class="autonomous-toggle-dot"></span>`
      : `${icon('bot')} <span class="btn-label">Autonomous</span>`;
    btn.title = sess ? 'Stop Autonomous Mode' : 'Autonomous Mode';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('active', !!sess);
  }

  if (!sess) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
  renderAutonomousBanner(sess);
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function renderAutonomousBanner(sess) {
  const banner = $('#autonomous-banner');
  const live = (sess.tasks || []).filter((t) => t.running);
  const done = (sess.tasks || []).filter((t) => t.status === 'done').length;
  const chips = live.map((t) => t.resolvingConflicts
    ? `<span class="chip conflict-chip">${icon('git-branch')} ${esc(t.title)} — resolving conflicts</span>`
    : `<span class="chip">${icon('loader')} ${esc(t.title)}</span>`).join('');
  const state_ = sess.stopping
    ? 'Stopping — letting in-flight runs finish'
    : live.length === 0
      ? 'Standing by — waiting for Ready tasks'
      : 'Running';
  const reviewTag = sess.reviewMode ? ' · reviewing' : '';
  banner.innerHTML = `
      <span class="autonomous-banner-head">
        <span class="autonomous-pulse"></span>${icon('bot')} Autonomous Mode${reviewTag}
      </span>
      <span class="autonomous-banner-reason">${esc(state_)}</span>
      <span class="autonomous-banner-spend">Spent <strong>${money(sess.spentUsd)}</strong> / ${money(sess.budgetUsd)}${done ? ` · ${done} merged` : ''}</span>
      <span class="autonomous-banner-tasks">${chips || '<span class="muted">No task in flight</span>'}</span>`;
  banner.classList.remove('hidden');
}

async function startAutonomous() {
  const repoId = currentWorkspaceRepoId();
  if (!repoId) return;
  const budgetUsd = Number($('#autonomous-budget').value);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return toast('Enter a budget greater than 0');
  const reviewMode = $('#autonomous-review-mode').checked;
  try {
    state.autonomous = await api('POST', '/api/autonomous/start', { repoId, budgetUsd, reviewMode });
    $('#modal-autonomous').classList.add('hidden');
    renderAutonomous();
  } catch (e) { toast(e.message); }
}

async function stopAutonomous() {
  try {
    state.autonomous = await api('POST', '/api/autonomous/stop', {});
    renderAutonomous();
  } catch (e) { toast(e.message); }
}

function openAutonomousModal() {
  const repo = state.repos.find((r) => r.id === currentWorkspaceRepoId());
  if (!repo) return;
  const ready = [...state.tasks.values()].filter((t) => t.repoId === repo.id && t.status === 'ready' && !t.archived).length;
  $('#autonomous-modal-repo').innerHTML =
    `<strong>${esc(repo.name)}</strong> — ${ready} task${ready === 1 ? '' : 's'} ready to run.`;
  $('#modal-autonomous').classList.remove('hidden');
  $('#autonomous-budget').focus();
}

// A plugin's config block (only Linear needs one today — its API key). Rendered
// inside the plugin card when installed. The password field always starts empty:
// we never echo the stored token back, only the redacted `linearConfigured` flag.
function pluginConfigHtml(p) {
  if (p.id !== 'linear' || !p.requiresApiKey) return '';
  const configured = linearConfigured();
  const note = configured
    ? 'A Linear API key is saved. Enter a new one to replace it, or clear it.'
    : 'Create a personal API key in Linear (Settings → Security & access → Personal API keys).';
  return `
      <div class="plugin-config">
        <label>Personal API key <span class="field-hint">— stored locally, used to import issues</span>
          <input class="plugin-key-input" type="password" placeholder="lin_api_…" autocomplete="off" />
        </label>
        <p class="addon-hint plugin-key-note">${esc(note)}</p>
        <div class="row">
          <button class="btn plugin-key-save">Save key</button>
          <button class="btn ghost plugin-key-clear${configured ? '' : ' hidden'}">Clear</button>
        </div>
      </div>`;
}

function pluginCardHtml(p, installed) {
  const badge = installed ? '<span class="plugin-badge">Installed</span>' : '';
  const action = installed
    ? '<button class="btn ghost plugin-uninstall">Uninstall</button>'
    : '<button class="btn primary plugin-install">Install</button>';
  return `
      <div class="plugin-card" data-plugin="${esc(p.id)}">
        <div class="plugin-card-icon">${icon(p.icon)}</div>
        <div class="plugin-card-body">
          <div class="plugin-card-head"><span class="plugin-card-name">${esc(p.name)}</span>${badge}</div>
          <p class="plugin-card-desc">${esc(p.description)}</p>
          ${installed ? pluginConfigHtml(p) : ''}
        </div>
        <div class="plugin-card-actions">${action}</div>
      </div>`;
}

// Two groups, Claude-desktop style: what's installed, and the rest of the
// marketplace still available to add.
function renderPlugins() {
  const body = $('#settings-plugins-body');
  if (!body) return;
  const installed = state.plugins.filter((p) => pluginInstalled(p.id));
  const available = state.plugins.filter((p) => !pluginInstalled(p.id));
  body.innerHTML = `
      <div class="plugin-group">
        <div class="plugin-group-title">Installed</div>
        ${installed.length
        ? installed.map((p) => pluginCardHtml(p, true)).join('')
        : '<p class="plugin-empty">No plugins installed yet.</p>'}
      </div>
      <div class="plugin-group">
        <div class="plugin-group-title">Marketplace</div>
        ${available.length
        ? available.map((p) => pluginCardHtml(p, false)).join('')
        : '<p class="plugin-empty">You\'ve installed everything available.</p>'}
      </div>`;
}

async function setInstalledPlugins(ids) {
  await saveSettings({ installedPlugins: ids });
  renderPlugins();
  renderPluginState();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // Delegated handlers for the dynamically-rendered plugin cards.
  $('#settings-plugins-body').addEventListener('click', async (e) => {
    const card = e.target.closest('.plugin-card');
    if (!card) return;
    const id = card.dataset.plugin;
    if (e.target.closest('.plugin-install')) {
      await setInstalledPlugins([...installedPluginIds(), id]);
      toast('Plugin installed', 'info');
    } else if (e.target.closest('.plugin-uninstall')) {
      await setInstalledPlugins(installedPluginIds().filter((x) => x !== id));
      toast('Plugin uninstalled', 'info');
    } else if (e.target.closest('.plugin-key-save')) {
      const input = card.querySelector('.plugin-key-input');
      const token = (input && input.value.trim()) || '';
      if (!token) { toast('Paste your Linear API key first'); return; }
      await saveSettings({ linearApiToken: token });
      renderPlugins();
      toast('Linear API key saved', 'info');
    } else if (e.target.closest('.plugin-key-clear')) {
      await saveSettings({ linearApiToken: '' });
      renderPlugins();
      toast('Linear API key cleared', 'info');
    }
  });
}


export { autonomousForWorkspace, money, openAutonomousModal, renderAutonomous, renderPlugins, startAutonomous, stopAutonomous };
