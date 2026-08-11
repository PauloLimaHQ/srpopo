/* Sr. Popo — permissions. No build step: native ES module. */
import { api, esc, hasPermissionBridge, toast } from '../core/api.js';
import { $, icon, isAutoApprove, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, setAutoApproveLocal, setPendingPermissions, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { moveToDone } from './dnd.js';
import { closeDrawer } from './drawer.js';
import { openFollowupModal } from './followup.js';
import { openBriefModal } from './grooming.js';
import { openOrchestrateModal } from './orchestrate.js';
import { toolInputSummary } from './pr.js';
import { notificationsOn, showBrowserNotification } from './settings.js';
import { playSound } from './sounds.js';
import { openTaskModal } from './task-modal.js';


// ---------- interactive permission prompts ----------

// Render the pending tool-approval prompts for the drawer's task. Each shows the
// requested tool + input and Allow/Deny buttons that resolve the waiting run.
function renderPermissionPrompts(taskId) {
  const box = $('#permission-prompts');
  if (!box) return;
  const task = taskId ? state.tasks.get(taskId) : null;
  const live = !!(task && isLive(task));
  const list = taskId ? pendingPermissions(taskId) : [];
  // The AUTO MODE toggle only makes sense when the run asks before each tool,
  // i.e. its permission mode is "Accept edits" — 'bypassPermissions' never
  // prompts, and 'plan'/'default' aren't the accept-edits flow we auto-approve.
  // Only Claude has an approval hook to auto-answer, so never for the others.
  const canAuto = live && task.permissionMode === 'acceptEdits' && hasPermissionBridge(task);
  // The box carries that toggle plus the pending prompts. Nothing to show for a
  // task that can't auto-approve and has no prompts.
  if (!canAuto && !list.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  const auto = isAutoApprove(taskId);
  const toggle = canAuto ? `
      <div class="perm-auto ${auto ? 'on' : ''}">
        <div class="perm-auto-label">
          ${icon(auto ? 'zap' : 'shield')}
          <span>${auto ? 'Auto-approve is on — every tool runs without asking' : 'Ask before each tool'}</span>
        </div>
        <button class="btn ${auto ? 'ghost' : 'primary'}" data-auto="${auto ? 'off' : 'on'}" title="Shift+Tab">
          ${auto ? 'Turn off auto' : 'Auto-approve all'}
        </button>
      </div>` : '';
  const prompts = list.map((r) => {
    const summary = toolInputSummary(r.toolName, r.input || {});
    return `
        <div class="perm-prompt" data-req="${esc(r.id)}">
          <div class="perm-head">${icon('shield')} <span>Approve <code>${esc(r.toolName)}</code>?</span></div>
          ${summary ? `<pre class="perm-summary">${esc(String(summary).slice(0, 400))}</pre>` : ''}
          <div class="perm-actions">
            <button class="btn ghost danger" data-perm="deny" data-req="${esc(r.id)}">Deny</button>
            <button class="btn primary" data-perm="allow" data-req="${esc(r.id)}">Allow</button>
          </div>
        </div>`;
  }).join('');
  box.innerHTML = toggle + prompts;
}

// Flip the open task's auto-approve mode. The server broadcasts the new state,
// which re-renders the toggle; we optimistically set it so the button responds.
async function toggleAutoApprove(taskId, on) {
  if (!taskId) return;
  const task = state.tasks.get(taskId);
  if (!task || !isLive(task)) return;
  setAutoApproveLocal(taskId, on);
  renderPermissionPrompts(taskId);
  renderBoard();
  try {
    await api('POST', `/api/tasks/${taskId}/auto-approve`, { auto: on });
  } catch (e) { toast(e.message); }
}

async function decidePermission(taskId, reqId, behavior) {
  // Optimistically clear it locally so the buttons can't be double-clicked.
  setPendingPermissions(taskId, pendingPermissions(taskId).filter((r) => r.id !== reqId));
  renderPermissionPrompts(state.openTaskId);
  renderBoard();
  try {
    await api('POST', `/api/tasks/${taskId}/permissions/${reqId}`, { behavior });
  } catch (e) { toast(e.message); }
}

// Live permission-prompt updates from the server: a new request appears, or an
// existing one is resolved (by anyone, or by the run ending).
function applyPermissionEvent(msg) {
  const list = pendingPermissions(msg.taskId);
  if (msg.action === 'request') {
    const isNew = !list.some((r) => r.id === msg.request.id);
    if (isNew) setPendingPermissions(msg.taskId, [...list, msg.request]);
    // The run is blocked until answered, so notify even under Electron — the tray
    // shell only surfaces task lifecycle, not permission prompts.
    if (isNew && notificationsOn()) maybeNotifyPermission(msg);
    if (isNew) playSound('permission');
  } else if (msg.action === 'resolved') {
    setPendingPermissions(msg.taskId, list.filter((r) => r.id !== msg.requestId));
  } else if (msg.action === 'auto') {
    setAutoApproveLocal(msg.taskId, !!msg.auto);
  }
  if (state.openTaskId === msg.taskId) renderPermissionPrompts(msg.taskId);
  renderBoard();
}

// Nudge the user that a run is blocked waiting on them — it can't proceed alone.
function maybeNotifyPermission(msg) {
  const t = state.tasks.get(msg.taskId);
  const title = t ? t.title : 'A task';
  showBrowserNotification('Approval needed', {
    body: `${title} wants to run ${msg.request.toolName}`,
    tag: `srpopo-perm-${msg.taskId}`,
  });
}

// The per-task action set shared by the drawer's action row and the card's
// right-click menu, so the two can never drift out of sync. Each action owns
// its label/icon/class plus the async handler that performs it.
function taskCoreActions(t) {
  const actions = [];
  if (isLive(t)) {
    actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
      run: () => api('POST', `/api/tasks/${t.id}/stop`) });
  } else {
    if (t.status === 'backlog' || t.status === 'ready') {
      actions.push({ id: 'dispatch', label: 'Run', icon: 'play', cls: 'primary',
        run: () => api('POST', `/api/tasks/${t.id}/dispatch`) });
    }
    // A fresh reviewer session over the branch — needs an open PR to comment on,
    // which the server enforces (409) rather than the board guessing.
    if (t.branch) {
      actions.push({ id: 'code-review', label: 'Code Review', icon: 'search', cls: 'ghost',
        title: 'Grade this branch with a fresh read-only reviewer and comment on its PR',
        run: () => api('POST', `/api/tasks/${t.id}/code-review`) });
    }
    actions.push({ id: 'edit', label: 'Edit', icon: 'pencil', cls: 'ghost',
      run: () => { openTaskModal(t); } });
    actions.push({ id: 'archive', label: 'Archive', cls: 'ghost',
      run: async () => {
        await api('POST', `/api/tasks/${t.id}/archive`);
        if (state.openTaskId === t.id) closeDrawer();
      } });
  }
  if (t.worktreePath) {
    actions.push({ id: 'copy-wt', label: 'Copy worktree path', cls: 'ghost', title: t.worktreePath,
      run: async () => { await navigator.clipboard.writeText(t.worktreePath); toast('Worktree path copied', 'info'); } });
    if (!isLive(t)) {
      actions.push({ id: 'rm-wt', label: 'Remove worktree', cls: 'ghost danger',
        run: async () => {
          const { leftover } = await api('POST', `/api/tasks/${t.id}/worktree/remove`);
          toast(leftover ? 'Worktree removed — some files were left on disk' : 'Worktree removed', 'info');
        } });
    }
  }
  return actions;
}

