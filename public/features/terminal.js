/* Sr. Popo — terminal. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { activePane, activateTab, activeTabKey, applyPanes, cycleTab, noteSessionTab, pruneTabs, renderTabStrip, showTerminalPane, tabHotkey, tabsOn } from './tabs.js';


// ---- In-app terminal sessions (one tab each) ----
// A session is a real shell on a checkout, optionally booted straight into an
// agent CLI. Unlike a task it isn't a card and has no lifecycle on the board —
// it's a place you jump into and drive by hand. The server owns the list (they
// are process-local, never persisted); this module owns one xterm per session
// and where they're shown.
//
// A session has two possible homes, one per layout (see features/tabs.js):
// docked at the bottom of the window with its own tab bar in the classic
// layout, or a full-height tab in the work area under the sidebar layout. The
// difference is only where `#terminal-mount` is parented — every pane, its
// scrollback and its stream survive a switch between them.
//
// Reachable from: the workspace header's Terminal button, the project
// sidebar's Sessions group, either tab strip, ⌘K, and the hotkeys below.

// Server-side status → the bullet every surface shows. Green: alive and
// printing. Amber: alive but quiet for a while — sitting at a prompt, probably
// waiting for you. Red: the process is gone (scrollback still readable).
const STATUS_LABEL = { active: 'Active', idle: 'Idle — waiting for input', exited: 'Closed' };

// The agent CLIs a session can boot into, next to a plain shell. `health` is
// the /api/health field that says the binary exists on this machine.
const SESSION_KINDS = [
  { kind: 'shell', label: 'Shell', hint: 'A plain login shell on this checkout', icon: 'terminal' },
  { kind: 'claude', label: 'Claude Code', hint: 'Interactive claude session', icon: 'sparkles', health: 'claude' },
  { kind: 'codex', label: 'OpenAI Codex', hint: 'Interactive codex session', icon: 'bot', health: 'codex' },
  { kind: 'grok', label: 'xAI Grok', hint: 'Interactive grok session', icon: 'zap', health: 'grok' },
];

// id -> session summary from the server ({ id, repoId, cwd, kind, label, status, createdAt }).
const sessions = new Map();
// id -> { el, xterm, fit, queue, sending, lastSize } for sessions with a
// mounted pane. Panes are created on first visit and kept, so switching tabs
// preserves scrollback.
const panes = new Map();
// One EventSource carries the output of every mounted pane — a browser allows
// only ~6 connections per host, so a stream per tab would starve the board's
// own feed and the keystroke POSTs.
let stream = null;
let activeId = null;
// The repo a new session from the panel's + belongs to, while its menu is open.
let newMenuFor = null;

const panelOpen = () => !$('#terminal-panel').classList.contains('hidden');
// The glyph for a session, shared with the work-area tab strip so a claude
// session looks the same wherever it's listed. A session started from a package
// script gets the Run button's play glyph rather than a bare terminal, so the
// tab it opens is recognizable as the thing you just started.
const sessionKindIcon = (kind) => SESSION_KINDS.find((k) => k.kind === kind)?.icon || 'terminal';
const sessionIcon = (s) => (s.command ? 'play' : sessionKindIcon(s.kind));
const repoName = (repoId) => state.repos.find((r) => r.id === repoId)?.name || '';
const repoPath = (repoId) => state.repos.find((r) => r.id === repoId)?.path || '';
// The bar has room for the tail of a path, and the tail is the part that says
// which checkout you're in. The full path stays in the tab's tooltip.
const shortPath = (p) => p.split('/').filter(Boolean).slice(-2).join('/');

// Board order for tabs and sidebar rows: oldest first, so a session never
// jumps position when another one changes status.
function allSessions() {
  return [...sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
function sessionsForRepo(repoId) {
  return allSessions().filter((s) => s.repoId === repoId);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Sends typed input to a shell in order. Fast keystrokes are coalesced into one
// request and requests never overlap, so bytes can't arrive out of order.
async function flushInput(pane) {
  if (pane.sending || !pane.queue) return;
  pane.sending = true;
  const data = pane.queue;
  pane.queue = '';
  try { await api('POST', `/api/terminal/${pane.id}/input`, { data }); } catch (_) { /* session gone */ }
  pane.sending = false;
  if (pane.queue) flushInput(pane);
}

