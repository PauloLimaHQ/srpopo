/* Sr. Popo — scripts. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { anchorMenu, menuArrowNav } from './desktop.js';
import { pluginInstalled } from './settings.js';
import { openSession } from './terminal.js';


// ---- package scripts (the workspace's Run button) ----
// Half of "does this work?" is starting the thing, so a workspace whose
// checkout has a package.json gets a Run split button next to Terminal: the
// main half starts the project (the first of dev/start/serve the manifest has),
// the caret lists every script. Both open an in-app terminal session with the
// command typed at its prompt (server/scripts.ts builds it from the project's
// own package manager), so a run is a shell you can watch, Ctrl-C and re-run —
// not a background process the board has to babysit.
//
// Gated on the Node Scripts plugin: with it uninstalled the button never shows
// and the routes 400.

// repoId -> manifest ({ manager, scripts, primary }) | 'loading'. Cached like
// the branch/worktree lookups, and re-read whenever the menu is opened so a
// script added mid-session shows up without a reload.
const manifests = new Map();

const PLUGIN = 'node-scripts';
const manifestFor = (repoId) => {
  const m = manifests.get(repoId);
  return m && m !== 'loading' ? m : null;
};

// A command line is a tooltip, not a paragraph — the full text stays in `title`.
const trim = (s, max = 72) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

async function loadScripts(repoId, force) {
  if (!repoId || (!force && manifests.has(repoId))) return;
  manifests.set(repoId, 'loading');
  let manifest = { manager: null, scripts: [], primary: null };
  try { manifest = await api('GET', `/api/repos/${repoId}/scripts`); } catch { /* no scripts, no button */ }
  manifests.set(repoId, manifest);
  if (state.view.mode === 'workspace' && state.view.repoId === repoId) renderRunButton();
}

// Called from renderWorkspaceHeader, so the button follows whichever workspace
// is in front and disappears again for a repo with no package.json.
function renderRunButton() {
  const split = $('#workspace-run-split');
  const repoId = state.view.mode === 'workspace' ? state.view.repoId : null;
  if (!repoId || !pluginInstalled(PLUGIN)) {
    split.classList.add('hidden');
    closeScriptsMenu();
    return;
  }
  loadScripts(repoId);
  const manifest = manifestFor(repoId);
  const scripts = manifest ? manifest.scripts : [];
  split.classList.toggle('hidden', !scripts.length);
  if (!scripts.length) { closeScriptsMenu(); return; }
  const primary = manifest.primary;
  const run = $('#workspace-run');
  $('#workspace-run-label').textContent = primary ? `Run ${primary}` : 'Run';
  run.title = primary
    ? `${manifest.manager} run ${primary} — in a terminal on this checkout`
    : `Pick one of this project's ${manifest.manager} scripts`;
}

// ---- the menu of every script ----
function scriptsMenuOpen() { return !$('#scripts-menu').classList.contains('hidden'); }

function renderScriptsMenu(repoId) {
  const manifest = manifestFor(repoId);
  if (!manifest) return;
  const items = manifest.scripts.map((s) => `
      <button class="quick-menu-item" role="menuitem" data-script="${esc(s.name)}"
              title="${esc(`${manifest.manager} run ${s.name}\n${s.command}`)}">
        ${icon(s.name === manifest.primary ? 'play' : 'terminal')}
        <span class="quick-menu-item-body">
          <span class="quick-menu-item-label">${esc(s.name)}</span>
          <span class="quick-menu-item-hint mono">${esc(trim(s.command))}</span>
        </span>
      </button>`).join('');
  $('#scripts-menu').innerHTML = `<div class="quick-menu-title">${esc(manifest.manager)} scripts</div>${items}`;
}

async function openScriptsMenu(focusFirst) {
  const repoId = state.view.repoId;
  if (!repoId || !manifestFor(repoId)) return;
  const menu = $('#scripts-menu');
  renderScriptsMenu(repoId);
  menu.classList.remove('hidden');
  anchorMenu(menu, $('#workspace-run-caret'));
  $('#workspace-run-caret').setAttribute('aria-expanded', 'true');
  if (focusFirst) menu.querySelector('.quick-menu-item')?.focus();
  // package.json is edited far more often than the board is reloaded, so the
  // list is re-read every time it's asked for — the fetch lands after the menu
  // is already up, and only redraws it if it changed shape.
  const before = JSON.stringify(manifestFor(repoId));
  await loadScripts(repoId, true);
  if (scriptsMenuOpen() && state.view.repoId === repoId && JSON.stringify(manifestFor(repoId)) !== before) {
    renderScriptsMenu(repoId);
    anchorMenu(menu, $('#workspace-run-caret'));
  }
}

function closeScriptsMenu(refocus) {
  if (!scriptsMenuOpen()) return;
  $('#scripts-menu').classList.add('hidden');
  $('#workspace-run-caret').setAttribute('aria-expanded', 'false');
  if (refocus) $('#workspace-run-caret').focus();
}

// Runs one script in a fresh terminal session on the repo checkout. The server
// resolves the *name* against the manifest — the command never travels from
// here — and openSession owns the pane, the sizing and the failure path.
function runScript(repoId, name) {
  closeScriptsMenu();
  if (!repoId || !name) return null;
  return openSession(repoId, (dims) => api('POST', `/api/repos/${repoId}/scripts/run`, {
    script: name,
    cols: dims ? dims.cols : undefined,
    rows: dims ? dims.rows : undefined,
  }));
}

// The main half of the split button: start the project if the manifest says
// which script that is, else show the list rather than guessing.
function runPrimary() {
  const repoId = state.view.repoId;
  const manifest = repoId ? manifestFor(repoId) : null;
  if (!manifest || !manifest.scripts.length) { toast('No package scripts in this checkout', 'info'); return; }
  if (manifest.primary) runScript(repoId, manifest.primary);
  else openScriptsMenu(true);
}

// ⌘K entries — one per script of the workspace in front, so a run is a
// keystroke away without a trip through the header.
function scriptCommands() {
  const repoId = state.view.mode === 'workspace' ? state.view.repoId : null;
  const manifest = repoId && pluginInstalled(PLUGIN) ? manifestFor(repoId) : null;
  if (!manifest) return [];
  return manifest.scripts.map((s) => ({
    label: `Run ${s.name}`,
    hint: `${manifest.manager} run ${s.name} — in a terminal on this checkout`,
    icon: 'play',
    run: () => runScript(repoId, s.name),
  }));
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#workspace-run').addEventListener('click', runPrimary);
  $('#workspace-run-caret').addEventListener('click', (e) => {
    e.stopPropagation();
    scriptsMenuOpen() ? closeScriptsMenu() : openScriptsMenu();
  });
  $('#workspace-run-caret').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || scriptsMenuOpen()) return;
    e.preventDefault();
    openScriptsMenu(true);
  });
  $('#scripts-menu').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeScriptsMenu(true); return; }
    menuArrowNav($('#scripts-menu'), e);
  });
  $('#scripts-menu').addEventListener('click', (e) => {
    const name = e.target.closest('[data-script]')?.dataset.script;
    if (name) runScript(state.view.repoId, name);
  });
  document.addEventListener('click', (e) => {
    if (!scriptsMenuOpen()) return;
    if (e.target.closest('#scripts-menu') || $('#workspace-run-split').contains(e.target)) return;
    closeScriptsMenu();
  });
}


export { closeScriptsMenu, loadScripts, renderRunButton, runScript, scriptCommands, scriptsMenuOpen };