// Adds the two actions only reachable via drag-and-drop today (dropping a
// finished card on Running/Done) so the context menu offers them directly.
function taskContextMenuActions(t) {
  const actions = taskCoreActions(t);
  if (!isLive(t) && t.sessionId) {
    actions.push({ id: 'followup', label: 'Follow-up', icon: 'play', cls: 'ghost',
      run: () => { openFollowupModal(t); } });
  }
  if (!isLive(t) && t.status !== 'done') {
    actions.push({ id: 'move-done', label: 'Move to Done', icon: 'check', cls: 'ghost',
      run: () => moveToDone(t) });
  }
  return actions;
}

// The per-grooming action set shared by the drawer's action row and the
// card's right-click menu — mirrors taskCoreActions for grooming cards.
function groomingCoreActions(g) {
  const actions = [];
  if (isGroomingLive(g)) {
    actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
      run: () => api('POST', `/api/groomings/${g.id}/stop`) });
    return actions;
  }
  if (g.status === 'draft' || g.status === 'failed') {
    actions.push({ id: 'groom', label: 'Groom', icon: 'sparkles', cls: 'primary',
      run: () => api('POST', `/api/groomings/${g.id}/run`) });
    actions.push({ id: 'edit', label: 'Edit', icon: 'pencil', cls: 'ghost',
      run: () => { openBriefModal(g); } });
  }
  // An awaiting card answers via the drawer form; the action here is the escape
  // hatch to discard the questions and groom the idea again from scratch.
  if (g.status === 'awaiting') {
    actions.push({ id: 'regroom', label: 'Start over', icon: 'rotate-cw', cls: 'ghost',
      run: () => api('POST', `/api/groomings/${g.id}/run`) });
  }
  actions.push({ id: 'archive', label: 'Archive', cls: 'ghost',
    run: async () => {
      await api('POST', `/api/groomings/${g.id}/archive`);
      if (state.openGroomingId === g.id) closeDrawer();
    } });
  actions.push({ id: 'delete', label: 'Delete', icon: 'trash', cls: 'ghost danger',
    run: async () => {
      if (!confirm(`Delete grooming “${g.title}”?\n\nThis removes the card and its session log. Tasks it spawned are kept.`)) return;
      await api('DELETE', `/api/groomings/${g.id}`);
      if (state.openGroomingId === g.id) closeDrawer();
    } });
  return actions;
}