// ---- the docked panel's own tab bar (classic layout) ----
// In the tabbed layout the panel never opens, so this is a no-op there and the
// work-area strip is the only place sessions are listed.
function panelTabHtml(s) {
  const where = `${repoName(s.repoId)} · ${s.cwd}`;
  return `
      <div class="terminal-tab${s.id === activeId ? ' active' : ''}" data-tab="${esc(s.id)}"
           role="tab" tabindex="0" aria-selected="${s.id === activeId}"
           title="${esc(`${s.label} — ${STATUS_LABEL[s.status]}\n${where}`)}">
        <span class="term-dot ${esc(s.status)}"></span>
        <span class="terminal-tab-label">${esc(s.label)}</span>
        <span class="terminal-tab-repo">${esc(repoName(s.repoId))}</span>
        <span class="terminal-tab-close" data-tab-close="${esc(s.id)}" role="button" tabindex="-1"
              title="End this session" aria-label="End ${esc(s.label)}">${icon('x')}</span>
      </div>`;
}

function renderPanelTabs() {
  if (!panelOpen()) return;
  const list = allSessions();
  $('#terminal-tabs').innerHTML = list.map(panelTabHtml).join('');
  const active = activeId ? sessions.get(activeId) : null;
  $('#terminal-cwd').textContent = active ? shortPath(active.cwd) : '';
  $('#terminal-cwd').title = active ? active.cwd : '';
  $('#terminal-tabs').querySelector('.terminal-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// A session is listed in two strips depending on the layout, and its status
// bullet has to be current in whichever one is on screen. One call for both.
function renderSessionTabs() {
  renderPanelTabs();
  renderTabStrip();
}

// ---- panes (one xterm per session) ----
// Mounted and fitted before it belongs to a session, so a brand-new shell can
// be spawned at the size it will actually be displayed at — xterm measures the
// character cell when it opens, and a `display:none` mount makes it fall back
// to 80x24. The other panes are hidden right away: during the spawn round-trip
// the empty new one is what you want to be looking at anyway.
function createPane() {
  if (typeof window.Terminal !== 'function') { toast('Terminal component failed to load', 'error'); return null; }
  for (const p of panes.values()) p.el.classList.add('hidden');

  const el = document.createElement('div');
  el.className = 'terminal-pane';
  $('#terminal-mount').appendChild(el);

  const term = new window.Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0e14', foreground: '#d7dce5', cursor: '#d7dce5' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  // Let the panel's own hotkeys — and the tab strip's ⌘W/⌘D — through instead of
  // sending them to the shell.
  term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && (hotkey(e) || tabHotkey(e))));

  const pane = { id: null, el, xterm: term, fit, queue: '', sending: false, lastSize: null };
  try { fit.fit(); } catch (_) { /* not mounted */ }
  return pane;
}

// Binds a mounted pane to the session it now shows, putting it on the shared
// output stream.
function attachPane(id, pane) {
  pane.id = id;
  pane.el.dataset.pane = id;
  panes.set(id, pane);
  pane.xterm.onData((d) => { pane.queue += d; flushInput(pane); });
  syncStream();
  return pane;
}

// The pane for an existing session, mounting one on first visit.
function ensurePane(id) {
  const existing = panes.get(id);
  if (existing) return existing;
  const pane = createPane();
  return pane ? attachPane(id, pane) : null;
}

function disposePane(id) {
  const pane = panes.get(id);
  if (!pane) return;
  pane.xterm.dispose();
  pane.el.remove();
  panes.delete(id);
  syncStream();
}

// Reopens the shared output stream for exactly the mounted panes. Every
// (re)connection replays each session's buffered screen, so the panes are
// cleared first and repainted from that — which also keeps a dropped-and-
// reconnected stream from painting the scrollback twice.
function syncStream() {
  if (stream) { stream.close(); stream = null; }
  if (!panes.size) return;
  const es = new EventSource(`/api/terminal/stream?ids=${[...panes.keys()].join(',')}`);
  stream = es;
  es.onopen = () => { for (const p of panes.values()) p.xterm.reset(); };
  es.onmessage = (ev) => {
    const { id, b64, gone } = JSON.parse(ev.data);
    const term = panes.get(id)?.xterm;
    if (!term) return;
    if (gone) term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n');
    else if (b64 === '') term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
    else term.write(b64ToBytes(b64));
  };
}

