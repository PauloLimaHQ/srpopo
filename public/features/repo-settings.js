/* Sr. Popo — repo-settings. No build step: native ES module.
 *
 * The workspace-settings modal: one repository's branch-naming convention plus
 * the values new tasks / groomings created in it are prefilled with.
 *
 * Everything here is a *default*. A task's own value always wins, and the
 * app-wide Settings (merge strategy, minimum merge grade, autonomous budget, …)
 * are untouched — those stay in the Settings modal. Server side this is
 * server/repoSettings.ts, which is the authority on validation and on how a
 * branch template resolves; the copies below only exist to prefill a form and
 * preview a name as you type.
 *
 * A control left on "App default" is *unset*, not pinned — that is what keeps a
 * workspace on Sr. Popo's built-in behavior, and what "Reset to app defaults"
 * (PATCH with `{ settings: {} }`) puts it back to.
 */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { addonChipsHtml } from './task-modal.js';


// ---------- reading a workspace's settings ----------
// The repo's stored settings, or `{}` — mirrors repoSettings.forRepo so callers
// can read a key without a null check.
function repoSettingsFor(repoId) {
  return state.repos.find((r) => r.id === repoId)?.settings || {};
}

// Has this workspace got anything configured? When it has, the New Task modal
// prefills from it and ignores the browser's last-used memory entirely.
function wsConfigured(s) {
  return !!s && Object.keys(s).length > 0;
}

// The workspace's task defaults, shaped exactly like loadLastUsed()'s object so
// the New Task modal can swap one for the other. Unset keys stay undefined, so
// the modal's own hardcoded fallbacks still apply to them.
function wsTaskDefaults(ws) {
  return {
    agent: ws.agent,
    model: ws.model,
    permissionMode: ws.permissionMode,
    allowedTools: ws.allowedTools,
    useWorktree: ws.useWorktree,
    addons: ws.addons,
    prDraft: false, // not a workspace default — the PR mode is per task
    autoCodeReview: ws.autoCodeReview,
    personas: ws.personas,
    autoPersona: ws.autoPersona,
  };
}

// The workspace's "Brief an Idea" defaults, same idea as above.
function wsGroomDefaults(ws) {
  return { model: ws.groomModel, target: ws.groomTarget };
}


// ---------- the modal ----------
// Which repo the open modal is editing, and the settings it was opened with —
// `loaded` is what tells collectSettings() which checkboxes were already
// configured (see there); clearing a section drops keys from it too.
let settingsRepoId = null;
let loaded = {};
// Checkboxes the user actually touched this time round. A checkbox has no
// "unset" position, so an untouched one must not silently persist `false`.
const touchedBools = new Set();
// What an *unset* toggle shows: the value a new task gets today when nothing is
// configured. Worktree is on because that is the New Task modal's own default.
const BOOL_DEFAULTS = { useWorktree: true, autoCodeReview: false, autoPersona: false };

// A sample task, so the branch preview shows a realistic name rather than the
// raw tokens.
const SAMPLE_TITLE = 'Add a dark mode toggle';
const SAMPLE_ID = 'a1b2c3d4e5';

