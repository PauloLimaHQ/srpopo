/* Sr. Popo — workspace-menu. No build step: native ES module. */
import { $, state } from '../core/state.js';
import { anchorMenu, closeIdeMenu, ideMenuOpen, menuArrowNav } from './desktop.js';


// ---- workspace actions menu (the header's "…") ----
// Reveal / Open in IDE / Project memory / Workspace details used to be four
// bare glyphs wedged into the header. They live here instead, each with a
// written name and a line of what it does; Terminal stays out front because
// it's the one you reach for mid-flow.
function workspaceMenuOpen() { return !$('#workspace-menu').classList.contains('hidden'); }

function openWorkspaceMenu(focusFirst) {
  const menu = $('#workspace-menu');
  // The IDE picker anchors on the same button — never leave both stacked there.
  if (ideMenuOpen()) closeIdeMenu();
  // Memory is only written while the setting is on; say so here rather than
  // opening the viewer onto a document that can never fill up.
  $('#workspace-memory-hint').textContent = state.settings.memory
    ? 'Notes every agent reads for this repo'
    : 'Off — turn it on in Settings → Project memory';
  menu.classList.remove('hidden');
  anchorMenu(menu, $('#workspace-more'));
  $('#workspace-more').setAttribute('aria-expanded', 'true');
  if (focusFirst) menu.querySelector('.quick-menu-item')?.focus();
}

function closeWorkspaceMenu(refocus) {
  if (!workspaceMenuOpen()) return;
  $('#workspace-menu').classList.add('hidden');
  $('#workspace-more').setAttribute('aria-expanded', 'false');
  if (refocus) $('#workspace-more').focus();
}

// ---- "New" menu (the New Task split button's caret) ----
// The other ways to start work (Ask / Brief / Orchestrate / Linear / Specs)
// live here instead of as separate top-bar buttons; each keeps its own click
// handler below, this just anchors/shows the menu and closes it on a pick.
function newMenuOpen() { return !$('#new-menu').classList.contains('hidden'); }
function openNewMenu() {
  const menu = $('#new-menu');
  const anchor = $('#btn-new-caret');
  menu.classList.remove('hidden');
  anchorMenu(menu, anchor);
  anchor.setAttribute('aria-expanded', 'true');
}
function closeNewMenu() {
  $('#new-menu').classList.add('hidden');
  $('#btn-new-caret').setAttribute('aria-expanded', 'false');
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#workspace-more').addEventListener('click', (e) => {
    e.stopPropagation();
    workspaceMenuOpen() ? closeWorkspaceMenu() : openWorkspaceMenu();
  });
  $('#workspace-more').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || workspaceMenuOpen()) return;
    e.preventDefault();
    openWorkspaceMenu(true);
  });
  $('#workspace-menu').addEventListener('keydown', (e) => menuArrowNav($('#workspace-menu'), e));
  document.addEventListener('click', (e) => {
    if (!workspaceMenuOpen()) return;
    if (e.target.closest('#workspace-menu') || $('#workspace-more').contains(e.target)) return;
    closeWorkspaceMenu();
  });
  $('#btn-new-caret').addEventListener('click', (e) => {
    e.stopPropagation();
    newMenuOpen() ? closeNewMenu() : openNewMenu();
  });
  $('#new-menu').addEventListener('click', (e) => {
    if (e.target.closest('.quick-menu-item')) closeNewMenu();
  });
  document.addEventListener('click', (e) => {
    if (!newMenuOpen()) return;
    if (e.target.closest('#new-menu') || e.target === $('#btn-new-caret') || $('#btn-new-caret').contains(e.target)) return;
    closeNewMenu();
  });
}


export { closeNewMenu, closeWorkspaceMenu, newMenuOpen, workspaceMenuOpen };