// ---- resize ----
// The backend can't ioctl a pty resize directly, so it pushes an `stty` through
// the shell's stdin (see server/terminal.ts), which the shell echoes back.
// Dragging the panel handle fires `fitTerminal` on every pointermove — dozens
// of times a second — so the resize push itself is debounced (immediate=true
// forces it through right away, used on drag end/window resize) and skipped
// entirely when the size didn't actually change.
let termResizeTimer = null;

function pushResize(pane, immediate) {
  const cols = pane.xterm.cols;
  const rows = pane.xterm.rows;
  if (pane.lastSize && pane.lastSize.cols === cols && pane.lastSize.rows === rows) return;
  if (termResizeTimer) { clearTimeout(termResizeTimer); termResizeTimer = null; }
  const send = () => {
    pane.lastSize = { cols, rows };
    api('POST', `/api/terminal/${pane.id}/resize`, { cols, rows }).catch(() => {});
  };
  if (immediate) send();
  else termResizeTimer = setTimeout(send, 150);
}

// Only the visible pane can be measured; the others refit when they're shown.
function fitTerminal(immediate) {
  const pane = activeId ? panes.get(activeId) : null;
  if (!pane) return;
  try { pane.fit.fit(); } catch (_) { /* not mounted */ }
  pushResize(pane, immediate);
}

// Named so `immediate` (fitTerminal's param) never receives the Event object
// addEventListener would otherwise pass as the first argument.
function onWindowResize() { fitTerminal(); }

// ---- where the terminal lives ----
// The mount moves between the docked panel and the work area, rather than each
// pane moving between two mounts: the xterms then never change parent, so a
// layout switch costs a refit and nothing else. Called by applyLayout().
function syncTerminalHost() {
  const mount = $('#terminal-mount');
  if (!mount) return;
  const host = tabsOn() ? $('#workarea') : $('#terminal-panel');
  if (mount.parentElement !== host) host.appendChild(mount);
  mount.classList.toggle('terminal-mount-tabbed', tabsOn());
  // The docked panel has nothing left to show once the mount has left it.
  if (tabsOn()) hidePanel();
  else mount.classList.remove('hidden');
  fitTerminal(true);
}

// ---- panel ----
// Makes the terminal visible so a pane can be measured. In the tabbed layout
// there's no panel to open — the work area switches to the terminal instead,
// and it has to happen *before* the session exists, because createPane() fits
// against a live box (a display:none mount silently gives 80x24).
function showPanel() {
  if (tabsOn()) { showTerminalPane(); return; }
  if (panelOpen()) return;
  $('#terminal-panel').classList.remove('hidden');
  window.addEventListener('resize', onWindowResize);
}

// Puts the terminal away. Sessions keep running — this is a view, not a
// lifecycle. In the tabbed layout there's nothing to hide: a session is a tab
// like any other, and you leave it by going to a different tab.
function hidePanel() {
  if (!panelOpen()) return;
  $('#terminal-panel').classList.add('hidden');
  window.removeEventListener('resize', onWindowResize);
  closeNewSessionMenu();
}

// Ctrl+`. Classic: show/hide the docked panel. Tabbed: jump to the terminal and
// back — a second press returns to the board you came from, so the keystroke
// stays a toggle instead of stranding you on a shell.
let tabBeforeTerminal = null;
function toggleTerminalPanel() {
  if (tabsOn()) {
    if (activePane() === 'session') {
      activateTab(tabBeforeTerminal || 'super');
      return;
    }
    tabBeforeTerminal = activeTabKey();
    if (!sessions.size) { newSession(state.view.repoId, 'shell'); return; }
    focusSession(activeId && sessions.has(activeId) ? activeId : allSessions()[0].id);
    return;
  }
  if (panelOpen()) { hidePanel(); return; }
  if (!sessions.size) { newSession(state.view.repoId, 'shell'); return; }
  showPanel();
  focusSession(activeId && sessions.has(activeId) ? activeId : allSessions()[0].id);
}

