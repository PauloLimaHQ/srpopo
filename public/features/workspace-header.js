/* Sr. Popo — workspace-header. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { autonomousForWorkspace, openAutonomousModal, startAutonomous, stopAutonomous } from './autonomous.js';
import { closeIdeMenu, ideMenuOpen, openInIde, revealPath } from './desktop.js';
import { openDrawer } from './drawer.js';
import { openRepoSettingsModal } from './repo-settings.js';
import { openTerminalAt } from './terminal.js';
import { closeWorkspaceMenu } from './workspace-menu.js';
import { exitWorkspace, openWorkspacePopover, refreshRepoWorktreesCard } from './workspaces.js';


// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#workspace-back').addEventListener('click', exitWorkspace);
  $('#workspace-terminal').addEventListener('click', () => {
    const repoId = state.view.repoId;
    if (repoId) openTerminalAt(repoId);
  });
  $('#workspace-reveal').addEventListener('click', () => {
    closeWorkspaceMenu();
    const repoId = state.view.repoId;
    if (repoId) revealPath(repoId);
  });
  $('#workspace-ide').addEventListener('click', () => {
    closeWorkspaceMenu();
    const repoId = state.view.repoId;
    // The item itself is going away with the menu, so the editor picker (shown
    // when no default is set yet) anchors on the "…" button that opened it.
    if (repoId) openInIde(repoId, null, $('#workspace-more'));
  });
  $('#workspace-info').addEventListener('click', () => {
    closeWorkspaceMenu();
    openWorkspacePopover();
  });
  $('#workspace-settings').addEventListener('click', () => {
    closeWorkspaceMenu();
    const repoId = state.view.repoId;
    if (repoId) openRepoSettingsModal(repoId);
  });
  // Autonomous Mode: the header button starts a session (opens the budget modal)
  // or stops the one running for this workspace.
  $('#btn-autonomous').addEventListener('click', () => (autonomousForWorkspace() ? stopAutonomous() : openAutonomousModal()));
  $('#autonomous-cancel').addEventListener('click', () => $('#modal-autonomous').classList.add('hidden'));
  $('#autonomous-start').addEventListener('click', startAutonomous);
  $('#workspace-modal-close').addEventListener('click', () => $('#modal-workspace').classList.add('hidden'));
  $('#workspace-open-terminal').addEventListener('click', () => {
    const repoId = state.view.repoId;
    if (repoId) openTerminalAt(repoId);
  });
  $('#workspace-open-folder').addEventListener('click', () => {
    const repoId = state.view.repoId;
    if (repoId) revealPath(repoId);
  });
  $('#workspace-open-ide').addEventListener('click', (e) => {
    if (ideMenuOpen()) { closeIdeMenu(); return; }
    const repoId = state.view.repoId;
    if (repoId) openInIde(repoId, null, e.currentTarget);
  });
  $('#workspace-copy-path').addEventListener('click', async () => {
    const path = $('#workspace-info-path').textContent;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      toast('Path copied', 'info');
    } catch { toast('Could not copy the path'); }
  });
  $('#workspace-worktree-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-task-link]')?.dataset.taskLink;
    if (id) { $('#modal-workspace').classList.add('hidden'); openDrawer(id); return; }
    const termPath = e.target.closest('[data-term-wt]')?.dataset.termWt;
    if (termPath) { $('#modal-workspace').classList.add('hidden'); openTerminalAt(state.view.repoId, termPath); return; }
    const revealBtn = e.target.closest('[data-reveal-wt]');
    if (revealBtn) { revealPath(state.view.repoId, revealBtn.dataset.revealWt); return; }
    const ideBtn = e.target.closest('[data-ide-wt]');
    if (ideBtn) { openInIde(state.view.repoId, ideBtn.dataset.ideWt, ideBtn); return; }
    const wtPath = e.target.closest('[data-rm-wt]')?.dataset.rmWt;
    if (!wtPath) return;
    if (!confirm(`Remove worktree?\n${wtPath}\n\nThis discards any uncommitted changes in it.`)) return;
    const repoId = state.view.repoId;
    try {
      const { leftover } = await api('POST', `/api/repos/${repoId}/worktrees/remove`, { path: wtPath });
      toast(leftover ? 'Worktree removed — some files were left on disk' : 'Worktree removed', 'info');
      await refreshRepoWorktreesCard(repoId, true);
    } catch (e2) {
      toast(e2.message || 'Failed to remove worktree', 'error');
    }
  });
}