// The per-orchestration action set shared by the drawer's action row and the
// card's right-click menu — mirrors groomingCoreActions.
function orchestrationCoreActions(o) {
  const actions = [];
  if (isOrchestrationLive(o) || o.status === 'waiting') {
    actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
      title: o.status === 'waiting' ? 'Stop watching the worker tasks and park this goal' : 'Stop the orchestrator session',
      run: () => api('POST', `/api/orchestrations/${o.id}/stop`) });
    return actions;
  }
  if (o.status === 'draft' || o.status === 'failed') {
    actions.push({ id: 'run', label: 'Orchestrate', icon: 'crown', cls: 'primary',
      run: () => openOrchestrateModal(o) });
    actions.push({ id: 'edit', label: 'Edit', icon: 'pencil', cls: 'ghost',
      run: () => { openOrchestrateModal(o); } });
  }
  // An awaiting card answers via the drawer form; this is the escape hatch to
  // discard the question and re-plan the goal from scratch.
  if (o.status === 'awaiting') {
    actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
      run: () => api('POST', `/api/orchestrations/${o.id}/stop`) });
  }
  actions.push({ id: 'archive', label: 'Archive', cls: 'ghost',
    run: async () => {
      await api('POST', `/api/orchestrations/${o.id}/archive`);
      if (state.openOrchestrationId === o.id) closeDrawer();
    } });
  actions.push({ id: 'delete', label: 'Delete', icon: 'trash', cls: 'ghost danger',
    run: async () => {
      if (!confirm(`Delete orchestration “${o.title}”?\n\nThis removes the card and its session log. The worker tasks it created are kept.`)) return;
      await api('DELETE', `/api/orchestrations/${o.id}`);
      if (state.openOrchestrationId === o.id) closeDrawer();
    } });
  return actions;
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // One delegated handler for every Allow/Deny button and the AUTO MODE toggle.
  $('#permission-prompts').addEventListener('click', (e) => {
    if (!state.openTaskId) return;
    const autoBtn = e.target.closest('[data-auto]');
    if (autoBtn) { toggleAutoApprove(state.openTaskId, autoBtn.dataset.auto === 'on'); return; }
    const btn = e.target.closest('[data-perm]');
    if (btn) decidePermission(state.openTaskId, btn.dataset.req, btn.dataset.perm);
  });

  // Shift+Tab, while a live task's drawer is open, toggles AUTO MODE — mirrors the
  // Claude Code shortcut. Ignored while typing so it can't fire from an input.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.shiftKey) return;
    if (!state.openTaskId) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const task = state.tasks.get(state.openTaskId);
    // Only the "Accept edits" flow exposes AUTO MODE — match renderPermissionPrompts
    // (the other backends never prompt, so they have no AUTO MODE).
    if (!task || !isLive(task) || task.permissionMode !== 'acceptEdits' || !hasPermissionBridge(task)) return;
    e.preventDefault();
    toggleAutoApprove(state.openTaskId, !isAutoApprove(state.openTaskId));
  });
}


export { applyPermissionEvent, groomingCoreActions, orchestrationCoreActions, renderPermissionPrompts, taskContextMenuActions, taskCoreActions };
