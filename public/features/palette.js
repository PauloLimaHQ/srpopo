/* Sr. Popo — palette. No build step: native ES module. */
import { esc } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, MOD, icon, isLive, state } from '../core/state.js';
import { defaultEditor, openInIde, revealPath } from './desktop.js';
import { openDrawer } from './drawer.js';
import { tasksForRepo } from './filters.js';
import { openBriefModal } from './grooming.js';
import { openLinearModal } from './linear.js';
import { openMemoryModal } from './memory.js';
import { openOrchestrateModal } from './orchestrate.js';
import { openReposModal } from './repos-modal.js';
import { openSettingsModal } from './settings-modal.js';
import { pluginInstalled } from './settings.js';
import { openShortcutsModal } from './shortcuts.js';
import { openSpecsModal } from './specs.js';
import { activeTabKey, closeTab, tabsOn } from './tabs.js';
import { openTaskModal } from './task-modal.js';
import { STATUS_LABEL, allSessions, availableKinds, focusSession, newSession, openTerminalAt } from './terminal.js';
import { LAYOUT_LABEL, THEME_LABEL, currentLayout, currentTheme, cycleTheme, toggleLayout } from './theme.js';
import { currentWorkspaceRepoId, enterWorkspace, exitWorkspace, openWorkspacePopover } from './workspaces.js';


// ---------- command palette (⌘K) ----------
// A quick switcher: jump straight to any task by name, or run a top-bar
// action, without hunting across columns/filters or reaching for the mouse.
let paletteResults = []; // flat, in on-screen order: { type: 'command'|'workspace'|'session'|'task', item }
let paletteActive = 0;

// The same green/amber/red bullet the terminal tabs and sidebar rows use.
const SESSION_DOT = { active: 'var(--green)', idle: 'var(--amber, #d1a03c)', exited: 'var(--red)' };
const repoNameOf = (s) => state.repos.find((r) => r.id === s.repoId)?.name || '';

function paletteCommands() {
  return [
    { label: 'New Task', hint: 'Start a task from scratch', icon: 'plus', kbd: `${MOD}N`, run: () => openTaskModal() },
    // Plugin-gated commands surface only when their plugin is installed.
    ...(pluginInstalled('grooming')
      ? [{ label: 'Brief an Idea', hint: 'Groom a rough idea into tasks', icon: 'lightbulb', run: () => openBriefModal() }]
      : []),
    ...(pluginInstalled('orchestration')
      ? [{ label: 'Orchestrate a Goal', hint: 'Let an orchestrator agent plan and drive it', icon: 'crown', run: () => openOrchestrateModal() }]
      : []),
    ...(pluginInstalled('linear')
      ? [{ label: 'Create Task from Linear', hint: 'Import an assigned issue', icon: 'linear', run: () => openLinearModal() }]
      : []),
    ...(pluginInstalled('repo-specs')
      ? [{ label: 'Import from Specs', hint: 'Pick spec files to import as tasks', icon: 'folder', run: () => openSpecsModal() }]
      : []),
    { label: 'Repositories', hint: 'Add or manage repos', icon: 'folder', run: () => openReposModal() },
    { label: 'Super View', hint: 'Back to the all-workspaces home screen', icon: 'arrow-left', run: () => exitWorkspace() },
    // Only the tabbed layout has a tab to close; in the classic one there is
    // nothing this would act on.
    ...(tabsOn()
      ? [{ label: 'Close Tab', hint: 'Close the tab in front (ends it, if it is a session)', icon: 'x', run: () => closeTab(activeTabKey()) }]
      : []),
    // The open workspace's own actions — the keyboard path to what the header's
    // Terminal button and "…" menu do.
    ...(state.view.repoId
      ? [
        { label: 'Open Terminal', hint: 'A shell on this workspace checkout', icon: 'terminal', run: () => openTerminalAt(state.view.repoId) },
        // One entry per agent CLI installed here, so "new claude session" is a
        // keystroke away instead of a trip through the panel's + menu.
        ...availableKinds().filter((k) => k.kind !== 'shell').map((k) => ({
          label: `New ${k.label} Session`,
          hint: `${k.hint} on this workspace checkout`,
          icon: k.icon,
          run: () => newSession(state.view.repoId, k.kind),
        })),
        { label: `Reveal in ${state.desktop.fileManager || 'file manager'}`, hint: 'Show the checkout in your file manager', icon: 'folder-open', run: () => revealPath(state.view.repoId) },
        { label: defaultEditor() ? `Open in ${defaultEditor().label}` : 'Open in IDE', hint: 'Open the checkout in your editor', icon: 'code', run: () => openInIde(state.view.repoId, null, $('#workspace-more')) },
        { label: 'Project Memory', hint: 'Notes every agent reads for this repo', icon: 'brain', run: () => openMemoryModal(state.view.repoId) },
        { label: 'Workspace Details', hint: 'Path, branch and live worktrees', icon: 'info', run: () => openWorkspacePopover() },
      ]
      : []),
    { label: 'Settings', hint: 'Notifications, sounds, Linear key', icon: 'settings', kbd: `${MOD},`, run: () => openSettingsModal() },
    { label: 'Toggle Theme', hint: `Currently ${THEME_LABEL[currentTheme()]} — set it in Settings → Appearance`, icon: 'sun-moon', run: () => cycleTheme() },
    { label: 'Toggle Layout', hint: `Currently ${LAYOUT_LABEL[currentLayout()]} — the project sidebar is experimental`, icon: 'panel-left', run: () => toggleLayout() },
    { label: 'Filter Tasks', hint: 'Jump to the filter box', icon: 'search', kbd: '/', run: () => $('#filter-search').focus() },
    { label: 'Keyboard Shortcuts', hint: 'See all shortcuts', icon: 'keyboard', kbd: '?', run: () => openShortcutsModal() },
  ];
}