// Brings a session's pane to the front — the single entry point every surface
// (tab strip, sidebar row, ⌘K, workspace header, hotkey) goes through, so the
// strip, the panes and the work area can't disagree about what's in front.
function focusSession(id) {
  if (!sessions.has(id)) return;
  noteSessionTab(id);
  showPanel();
  const pane = ensurePane(id);
  if (!pane) return;
  activeId = id;
  for (const [pid, p] of panes) p.el.classList.toggle('hidden', pid !== id);
  renderSessionTabs();
  fitTerminal(true);
  pane.xterm.focus();
}

// The session the user is actually looking at: the work-area tab in front, or
// the docked panel's selected tab while the panel is up. Lets tab-level hotkeys
// (⌘W, ⌘D) act on it without reaching into this module's state.
function visibleSession() {
  if (tabsOn() && activePane() !== 'session') return null;
  if (!tabsOn() && !panelOpen()) return null;
  return (activeId && sessions.get(activeId)) || null;
}

function cycleSession(delta) {
  const list = allSessions();
  if (list.length < 2) return;
  const at = list.findIndex((s) => s.id === activeId);
  focusSession(list[(at + delta + list.length) % list.length].id);
}

// Ends a session for good and moves somewhere sensible: in the tabbed layout
// that's whatever tab sat next to it — often a board rather than another shell
// — which pruneTabs() works out; in the classic one it's the next session, or
// the panel closing because there is nothing left in it.
async function endSession(id) {
  const list = allSessions();
  const at = list.findIndex((s) => s.id === id);
  const next = list[at + 1] || list[at - 1] || null;
  const wasActive = activeId === id;
  sessions.delete(id);
  disposePane(id);
  if (wasActive) activeId = null;
  if (tabsOn()) {
    pruneTabs();
  } else if (wasActive) {
    if (next) focusSession(next.id);
    else hidePanel();
  }
  renderSessionTabs();
  try { await api('DELETE', `/api/terminal/${id}`); } catch (_) { /* already gone */ }
}

// ---- creating sessions ----
// Every route to a new session goes through here: `ask(dims)` is the POST that
// actually requests one (a plain/agent shell below, a package script run in
// features/scripts.js), and this owns the pane around it — mounting it, sizing
// it, and putting the previous view back if the server says no.
async function openSession(repoId, ask) {
  if (!repoId) { toast('Open a workspace first', 'error'); return null; }
  showPanel();
  // Mount the pane first and spawn the shell at that size. An agent CLI reads
  // the width once at startup and we can't ioctl a resize afterwards, so a
  // claude session started at the default 80 columns would stay boxed into 80
  // for its whole life. Seeding `lastSize` also skips the follow-up `stty`,
  // which the shell would otherwise echo across the top of a fresh terminal.
  const pane = createPane();
  const dims = pane ? { cols: pane.xterm.cols, rows: pane.xterm.rows } : null;
  try {
    const s = await ask(dims);
    sessions.set(s.id, s);
    if (pane) {
      pane.lastSize = dims;
      attachPane(s.id, pane);
    }
    focusSession(s.id);
    return s;
  } catch (e) {
    toast(e.message || 'Failed to open terminal', 'error');
    if (pane) { pane.xterm.dispose(); pane.el.remove(); }
    // The terminal was already brought to the front to measure that pane — put
    // the previous view back rather than leaving an empty black rectangle.
    if (activeId) focusSession(activeId);
    else if (tabsOn()) applyPanes();
    else hidePanel();
    return null;
  }
}

// A plain shell, or one booted straight into an agent CLI, on a checkout.
function newSession(repoId, kind, wtPath) {
  return openSession(repoId, (dims) => api('POST', `/api/repos/${repoId}/terminal`, {
    path: wtPath || undefined,
    kind,
    cols: dims ? dims.cols : undefined,
    rows: dims ? dims.rows : undefined,
  }));
}

// The workspace header's Terminal button and the worktree rows: one shell per
// checkout is what people expect there, so jump to the live one if it exists
// rather than piling up tabs on the same directory.
function openTerminalAt(repoId, wtPath) {
  const cwd = wtPath || repoPath(repoId);
  const open = allSessions().find((s) => s.repoId === repoId && s.kind === 'shell'
    && s.cwd === cwd && s.status !== 'exited');
  if (open) { focusSession(open.id); return; }
  newSession(repoId, 'shell', wtPath);
}