// What a template resolves to — the same substitution and ref sanitizing
// server/repoSettings.ts does. That copy stays the authority (it is what names
// the branch at dispatch); this one only makes the field's effect visible.
function previewBranch(template) {
  if (!String(template || '').trim()) return null;
  const slug = SAMPLE_TITLE.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  const date = new Date().toISOString().slice(0, 10);
  let name = String(template)
    .replace(/\{slug\}/g, slug)
    .replace(/\{id\}/g, SAMPLE_ID)
    .replace(/\{date\}/g, date)
    .replace(/\s+/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f~^:?*[\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-');
  while (name.endsWith('.lock')) name = name.slice(0, -'.lock'.length);
  name = name.replace(/^[/.]+/, '').replace(/[/.]+$/, '');
  return name || null;
}

function renderBranchPreview() {
  const template = $('#repo-settings-branch-template').value;
  const el = $('#repo-settings-branch-preview');
  if (!template.trim()) {
    el.innerHTML = `A task titled “${esc(SAMPLE_TITLE)}” would branch as <code>srpopo/${esc(previewBranch('{slug}-{id}') || '')}</code>.`;
    return;
  }
  const resolved = previewBranch(template);
  el.innerHTML = resolved
    ? `A task titled “${esc(SAMPLE_TITLE)}” would branch as <code>${esc(resolved)}</code>.`
    : `${icon('triangle-alert')} <span>That template doesn't leave a usable branch name — tasks would fall back to <code>srpopo/&lt;slug&gt;-&lt;id&gt;</code>.</span>`;
}

// Show only the chosen agent's models, the same way the New Task composer does.
// "App default" (an empty agent) means Claude, so its models are what show.
function syncRepoAgentModels() {
  const agent = $('#repo-settings-agent').value || 'claude';
  const sel = $('#repo-settings-model');
  for (const opt of sel.options) {
    const a = opt.dataset.agent || (opt.dataset.custom ? 'claude' : null);
    opt.hidden = a ? a !== agent : false;
  }
  // A model belonging to another backend would be silently dropped server-side;
  // fall back to "unset" instead of leaving an invisible selection.
  if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden) sel.value = '';
}

// Personas as toggle chips — seven of them, so a chip row reads better here than
// the New Task composer's searchable picker. Hidden while Auto persona is on,
// which is what the run then uses instead.
function renderPersonaChips(selected = []) {
  const chosen = new Set(selected);
  $('#repo-settings-persona-list').innerHTML = state.personas.map((p) => `
      <label class="opt-chip" title="${esc(p.hint || p.label)}">
        <input type="checkbox" data-persona="${esc(p.id)}" ${chosen.has(p.id) ? 'checked' : ''} />
        ${icon('persona')}${esc(p.label)}
      </label>`).join('');
  syncAutoPersona();
}

function syncAutoPersona() {
  $('#repo-settings-persona-list').classList.toggle('hidden', $('#repo-settings-auto-persona').checked);
}

// The repo's local branches, with a leading "Repository HEAD" option that means
// unset. A stored branch that no longer exists is kept listed and marked, so
// saving the form can't silently drop it.
async function loadBaseBranches(repoId, selected) {
  const sel = $('#repo-settings-base-branch');
  sel.innerHTML = '<option value="">Repository HEAD</option>';
  sel.value = '';
  let current = null, branches = [];
  try { ({ current, branches } = await api('GET', `/api/repos/${repoId}/branches`)); } catch { /* leave just the HEAD option */ }
  if (settingsRepoId !== repoId) return; // a racing reopen already moved on
  if (current && !branches.includes(current)) branches = [current, ...branches];
  if (selected && !branches.includes(selected)) branches = [...branches, selected];
  sel.innerHTML = '<option value="">Repository HEAD</option>' + branches.map((b) => {
    const note = b === current ? ' (current)' : '';
    return `<option value="${esc(b)}">${esc(b)}${esc(note)}</option>`;
  }).join('');
  sel.value = selected || '';
}

function openRepoSettingsModal(repoId) {
  const id = repoId || state.view.repoId;
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) { toast('Open a workspace first'); return; }
  settingsRepoId = repo.id;
  loaded = { ...repoSettingsFor(repo.id) };
  touchedBools.clear();

  $('#repo-settings-sub').textContent =
    `Defaults for ${repo.name}. New tasks and ideas here start from these; a task's own settings still win.`;
  $('#repo-settings-branch-template').value = loaded.branchTemplate || '';
  renderBranchPreview();
  loadBaseBranches(repo.id, loaded.baseBranch || '');

  $('#repo-settings-agent').value = loaded.agent || '';
  $('#repo-settings-model').value = loaded.model || '';
  syncRepoAgentModels();
  $('#repo-settings-perm').value = loaded.permissionMode || '';
  $('#repo-settings-allowed-tools').value = loaded.allowedTools || '';
  for (const el of document.querySelectorAll('#repo-settings-options input[data-bool]')) {
    const key = el.dataset.bool;
    el.checked = key in loaded ? !!loaded[key] : BOOL_DEFAULTS[key];
  }
  $('#repo-settings-addon-list').innerHTML = addonChipsHtml(loaded.addons || [], false, false);
  renderPersonaChips(loaded.personas || []);
  $('#repo-settings-advanced').open = !!loaded.allowedTools;

  $('#repo-settings-groom-model').value = loaded.groomModel || '';
  $('#repo-settings-groom-target').value = loaded.groomTarget || '';

  $('#modal-repo-settings').classList.remove('hidden');
  $('#repo-settings-branch-template').focus();
}

