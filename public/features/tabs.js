/* Sr. Popo — work-area tabs. No build step: native ES module. */
import { esc, toast } from '../core/api.js';
import { $, IS_MAC, icon, isGroomingLive, isLive, isOrchestrationLive, state } from '../core/state.js';
import { groomingsForRepo, orchestrationsForRepo, tasksForRepo } from './filters.js';
import { STATUS_LABEL, allSessions, endSession, focusSession, newSession, openNewSessionMenu, restoreSessionTab, sessionKindIcon, visibleSession } from './terminal.js';
import { currentLayout } from './theme.js';
import { enterWorkspace, exitWorkspace, githubAvatarUrl } from './workspaces.js';


// ---------- work-area tabs (sidebar layout only) ----------
// With the project rail on the left, the area to its right becomes a tabbed
// work surface: one tab per open project (the full board, header and filter bar
// included) and one per in-app shell session, next to a pinned "All projects"
// tab for the Super View. The rail is where you *find* things; a tab is where
// one of them stays open while you go look at another.
//
// Only the sidebar layout has tabs. In the classic layout this module renders
// nothing and every function below is a no-op — the board still swaps in place
// and terminals stay in the panel docked at the bottom of the window.
//
// Deliberately not a second board: a project tab shows the *same* single
// `#board` element, re-rendered for whichever project is in front. Nothing on a
// board is per-tab state (every card is redrawn from `state` on each SSE tick),
// so materializing one board per tab would cost N renders to show one.

const tabsOn = () => currentLayout() === 'sidebar';

const tabKey = (t) => (t.kind === 'super' ? 'super' : `${t.kind}:${t.id}`);
const findTab = (key) => state.tabs.find((t) => tabKey(t) === key) || null;
const activeTab = () => findTab(state.activeTab);

// The key of the tab actually in front. A session is the only kind that owns
// its own selection outright; a project tab *is* its workspace, so for anything
// else `state.view` stays the single source of truth it has always been. That
// makes the strip self-correcting: a stored tab pointing at a repo or session
// that no longer exists highlights nothing rather than showing the wrong pane.
function activeTabKey() {
  if (activeTab()?.kind === 'session') return state.activeTab;
  return state.view.mode === 'workspace' ? `repo:${state.view.repoId}` : 'super';
}

// Which of the three panes the work area should show — derived the same way,
// so the highlighted tab and the visible pane can't disagree.
function activePane() {
  if (tabsOn() && activeTab()?.kind === 'session') return 'session';
  return state.view.mode === 'super' ? 'super' : 'board';
}

// Shows exactly one pane, plus the chrome that belongs to it: the workspace
// header and filter bar act on a board, so they follow it in and out.
function setPanes(pane) {
  $('#super-view').classList.toggle('hidden', pane !== 'super');
  $('#board').classList.toggle('hidden', pane !== 'board');
  $('#workspace-header').classList.toggle('hidden', pane !== 'board');
  $('#filterbar').classList.toggle('hidden', pane !== 'board');
  // The mount only competes for the work area while it lives there; in the
  // classic layout it's inside the docked panel, which shows/hides itself.
  const mount = $('#terminal-mount');
  if (mount) mount.classList.toggle('hidden', tabsOn() && pane !== 'session');
}
const applyPanes = () => setPanes(activePane());

// Brings the terminal forward before there is a session tab to select. A pane
// has to be measured against a live box (see createPane), and the spawn that
// follows is what produces the tab — so the reveal can't wait for it.
const showTerminalPane = () => { if (tabsOn()) setPanes('session'); };

// ---- the open set ----
// Kept in localStorage next to the theme and layout: which tabs you had open is
// a device-local habit, not board state, and it must never reach db.json.
const TABS_KEY = 'srpopo.tabs';

function saveTabs() {
  try {
    // The Super View tab is implicit — it is always first and can't be closed.
    localStorage.setItem(TABS_KEY, JSON.stringify({
      tabs: state.tabs.filter((t) => t.kind !== 'super'),
      active: state.activeTab,
    }));
  } catch { /* storage unavailable — non-fatal */ }
}

// Restores the strip at boot, before the first render. Targets that no longer
// exist are dropped by pruneTabs() once repos and sessions have loaded.
function loadTabs() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(TABS_KEY)); } catch { /* ignore malformed storage */ }
  const rest = Array.isArray(saved?.tabs)
    ? saved.tabs.filter((t) => t && (t.kind === 'repo' || t.kind === 'session') && typeof t.id === 'string')
    : [];
  state.tabs = [{ kind: 'super' }, ...rest];
  state.activeTab = typeof saved?.active === 'string' ? saved.active : 'super';
}