function paletteRow(index, opts) {
  return `<div class="palette-option" data-index="${index}">
      ${opts.dot ? `<span class="palette-status-dot" style="background:${opts.dot}"></span>`
      : `<span class="palette-option-icon">${icon(opts.icon)}</span>`}
      <span class="palette-option-body">
        <span class="palette-option-label">${esc(opts.label)}</span>
        <span class="palette-option-hint">${esc(opts.hint)}</span>
      </span>
      ${opts.kbd ? `<span class="kbd">${esc(opts.kbd)}</span>` : ''}
    </div>`;
}

function renderPalette(query) {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text) => tokens.every((t) => text.includes(t));

  const cmds = paletteCommands().filter((c) => matches(`${c.label} ${c.hint}`.toLowerCase()));
  // Workspaces to switch into — the current one is omitted (switching to it is a no-op).
  const repos = state.repos
    .filter((r) => currentWorkspaceRepoId() !== r.id)
    .filter((r) => matches(`${r.name} ${r.path}`.toLowerCase()));
  // Live shell sessions — the keyboard route into one, since they aren't cards
  // and so never show up in the task list below.
  const sessions = allSessions().filter((s) => matches(`${s.label} ${repoNameOf(s)} ${s.cwd}`.toLowerCase()));
  const allTasks = [...state.tasks.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const tasks = (tokens.length ? allTasks.filter((t) => matches(`${t.title} ${t.repoName}`.toLowerCase())) : allTasks.slice(0, 6))
    .slice(0, 8);

  paletteResults = [
    ...cmds.map((item) => ({ type: 'command', item })),
    ...repos.map((item) => ({ type: 'workspace', item })),
    ...sessions.map((item) => ({ type: 'session', item })),
    ...tasks.map((item) => ({ type: 'task', item })),
  ];
  paletteActive = 0;

  const results = $('#palette-results');
  if (!paletteResults.length) {
    results.innerHTML = '<div class="palette-empty">No matches</div>';
    return;
  }
  let html = '';
  if (cmds.length) {
    html += '<div class="palette-group">Commands</div>';
    html += cmds.map((c, i) => paletteRow(i, c)).join('');
  }
  if (repos.length) {
    html += '<div class="palette-group">Workspaces</div>';
    html += repos.map((r, i) => {
      const live = tasksForRepo(r.id).filter(isLive).length;
      return paletteRow(cmds.length + i, {
        label: r.name, icon: 'folder', hint: live ? `Switch workspace · ${live} live` : 'Switch workspace',
      });
    }).join('');
  }
  if (sessions.length) {
    html += '<div class="palette-group">Sessions</div>';
    html += sessions.map((s, i) => paletteRow(cmds.length + repos.length + i, {
      label: s.label, hint: `${repoNameOf(s)} · ${STATUS_LABEL[s.status]}`, dot: SESSION_DOT[s.status],
    })).join('');
  }
  if (tasks.length) {
    html += `<div class="palette-group">${tokens.length ? 'Tasks' : 'Recent tasks'}</div>`;
    html += tasks.map((t, i) => paletteRow(cmds.length + repos.length + sessions.length + i, {
      label: t.title, hint: `${t.repoName} · ${t.status}`, dot: COLUMNS.find((c) => c.key === COLUMN_OF_STATUS[t.status]).dot,
    })).join('');
  }
  results.innerHTML = html;
  updatePaletteActive();
}

function updatePaletteActive() {
  const results = $('#palette-results');
  results.querySelectorAll('.palette-option').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.index) === paletteActive);
  });
  const activeEl = results.querySelector('.palette-option.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

function movePaletteActive(delta) {
  if (!paletteResults.length) return;
  paletteActive = (paletteActive + delta + paletteResults.length) % paletteResults.length;
  updatePaletteActive();
}

function activatePalette(index) {
  const entry = paletteResults[index];
  if (!entry) return;
  closePalette();
  if (entry.type === 'command') entry.item.run();
  else if (entry.type === 'workspace') enterWorkspace(entry.item.id);
  else if (entry.type === 'session') focusSession(entry.item.id);
  else openDrawer(entry.item.id);
}

function openPalette() {
  $('#palette-input').value = '';
  renderPalette('');
  $('#modal-palette').classList.remove('hidden');
  $('#palette-input').focus();
}
function closePalette() { $('#modal-palette').classList.add('hidden'); }

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#btn-palette').addEventListener('click', openPalette);
  $('#modal-palette').addEventListener('click', (e) => { if (e.target.id === 'modal-palette') closePalette(); });
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activatePalette(paletteActive); }
  });
  $('#palette-results').addEventListener('click', (e) => {
    const row = e.target.closest('.palette-option');
    if (row) activatePalette(Number(row.dataset.index));
  });
  $('#palette-results').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.palette-option');
    if (row && Number(row.dataset.index) !== paletteActive) {
      paletteActive = Number(row.dataset.index);
      updatePaletteActive();
    }
  });
}


export { openPalette };
