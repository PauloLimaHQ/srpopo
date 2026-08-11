/* Sr. Popo — terminal. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';


// ---- In-app terminal (embedded shell, docked at the bottom) ----
const termState = { xterm: null, fit: null, es: null, id: null, queue: '', sending: false };

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Sends typed input to the shell in order. Fast keystrokes are coalesced into
// one request and requests never overlap, so bytes can't arrive out of order.
async function flushTermInput() {
  if (termState.sending || !termState.queue || !termState.id) return;
  termState.sending = true;
  const data = termState.queue;
  termState.queue = '';
  try { await api('POST', `/api/terminal/${termState.id}/input`, { data }); } catch (_) { /* session gone */ }
  termState.sending = false;
  if (termState.queue) flushTermInput();
}

function closeTerminal() {
  if (termState.id) api('POST', `/api/terminal/${termState.id}/close`).catch(() => {});
  if (termState.es) { termState.es.close(); termState.es = null; }
  if (termState.xterm) { termState.xterm.dispose(); termState.xterm = null; }
  termState.fit = null;
  termState.id = null;
  termState.queue = '';
  if (termResizeTimer) { clearTimeout(termResizeTimer); termResizeTimer = null; }
  termLastSize = null;
  $('#terminal-panel').classList.add('hidden');
  window.removeEventListener('resize', onWindowResize);
}

// Named so `immediate` (fitTerminal's param) never receives the Event object
// addEventListener would otherwise pass as the first argument.
function onWindowResize() { fitTerminal(); }

// The backend can't ioctl a pty resize directly, so it pushes an `stty`
// through the shell's stdin (see server/terminal.ts), which the shell echoes
// back. Dragging the panel handle fires `fitTerminal` on every pointermove —
// dozens of times a second — so the resize push itself is debounced
// (immediate=true forces it through right away, used on drag end/window
// resize) and skipped entirely when the size didn't actually change.
let termResizeTimer = null;
let termLastSize = null;

function pushTerminalResize(immediate) {
  if (!termState.xterm || !termState.id) return;
  const cols = termState.xterm.cols;
  const rows = termState.xterm.rows;
  if (termLastSize && termLastSize.cols === cols && termLastSize.rows === rows) return;
  if (termResizeTimer) { clearTimeout(termResizeTimer); termResizeTimer = null; }
  const send = () => {
    termLastSize = { cols, rows };
    api('POST', `/api/terminal/${termState.id}/resize`, { cols, rows }).catch(() => {});
  };
  if (immediate) send();
  else termResizeTimer = setTimeout(send, 150);
}

function fitTerminal(immediate) {
  if (!termState.fit || !termState.id) return;
  try { termState.fit.fit(); } catch (_) { /* not mounted */ }
  pushTerminalResize(immediate);
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

// Opens an in-app shell rooted at a repo/worktree path. Omit `wtPath` for the
// repo root (the "current page" the workspace is showing).
async function openTerminalAt(repoId, wtPath) {
  if (typeof window.Terminal !== 'function') { toast('Terminal component failed to load', 'error'); return; }
  closeTerminal();
  const panel = $('#terminal-panel');
  panel.classList.remove('hidden');
  $('#terminal-cwd').textContent = wtPath || (state.repos.find((r) => r.id === repoId)?.path ?? '');

  const term = new window.Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: { background: '#0b0e14', foreground: '#d7dce5', cursor: '#d7dce5' },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('#terminal-mount'));
  fit.fit();
  termState.xterm = term;
  termState.fit = fit;

  let session;
  try {
    session = await api('POST', `/api/repos/${repoId}/terminal`, {
      path: wtPath || undefined,
      cols: term.cols,
      rows: term.rows,
    });
  } catch (e) {
    toast(e.message || 'Failed to open terminal', 'error');
    closeTerminal();
    return;
  }
  termState.id = session.id;
  termLastSize = { cols: term.cols, rows: term.rows };

  term.onData((d) => { termState.queue += d; flushTermInput(); });
  window.addEventListener('resize', onWindowResize);

  const es = new EventSource(`/api/terminal/${session.id}/stream`);
  termState.es = es;
  es.onmessage = (ev) => {
    if (ev.data === '') { term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); return; }
    term.write(b64ToBytes(ev.data));
  };
  es.addEventListener('gone', () => term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'));
  term.focus();
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

  $('#terminal-close').addEventListener('click', closeTerminal);
}


export { openTerminalAt };