// ---- new-session menu (anchored on a + button or a sidebar row) ----
function newSessionMenuOpen() { return !$('#terminal-menu').classList.contains('hidden'); }

// Whichever + is on screen in this layout — the work-area strip's, or the
// docked panel's. Where a keyboard-opened menu points, and where Escape
// returns focus to.
const newSessionAnchor = () => (tabsOn() ? $('#tabstrip-new') : $('#terminal-new'));

function closeNewSessionMenu() {
  if (!newSessionMenuOpen()) return;
  $('#terminal-menu').classList.add('hidden');
  for (const el of [$('#terminal-new'), $('#tabstrip-new')]) el?.setAttribute('aria-expanded', 'false');
  newMenuFor = null;
}

// A kind is offered when its CLI was found by /api/health — a menu entry that
// can only ever print "command not found" isn't a choice.
function availableKinds() {
  return SESSION_KINDS.filter((k) => !k.health || (state.health && state.health[k.health]));
}

function openNewSessionMenu(repoId, anchor) {
  const menu = $('#terminal-menu');
  const name = repoName(repoId);
  menu.innerHTML = availableKinds().map((k) => `
      <button class="quick-menu-item" data-kind="${esc(k.kind)}" role="menuitem">
        ${icon(k.icon)}
        <span class="quick-menu-item-body">
          <span class="quick-menu-item-label">${esc(k.label)}</span>
          <span class="quick-menu-item-hint">${esc(name ? `${k.hint} — ${name}` : k.hint)}</span>
        </span>
      </button>`).join('');
  newMenuFor = repoId;
  menu.classList.remove('hidden');
  // Same anchoring the workspace "…" and IDE pickers use, but the docked panel
  // sits at the bottom of the window — drop the menu above the button when it
  // would otherwise run off-screen.
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const below = rect.bottom + 6;
  menu.style.top = `${Math.round(below + height > window.innerHeight - 8 ? rect.top - height - 6 : below)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)))}px`;
  if (anchor.hasAttribute('aria-haspopup')) anchor.setAttribute('aria-expanded', 'true');
  menu.querySelector('.quick-menu-item')?.focus();
}

// ---- hotkeys ----
// Recognized in one place so the document listener and every xterm's custom
// key handler agree on what the panel owns. Returns the action, or null.
function hotkey(e) {
  const backquote = e.code === 'Backquote' || e.key === '`' || e.key === '~';
  if (e.ctrlKey && !e.metaKey && !e.altKey && backquote) return e.shiftKey ? 'new' : 'toggle';
  if (e.ctrlKey && e.altKey && !e.metaKey && e.key === 'ArrowLeft') return 'prev';
  if (e.ctrlKey && e.altKey && !e.metaKey && e.key === 'ArrowRight') return 'next';
  return null;
}

// ---- terminal panel resize (drag handle, height persisted across sessions) ----
const TERM_HEIGHT_KEY = 'srpopo.terminalHeight';
const TERM_MIN_HEIGHT = 240;

function applyTerminalHeight(px) {
  const max = Math.round(window.innerHeight * 0.9);
  const h = Math.max(TERM_MIN_HEIGHT, Math.min(px, max));
  $('#terminal-panel').style.height = `${h}px`;
  return h;
}

// ---- live sync ----
// The full list, fetched at boot and whenever the SSE stream (re)connects —
// sessions are process-local, so a server restart empties them and a board
// reload has to rebuild the tabs from scratch.
async function loadTerminalSessions() {
  let list;
  try { ({ sessions: list } = await api('GET', '/api/terminal/sessions')); } catch { return; }
  sessions.clear();
  for (const s of list) sessions.set(s.id, s);
  for (const id of [...panes.keys()]) if (!sessions.has(id)) disposePane(id);
  if (activeId && !sessions.has(activeId)) activeId = null;
  if (tabsOn()) pruneTabs();
  else if (!sessions.size) hidePanel();
  else if (panelOpen() && !activeId) focusSession(allSessions()[0].id);
  renderSessionTabs();
}

