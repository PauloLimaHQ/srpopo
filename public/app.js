/* Sr. Popo — frontend entry. No build step: native ES modules.
 *
 * This file only wires the app together. Every feature lives in its own module
 * under features/ (shared state and the API client live under core/), so a
 * change to one feature touches one file. The init() calls below run in the
 * same order the wiring ran when this was a single file — keep that order.
 */
import { api, toast } from './core/api.js';
import { $, MOD, state } from './core/state.js';
import { handleHashDeeplink } from './features/deeplinks.js';
import { loadDesktop } from './features/desktop.js';
import { loadFilters } from './features/filters.js';
import { connectSSE } from './features/live.js';
import { syncCustomModelOptions } from './features/models.js';
import { syncResourceMonitor } from './features/resources.js';
import { renderPluginState } from './features/settings.js';
import { restoreActiveTab } from './features/tabs.js';
import { loadTerminalSessions } from './features/terminal.js';
import { initLayout, initTheme } from './features/theme.js';
import { loadView, renderView } from './features/workspaces.js';
import { init as initWorkspacePicker } from './features/workspace-picker.js';
import { init as initSidebar } from './features/sidebar.js';
import { init as initTabs } from './features/tabs.js';
import { init as initTerminal } from './features/terminal.js';
import { init as initDesktop } from './features/desktop.js';
import { init as initWorkspaceMenu } from './features/workspace-menu.js';
import { init as initResources } from './features/resources.js';
import { init as initMemory } from './features/memory.js';
import { init as initWorkspaceHeader } from './features/workspace-header.js';
import { init as initCards } from './features/cards.js';
import { init as initDnd } from './features/dnd.js';
import { init as initPermissions } from './features/permissions.js';
import { init as initContextMenu } from './features/context-menu.js';
import { init as initFollowup } from './features/followup.js';
import { init as initTaskModal } from './features/task-modal.js';
import { init as initAttachments } from './features/attachments.js';
import { init as initAsk } from './features/ask.js';
import { init as initGrooming } from './features/grooming.js';
import { init as initOrchestrate } from './features/orchestrate.js';
import { init as initLinear } from './features/linear.js';
import { init as initSpecs } from './features/specs.js';
import { init as initSounds } from './features/sounds.js';
import { init as initAutonomous } from './features/autonomous.js';
import { init as initUsage } from './features/usage.js';
import { init as initSettingsModal } from './features/settings-modal.js';
import { init as initModels } from './features/models.js';
import { init as initRemote } from './features/remote.js';
import { init as initReposModal } from './features/repos-modal.js';
import { init as initFilterBar } from './features/filter-bar.js';
import { init as initPalette } from './features/palette.js';
import { init as initShortcuts } from './features/shortcuts.js';
import { init as initElectron } from './features/electron.js';
import { init as initDrawerClose } from './features/drawer-close.js';
import { init as initDeeplinks } from './features/deeplinks.js';


// ---------- boot ----------
async function boot() {
  try {
    const { repos, tasks, groomings, orchestrations, settings, autonomous } = await api('GET', '/api/state');
    state.repos = repos;
    state.tasks = new Map(tasks.map((t) => [t.id, t]));
    state.groomings = new Map((groomings || []).map((g) => [g.id, g]));
    state.orchestrations = new Map((orchestrations || []).map((o) => [o.id, o]));
    state.autonomous = autonomous || null;
    // Seed live tool-approval prompts, then drop the transient field off the task.
    state.permissions = new Map();
    state.autoApprove = new Set();
    for (const t of tasks) {
      if (t.pendingPermissions && t.pendingPermissions.length) state.permissions.set(t.id, t.pendingPermissions);
      if (t.autoApprovePermissions) state.autoApprove.add(t.id);
      delete t.pendingPermissions;
      delete t.autoApprovePermissions;
    }
    if (settings) state.settings = settings;
    syncCustomModelOptions();
    syncResourceMonitor();
    loadFilters();
    $('#filter-search').value = state.filters.search;
    // In-app shell sessions are process-local, so the board rebuilds its tabs
    // and the sidebar's Sessions rows from the server on every load.
    await loadTerminalSessions();
    state.view = loadView();
    renderView();
    // Repos and sessions are both known now, so the restored tab strip can drop
    // what no longer exists and mount whatever it landed on.
    restoreActiveTab();
    handleHashDeeplink();
  } catch (e) { toast(`Failed to load state: ${e.message}`); }

  try {
    state.addons = await api('GET', '/api/addons');
  } catch { state.addons = []; }

  try {
    state.personas = await api('GET', '/api/personas');
  } catch { state.personas = []; }

  try {
    state.plugins = (await api('GET', '/api/plugins')).plugins || [];
  } catch { state.plugins = []; }
  renderPluginState();

  // Labels the Finder/IDE quick actions ("Reveal in Finder", "Open in WebStorm").
  await loadDesktop();

  try {
    const h = await api('GET', '/api/health');
    // Which CLIs exist here also decides what the terminal's new-session
    // picker can offer.
    state.health = h;
    const chip = $('#health');
    // Any one backend is enough to run a task; the header only shows the
    // status dot — CLI versions live in Settings → About instead.
    const agents = [h.claude, h.codex, h.grok].filter(Boolean);
    chip.textContent = h.ok ? '●' : '● no agent CLI found';
    chip.title = h.ok
      ? `Agent CLIs found:\n${agents.join('\n')}`
      : 'No agent CLI found — install Claude Code, OpenAI Codex and/or xAI Grok';
    chip.classList.add(h.ok ? 'ok' : 'bad');
    const about = $('#setting-about-version');
    if (about && h.version) {
      about.textContent = `Sr. Popo v${h.version} · Node ${h.node}` +
        (agents.length ? ` · ${agents.join(' · ')}` : '');
    }
  } catch { /* server down; toast already shown */ }

  connectSSE();
}

// Feature wiring, in the original source order.
initWorkspacePicker();
initSidebar();
initTabs();
initTerminal();
initDesktop();
initWorkspaceMenu();
initResources();
initMemory();
initWorkspaceHeader();
initCards();
initDnd();
initPermissions();
initContextMenu();
initFollowup();
initTaskModal();
initAttachments();
initAsk();
initGrooming();
initOrchestrate();
initLinear();
initSpecs();
initSounds();
initAutonomous();
initUsage();
initSettingsModal();
initModels();
initRemote();
initReposModal();
initFilterBar();
initPalette();
initShortcuts();
initElectron();
initDrawerClose();
initDeeplinks();


// Reflect the platform's modifier key in the top-bar shortcut hints.
$('#btn-palette').title = `Search & commands (${MOD}K)`;
$('#btn-new-task').title = `New task (${MOD}N)`;
$('#btn-settings').title = `Settings (${MOD},)`;

initTheme();
initLayout();
boot();