// The form as a settings object. Empty strings and empty arrays are dropped
// server-side (repoSettings.sanitize), so "App default" really does unset a
// field. Booleans are the exception — see `touchedBools`.
function collectSettings() {
  const settings = {
    branchTemplate: $('#repo-settings-branch-template').value,
    baseBranch: $('#repo-settings-base-branch').value,
    agent: $('#repo-settings-agent').value,
    model: $('#repo-settings-model').value,
    permissionMode: $('#repo-settings-perm').value,
    addons: [...document.querySelectorAll('#repo-settings-addon-list input[data-addon]:checked')]
      .map((el) => el.dataset.addon),
    personas: [...document.querySelectorAll('#repo-settings-persona-list input[data-persona]:checked')]
      .map((el) => el.dataset.persona),
    allowedTools: $('#repo-settings-allowed-tools').value,
    groomModel: $('#repo-settings-groom-model').value,
    groomTarget: $('#repo-settings-groom-target').value,
  };
  for (const el of document.querySelectorAll('#repo-settings-options input[data-bool]')) {
    const key = el.dataset.bool;
    if (touchedBools.has(key) || key in loaded) settings[key] = el.checked;
  }
  return settings;
}

async function saveRepoSettings(settings) {
  if (!settingsRepoId) return;
  try {
    const repo = await api('PATCH', `/api/repos/${settingsRepoId}`, { settings });
    // The `repos` broadcast refreshes every board, but update ours right away so
    // reopening the modal (or a New Task) reflects the save without a round trip.
    const i = state.repos.findIndex((r) => r.id === repo.id);
    if (i >= 0) state.repos[i] = repo;
    $('#modal-repo-settings').classList.add('hidden');
    settingsRepoId = null;
    toast(wsConfigured(repo.settings || {}) ? 'Workspace settings saved' : 'Workspace back on the app defaults', 'info');
  } catch (e) { toast(e.message); }
}

// Un-pin one section: put its controls back on "App default" and forget what was
// stored for them, so saving really does unset them. This is the only way back
// for a checkbox, which has no unset position of its own.
function clearSection(which) {
  const forget = (...keys) => keys.forEach((k) => { delete loaded[k]; touchedBools.delete(k); });
  if (which === 'branches') {
    $('#repo-settings-branch-template').value = '';
    $('#repo-settings-base-branch').value = '';
    renderBranchPreview();
    forget('branchTemplate', 'baseBranch');
  } else if (which === 'task') {
    $('#repo-settings-agent').value = '';
    $('#repo-settings-model').value = '';
    syncRepoAgentModels();
    $('#repo-settings-perm').value = '';
    $('#repo-settings-allowed-tools').value = '';
    for (const el of document.querySelectorAll('#repo-settings-options input[data-bool]')) {
      el.checked = BOOL_DEFAULTS[el.dataset.bool];
    }
    for (const el of document.querySelectorAll('#repo-settings-addon-list input[data-addon]')) el.checked = false;
    for (const el of document.querySelectorAll('#repo-settings-persona-list input[data-persona]')) el.checked = false;
    syncAutoPersona();
    forget('agent', 'model', 'permissionMode', 'allowedTools', 'addons', 'personas',
      'useWorktree', 'autoCodeReview', 'autoPersona');
  } else if (which === 'groom') {
    $('#repo-settings-groom-model').value = '';
    $('#repo-settings-groom-target').value = '';
    forget('groomModel', 'groomTarget');
  }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // The "…" menu item that opens this is wired in features/workspace-header.js,
  // next to the other workspace quick actions.
  $('#repo-settings-cancel').addEventListener('click', () => {
    $('#modal-repo-settings').classList.add('hidden');
    settingsRepoId = null;
  });
  $('#repo-settings-save').addEventListener('click', () => saveRepoSettings(collectSettings()));
  $('#repo-settings-reset').addEventListener('click', () => saveRepoSettings({}));
  $('#repo-settings-branch-template').addEventListener('input', renderBranchPreview);
  $('#repo-settings-agent').addEventListener('change', syncRepoAgentModels);
  $('#repo-settings-auto-persona').addEventListener('change', syncAutoPersona);
  $('#repo-settings-options').addEventListener('change', (e) => {
    const key = e.target.dataset?.bool;
    if (key) touchedBools.add(key);
  });
  for (const btn of document.querySelectorAll('.repo-settings-clear')) {
    btn.addEventListener('click', () => clearSection(btn.dataset.clear));
  }
}


export { openRepoSettingsModal, repoSettingsFor, wsConfigured, wsGroomDefaults, wsTaskDefaults };