// Mounts the pane for a session tab restored from localStorage. Panes are
// created on demand, so a reload that lands on a session tab would otherwise
// show an empty work area until you clicked something.
function restoreSessionTab(id) {
  if (tabsOn() && sessions.has(id)) focusSession(id);
}

// A `terminal` / `terminal-removed` bus event: a session was created, changed
// status, or went away — including from another board window.
function applyTerminalEvent(msg) {
  if (msg.type === 'terminal-removed') {
    const wasActive = activeId === msg.id;
    sessions.delete(msg.id);
    disposePane(msg.id);
    if (wasActive) activeId = null;
    if (tabsOn()) {
      pruneTabs();
    } else if (wasActive) {
      const next = allSessions()[0];
      if (next) focusSession(next.id);
      else hidePanel();
    }
  } else {
    sessions.set(msg.session.id, msg.session);
  }
  renderSessionTabs();
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  (function initTerminalResize() {
    const handle = $('#terminal-resize-handle');
    if (!handle) return;
    const saved = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    if (saved) applyTerminalHeight(saved);

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    function onMove(e) {
      if (!dragging) return;
      const dy = startY - e.clientY;
      const h = applyTerminalHeight(startHeight + dy);
      fitTerminal();
      localStorage.setItem(TERM_HEIGHT_KEY, String(h));
    }
    function onUp() {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      fitTerminal(true);
    }
    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = $('#terminal-panel').getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.cursor = 'ns-resize';
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
  })();

  $('#terminal-close').addEventListener('click', hidePanel);

  $('#terminal-tabs').addEventListener('click', (e) => {
    const close = e.target.closest('[data-tab-close]');
    if (close) { endSession(close.dataset.tabClose); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) focusSession(tab.dataset.tab);
  });
  $('#terminal-tabs').addEventListener('keydown', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (!tab || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    focusSession(tab.dataset.tab);
  });

  $('#terminal-new').addEventListener('click', (e) => {
    e.stopPropagation();
    if (newSessionMenuOpen()) { closeNewSessionMenu(); return; }
    const active = activeId ? sessions.get(activeId) : null;
    openNewSessionMenu(active ? active.repoId : state.view.repoId, e.currentTarget);
  });
  $('#terminal-menu').addEventListener('click', (e) => {
    const kind = e.target.closest('[data-kind]')?.dataset.kind;
    if (!kind) return;
    const repoId = newMenuFor;
    closeNewSessionMenu();
    newSession(repoId, kind);
  });
  document.addEventListener('click', (e) => {
    if (!newSessionMenuOpen()) return;
    // The sidebar's per-project + re-anchors the same menu; its own handler
    // reopens it, so this click isn't "outside".
    if (e.target.closest('#terminal-menu') || e.target.closest('#terminal-new')
      || e.target.closest('#tabstrip-new') || e.target.closest('[data-new-session]')) return;
    closeNewSessionMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (newSessionMenuOpen() && e.key === 'Escape') { closeNewSessionMenu(); newSessionAnchor().focus(); return; }
    const action = hotkey(e);
    if (!action) return;
    // A blocking modal already owns the screen — don't yank focus out of it.
    if (document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault();
    if (action === 'toggle') { toggleTerminalPanel(); return; }
    if (action === 'new') {
      // The + the menu anchors on lives in the panel, so in the classic layout
      // the panel has to be up before the menu can be positioned against it.
      // In the tabbed layout the strip's + is always on screen.
      if (!tabsOn()) { showPanel(); renderPanelTabs(); }
      openNewSessionMenu(state.view.repoId || sessions.get(activeId)?.repoId, newSessionAnchor());
      return;
    }
    // Ctrl+Alt+←/→ walks whatever strip is on screen: every open tab in the
    // tabbed layout, the sessions in the docked panel otherwise.
    if (tabsOn()) cycleTab(action === 'next' ? 1 : -1);
    else cycleSession(action === 'next' ? 1 : -1);
  });
}


export {
  STATUS_LABEL, allSessions, applyTerminalEvent, availableKinds, endSession, focusSession,
  loadTerminalSessions, newSession, openNewSessionMenu, openSession, openTerminalAt, restoreSessionTab,
  sessionIcon, sessionKindIcon, sessionsForRepo, syncTerminalHost, toggleTerminalPanel, visibleSession,
};