// A tab's target is gone when its repo was removed or its shell session ended
// for good. Both are announced over SSE, so this is called from there rather
// than from a render — pruning during a render would mean mutating state while
// drawing it.
function pruneTabs() {
  if (!tabsOn()) return; // a stale strip in the classic layout must not move the board
  const alive = (t) => t.kind === 'super'
    || (t.kind === 'repo' ? state.repos.some((r) => r.id === t.id) : allSessions().some((s) => s.id === t.id));
  if (state.tabs.every(alive)) return;
  // Worked out against the strip as it still stands, so "next to it" means the
  // tab that was actually next to it — after the filter its position is gone.
  const wasActive = activeTabKey();
  const next = findTab(wasActive) && !alive(findTab(wasActive)) ? neighbourOf(wasActive, alive) : null;
  state.tabs = state.tabs.filter(alive);
  saveTabs();
  // The tab you were looking at just disappeared — land on a neighbour rather
  // than an empty work area.
  if (next) activateTab(tabKey(next));
  else renderTabStrip();
}

// Called once at boot, after repos and sessions have loaded: drops tabs whose
// target is gone, then hands the restored tab whatever it needs to actually
// show something (a session tab's pane is only mounted on demand).
function restoreActiveTab() {
  if (!tabsOn()) return;
  pruneTabs();
  if (activeTab()?.kind === 'session') { restoreSessionTab(activeTab().id); return; }
  // Reconcile the strip with the restored board view. The two localStorage keys
  // are written together, but either can be cleared on its own — and a board is
  // the thing actually on screen, so it's the one that wins.
  if (state.view.mode === 'workspace') enterWorkspace(state.view.repoId);
  else exitWorkspace();
}

// The tab to land on when `key` goes away: the nearest one to its right, else
// to its left, else the Super View — skipping any that are themselves dying
// (removing a repo can take several tabs at once).
function neighbourOf(key, alive = () => true) {
  const at = state.tabs.findIndex((t) => tabKey(t) === key);
  if (at === -1) return state.tabs[0] || { kind: 'super' };
  for (let i = at + 1; i < state.tabs.length; i++) if (alive(state.tabs[i])) return state.tabs[i];
  for (let i = at - 1; i >= 0; i--) if (alive(state.tabs[i])) return state.tabs[i];
  return { kind: 'super' };
}

// ---- opening / activating ----
// The note* trio only moves the open set; they never render, because every
// caller is on its way into renderView()/applyPanes() anyway. Calling them from
// enterWorkspace/exitWorkspace/focusSession is what keeps the strip honest no
// matter which surface — sidebar, ⌘K, a card, a hotkey — started the move.
function noteTab(tab) {
  if (!tabsOn()) return;
  if (!findTab(tabKey(tab))) state.tabs.push(tab);
  state.activeTab = tabKey(tab);
  saveTabs();
}
const noteSuperTab = () => noteTab({ kind: 'super' });
const noteRepoTab = (repoId) => noteTab({ kind: 'repo', id: repoId });
const noteSessionTab = (id) => noteTab({ kind: 'session', id });

// Brings a tab to the front through the same entry points every other surface
// uses, so a tab click and a sidebar click are indistinguishable afterwards.
function activateTab(key) {
  const tab = findTab(key);
  if (!tab) return;
  if (tab.kind === 'repo') enterWorkspace(tab.id);
  else if (tab.kind === 'session') focusSession(tab.id);
  else exitWorkspace();
}

// Closing a project tab is a view change — the board and its cards are
// untouched. Closing a session tab ends that shell, exactly like the × on the
// docked panel's tab does; the confirmation is that it vanishes from the
// sidebar's Sessions group too.
function closeTab(key) {
  const tab = findTab(key);
  if (!tab || tab.kind === 'super') return;
  if (tab.kind === 'session') { endSession(tab.id); return; }
  const next = activeTabKey() === key ? neighbourOf(key) : null;
  state.tabs = state.tabs.filter((t) => tabKey(t) !== key);
  saveTabs();
  if (next) activateTab(tabKey(next));
  else renderTabStrip();
}

