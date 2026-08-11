/* Sr. Popo — drawer-close. No build step: native ES module. */
import { $ } from '../core/state.js';
import { closeContextMenu } from './context-menu.js';
import { closeIdeMenu, ideMenuOpen, idePick } from './desktop.js';
import { closeDrawer } from './drawer.js';
import { closeNewMenu, closeWorkspaceMenu, newMenuOpen, workspaceMenuOpen } from './workspace-menu.js';
import { closeWorkspacePicker } from './workspace-picker.js';


// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // ---------- drawer close ----------
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // The IDE picker can float over the workspace modal, so it gets Escape
      // first: dismiss just the menu and hand focus back to its button.
      if (ideMenuOpen()) {
        const anchor = idePick?.anchor;
        closeIdeMenu();
        anchor?.focus();
        return;
      }
      if (workspaceMenuOpen()) { closeWorkspaceMenu(true); return; }
      if (newMenuOpen()) { closeNewMenu(); $('#btn-new-caret').focus(); return; }
      closeDrawer();
      closeContextMenu();
      closeWorkspacePicker();
      document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    }
  });
}

