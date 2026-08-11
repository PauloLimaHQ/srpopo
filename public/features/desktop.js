/* Sr. Popo — desktop. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderEditorSetting, saveSettings } from './settings-modal.js';


// ---- desktop quick actions (reveal in the file manager, open in an IDE) ----
// The way back out of the board into the developer's own tools. Both act on a
// checkout — the repo root, or a live worktree row in the workspace details
// modal — and are handled server-side (see server/desktop.ts), so they behave
// the same in the desktop app and in a browser tab.

const editors = () => state.desktop.editors || [];
const editorById = (id) => editors().find((e) => e.id === id) || null;
const defaultEditor = () => editorById(state.settings.defaultEditor || '');

// Pulled once at boot, and again after a rescan. Detection can't fail in a way
// worth surfacing — an empty catalog just means "no IDE found", which the
// picker says in words.
async function loadDesktop(refresh) {
  try {
    state.desktop = await api('GET', `/api/desktop${refresh ? '?refresh=1' : ''}`);
  } catch { /* keep the previous (or default) catalog */ }
  syncDesktopLabels();
  renderEditorSetting();
}

// Keep every affordance naming the file manager or the chosen IDE honest —
// "Reveal in Finder" on a Mac, "Open in WebStorm" once WebStorm is the default.
function syncDesktopLabels() {
  const fm = state.desktop.fileManager || 'file manager';
  const ide = defaultEditor();
  const revealLabel = `Reveal in ${fm}`;
  const ideLabel = ide ? `Open in ${ide.label}` : 'Open in IDE';
  // Written labels wherever there's room for words…
  for (const [id, text] of [
    ['#workspace-reveal-label', revealLabel],
    ['#workspace-ide-label', ideLabel],
    ['#workspace-open-folder-label', revealLabel],
    ['#workspace-open-ide-label', ideLabel],
  ]) {
    const el = $(id);
    if (el) el.textContent = text;
  }
  // …and a tooltip on the workspace modal's buttons, which say what they act on.
  for (const [id, title] of [
    ['#workspace-open-folder', `Reveal the repository in ${fm}`],
    ['#workspace-open-ide', ide ? `Open the repository in ${ide.label}` : 'Open in IDE — pick an editor'],
  ]) {
    const el = $(id);
    if (el) el.title = title;
  }
}

async function revealPath(repoId, wtPath) {
  try {
    await api('POST', `/api/repos/${repoId}/reveal`, { path: wtPath || undefined });
  } catch (e) {
    toast(e.message || 'Failed to open the folder');
  }
}

// Opens a checkout in the default IDE. With no default configured yet the
// picker opens under `anchor` instead, and the pick becomes the default — so
// the button works on first click without a detour through Settings.
async function openInIde(repoId, wtPath, anchor, editorId) {
  const chosen = editorId || state.settings.defaultEditor || '';
  if (!chosen) { openIdeMenu(anchor, repoId, wtPath); return; }
  try {
    await api('POST', `/api/repos/${repoId}/editor`, { path: wtPath || undefined, editor: chosen });
  } catch (e) {
    if (e.status === 409) { openIdeMenu(anchor, repoId, wtPath); return; }
    toast(e.message || 'Failed to open the IDE');
  }
}

// ---- anchored menus (shared plumbing) ----
// Every `.quick-menu` is fixed-position so it can float over a modal; place it
// under its button and clamp it into the viewport.
function anchorMenu(menu, anchor) {
  const rect = anchor ? anchor.getBoundingClientRect() : { bottom: 64, right: window.innerWidth - 16 };
  const width = menu.offsetWidth;
  menu.style.top = `${Math.round(rect.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)))}px`;
}

// Arrow-key roving focus inside a menu, matching the workspace switcher's popover.
function menuArrowNav(menu, e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...menu.querySelectorAll('.quick-menu-item:not(.hidden)')];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement);
  const down = e.key === 'ArrowDown';
  // With focus still on the menu itself, Down starts at the top and Up at the bottom.
  const next = at === -1 ? (down ? 0 : items.length - 1) : at + (down ? 1 : -1);
  items[(next + items.length) % items.length].focus();
}

// ---- IDE picker (anchored menu) ----
let idePick = null; // { repoId, wtPath, anchor } while the menu is open
// The picker is opened from inside someone else's click handler — a workspace
// menu item, a palette row, a worktree button — and that same click then
// bubbles to the document, where it would read as "clicked outside" and shut
// the picker in the same tick. Arm the outside-click check a turn later.
let ideOutsideArmed = false;

function ideMenuOpen() {
  return !$('#ide-menu').classList.contains('hidden');
}

function ideMenuHtml() {
  const ready = editors().filter((e) => e.available);
  const missing = editors().filter((e) => !e.available);
  if (!ready.length) {
    return `<div class="quick-menu-empty">
        <p>No supported IDE found on this machine.</p>
        <p class="field-hint">Sr. Popo looks for VS Code's <code>code</code> command and the JetBrains
          launchers (<code>idea</code>, <code>webstorm</code>, …). Install one, then rescan from Settings.</p>
      </div>`;
  }
  const rows = ready.map((e) => `
      <button class="quick-menu-item" role="menuitem" data-editor="${esc(e.id)}">
        ${icon('code')}<span class="quick-menu-label">${esc(e.label)}</span>
      </button>`).join('');
  const unavailable = missing.length
    ? `<div class="quick-menu-note">Not found here: ${missing.map((e) => esc(e.label)).join(', ')}</div>`
    : '';
  return `<div class="quick-menu-title">Open in…</div>${rows}${unavailable}
      <div class="quick-menu-note">Your pick becomes the default — change it in Settings → General.</div>`;
}

function openIdeMenu(anchor, repoId, wtPath) {
  const menu = $('#ide-menu');
  idePick = { repoId, wtPath, anchor: anchor || null };
  menu.innerHTML = ideMenuHtml();
  menu.classList.remove('hidden');
  anchorMenu(menu, anchor);
  anchor?.setAttribute('aria-expanded', 'true');
  menu.querySelector('.quick-menu-item')?.focus();
  ideOutsideArmed = false;
  setTimeout(() => { ideOutsideArmed = true; }, 0);
}

function closeIdeMenu() {
  ideOutsideArmed = false;
  $('#ide-menu').classList.add('hidden');
  idePick?.anchor?.setAttribute('aria-expanded', 'false');
  idePick = null;
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#ide-menu').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-editor]')?.dataset.editor;
    if (!id || !idePick) return;
    const { repoId, wtPath } = idePick;
    closeIdeMenu();
    await saveSettings({ defaultEditor: id });
    syncDesktopLabels();
    renderEditorSetting();
    openInIde(repoId, wtPath, null, id);
  });
  $('#ide-menu').addEventListener('keydown', (e) => menuArrowNav($('#ide-menu'), e));
  document.addEventListener('click', (e) => {
    if (!ideMenuOpen() || !ideOutsideArmed) return;
    if (e.target.closest('#ide-menu') || e.target === idePick?.anchor || idePick?.anchor?.contains(e.target)) return;
    closeIdeMenu();
  });
}


export { anchorMenu, closeIdeMenu, defaultEditor, editorById, editors, ideMenuOpen, idePick, loadDesktop, menuArrowNav, openInIde, revealPath, syncDesktopLabels };