// ⌘W. In the classic layout there is no strip, so the only closable thing on
// screen is the session in the docked panel — closing anything on the board
// there would be invisible.
function closeActiveTab() {
  if (tabsOn()) { closeTab(activeTabKey()); return; }
  const s = visibleSession();
  if (s) endSession(s.id);
}

// ⌘D. A board can only be open once — a project tab shows the *same* `#board`
// re-rendered (see the header), so there is no second copy to make. What can be
// duplicated is a session: another shell of the same kind on the same checkout,
// the way ⌘D splits a pane in a terminal app. From a board tab the useful "new
// one" is a plain shell on that project's checkout.
function duplicateTab() {
  const tab = tabsOn() ? activeTab() : null;
  const s = tab?.kind === 'session' ? allSessions().find((x) => x.id === tab.id) : visibleSession();
  if (s) { newSession(s.repoId, s.kind, s.cwd); return; }
  if (state.view.repoId) { newSession(state.view.repoId, 'shell'); return; }
  toast('Open a project or a session to duplicate', 'info');
}

// ⌘W / ⌘D, recognized here rather than inline in the listener so every xterm's
// custom key handler can ask the same question and let them through instead of
// typing them into a shell.
//
// Deliberately the *platform* modifier and not the usual `metaKey || ctrlKey`:
// off macOS this chord is Ctrl+W / Ctrl+D, which a shell owns (kill-word and
// EOF), so there a focused terminal keeps them and only the rest of the board
// answers.
function tabHotkey(e) {
  if (e.altKey || e.shiftKey) return null;
  if (IS_MAC ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return null;
  if (!IS_MAC && e.target instanceof Element && e.target.closest('#terminal-mount')) return null;
  const k = (e.key || '').toLowerCase();
  if (k === 'w') return 'close';
  if (k === 'd') return 'duplicate';
  return null;
}

// Ctrl+Alt+←/→. In the classic layout the same keys cycle terminal sessions
// (there is no strip to walk), which terminal.js handles.
function cycleTab(delta) {
  if (state.tabs.length < 2) return;
  const at = state.tabs.findIndex((t) => tabKey(t) === activeTabKey());
  const from = at === -1 ? 0 : at;
  activateTab(tabKey(state.tabs[(from + delta + state.tabs.length) % state.tabs.length]));
}

// ---- rendering ----
function repoTabHtml(t, key) {
  const repo = state.repos.find((r) => r.id === t.id);
  if (!repo) return '';
  const live = tasksForRepo(repo.id).filter(isLive).length
    + groomingsForRepo(repo.id).filter(isGroomingLive).length
    + orchestrationsForRepo(repo.id).filter(isOrchestrationLive).length;
  const avatarUrl = githubAvatarUrl(state.repoRemoteUrlByRepo.get(repo.id));
  return tabHtml({
    key,
    label: repo.name,
    tip: `${repo.name} — board\n${repo.path}`,
    lead: avatarUrl
      ? `<img class="tab-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">`
      : `<span class="tab-icon">${icon('folder')}</span>`,
    // A tab is how you keep an eye on a project you aren't looking at, so the
    // live count is the one thing worth carrying on it.
    trail: live ? `<span class="tab-live" title="${live} live session${live === 1 ? '' : 's'}"><span class="spinner"></span>${live}</span>` : '',
    closeLabel: `Close ${repo.name}`,
    closeTip: 'Close this tab (the board and its tasks are untouched)',
  });
}

function sessionTabHtml(t, key) {
  const s = allSessions().find((x) => x.id === t.id);
  if (!s) return '';
  const repo = state.repos.find((r) => r.id === s.repoId);
  return tabHtml({
    key,
    label: s.label,
    tip: `${s.label} — ${STATUS_LABEL[s.status]}\n${repo ? `${repo.name} · ` : ''}${s.cwd}`,
    lead: `<span class="tab-icon">${icon(sessionKindIcon(s.kind))}</span><span class="term-dot ${esc(s.status)}"></span>`,
    trail: repo ? `<span class="tab-sub">${esc(repo.name)}</span>` : '',
    closeLabel: `End ${s.label}`,
    closeTip: 'End this session',
  });
}

// One tab. `tabindex` is roving — only the selected tab is in the page's tab
// order, and ←/→ moves focus within the strip (the standard tablist pattern).
function tabHtml({ key, label, tip, lead, trail, closeLabel, closeTip, fixed }) {
  const on = key === activeTabKey();
  return `
      <div class="tab${on ? ' active' : ''}" data-tab="${esc(key)}" role="tab"
           aria-selected="${on}" tabindex="${on ? '0' : '-1'}" title="${esc(tip)}">
        ${lead || ''}
        <span class="tab-label">${esc(label)}</span>
        ${trail || ''}
        ${fixed ? '' : `<button class="tab-close" data-tab-close="${esc(key)}" tabindex="-1"
                title="${esc(closeTip)}" aria-label="${esc(closeLabel)}">${icon('x')}</button>`}
      </div>`;
}

function renderTabStrip() {
  const strip = $('#tabstrip');
  if (!strip) return;
  strip.classList.toggle('hidden', !tabsOn());
  if (!tabsOn()) return;
  // Same innerHTML choke point the board and sidebar use; keep the scroll
  // offset so a live tab's SSE tick doesn't slide the strip sideways.
  const list = $('#tabstrip-list');
  const scroll = list.scrollLeft;
  list.innerHTML = state.tabs.map((t) => {
    const key = tabKey(t);
    if (t.kind === 'repo') return repoTabHtml(t, key);
    if (t.kind === 'session') return sessionTabHtml(t, key);
    return tabHtml({
      key,
      label: 'All projects',
      tip: 'Every workspace at a glance',
      lead: `<span class="tab-icon">${icon('layout-grid')}</span>`,
      fixed: true, // home — there is always somewhere to go back to
    });
  }).join('');
  list.scrollLeft = scroll;
  list.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---- keyboard ----
// Manual activation: ←/→/Home/End move focus, Enter/Space opens. Activating on
// arrow would be fine for boards but not for sessions — focusing a session tab
// hands the keyboard to its shell, so the next arrow press would be typed into
// the terminal instead of continuing along the strip.
function onStripKeydown(e) {
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  const tabs = [...$('#tabstrip-list').querySelectorAll('[data-tab]')];
  const at = tabs.indexOf(tab);
  const move = (to) => {
    e.preventDefault();
    const next = tabs[Math.max(0, Math.min(to, tabs.length - 1))];
    if (next) { next.tabIndex = 0; next.focus(); }
  };
  if (e.key === 'ArrowLeft') move(at - 1);
  else if (e.key === 'ArrowRight') move(at + 1);
  else if (e.key === 'Home') move(0);
  else if (e.key === 'End') move(tabs.length - 1);
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateTab(tab.dataset.tab); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); closeTab(tab.dataset.tab); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {
  loadTabs();

  $('#tabstrip-list').addEventListener('click', (e) => {
    const close = e.target.closest('[data-tab-close]');
    if (close) { closeTab(close.dataset.tabClose); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) activateTab(tab.dataset.tab);
  });

  // Middle-click closes, the way it does in every tabbed thing — on auxclick so
  // the browser's own middle-click behavior never fires first.
  $('#tabstrip-list').addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const tab = e.target.closest('[data-tab]');
    if (!tab) return;
    e.preventDefault();
    closeTab(tab.dataset.tab);
  });

  $('#tabstrip-list').addEventListener('keydown', onStripKeydown);

  // ⌘W closes the tab in front, ⌘D duplicates it — the chords every tabbed app
  // uses. In Electron the native menu carries the same two items, with their
  // accelerators left unregistered so the keystroke lands here (electron/main.ts).
  document.addEventListener('keydown', (e) => {
    const action = tabHotkey(e);
    if (!action) return;
    // A blocking modal already owns the screen — closing the tab behind it would
    // leave the dialog floating over a view the user never chose.
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (action === 'close') closeActiveTab();
    else duplicateTab();
  });

  // The strip's + makes a shell, not a project: projects are opened from the
  // rail two inches to the left, which is always on screen in this layout.
  $('#tabstrip-new').addEventListener('click', (e) => {
    e.stopPropagation();
    const session = activeTab()?.kind === 'session' ? allSessions().find((s) => s.id === activeTab().id) : null;
    openNewSessionMenu(session ? session.repoId : state.view.repoId, e.currentTarget);
  });
}


export {
  activePane, activateTab, activeTabKey, applyPanes, closeActiveTab, closeTab, cycleTab,
  duplicateTab, noteRepoTab, noteSessionTab, noteSuperTab, pruneTabs, renderTabStrip,
  restoreActiveTab, showTerminalPane, tabHotkey, tabsOn,
};
