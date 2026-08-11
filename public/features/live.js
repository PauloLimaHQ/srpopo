/* Sr. Popo — live. No build step: native ES module. */
import { $, state } from '../core/state.js';
import { appendAskEvent, finishAsk } from './ask.js';
import { renderAutonomous, renderPlugins } from './autonomous.js';
import { renderBoard } from './board.js';
import { renderDrawerHead, renderGroomingDrawerHead, renderOrchestrationDrawerHead } from './context-menu.js';
import { syncDesktopLabels } from './desktop.js';
import { closeDrawer } from './drawer.js';
import { refreshBriefRepoSelect } from './grooming.js';
import { refreshLinearRepoSelect, renderLinearConfigState } from './linear.js';
import { renderCustomModels, syncCustomModelOptions } from './models.js';
import { refreshOrchRepoSelect } from './orchestrate.js';
import { applyPermissionEvent, renderPermissionPrompts } from './permissions.js';
import { appendEvent } from './pr.js';
import { renderRemoteAccess } from './remote.js';
import { renderRepoList } from './repos-modal.js';
import { resourceMonitorOn, syncResourceMonitor } from './resources.js';
import { renderEditorSetting, renderSessionMemorySetting } from './settings-modal.js';
import { maybeNotifyBrowser, maybeNotifyGroomingBrowser, maybeNotifyOrchestrationBrowser, maybePlayGroomingSound, maybePlayOrchestrationSound, maybePlayTaskSound, notificationsOn, renderPluginState, updateNotifNote } from './settings.js';
import { soundsOn } from './sounds.js';
import { refreshRepoSelect } from './task-modal.js';
import { exitWorkspace, renderView } from './workspaces.js';


// ---------- live updates ----------
function connectSSE() {
  const es = new EventSource('/api/events');
  // A (re)connected stream means the server is answering again — restart the
  // resource poll if it parked itself while the server was down.
  es.onopen = () => syncResourceMonitor();
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'task') {
      const prev = state.tasks.get(msg.task.id);
      state.tasks.set(msg.task.id, msg.task);
      renderBoard();
      if (state.openTaskId === msg.task.id) {
        renderDrawerHead(msg.task);
        // The AUTO MODE toggle only shows while the task is live, so re-render
        // the permission box as it starts/stops running.
        renderPermissionPrompts(msg.task.id);
      }
      // Keep the open grooming drawer's spawned-task links (their status
      // chips) in sync when one of its tasks changes.
      if (state.openGroomingId && msg.task.groomingId === state.openGroomingId) {
        const g = state.groomings.get(state.openGroomingId);
        if (g) renderGroomingDrawerHead(g);
      }
      // Same for an open orchestration drawer's worker-task links.
      if (state.openOrchestrationId) {
        const o = state.orchestrations.get(state.openOrchestrationId);
        if (o && (o.taskIds || []).includes(msg.task.id)) renderOrchestrationDrawerHead(o);
      }
      maybeNotifyBrowser(prev, msg.task);
      maybePlayTaskSound(prev, msg.task);
    } else if (msg.type === 'settings') {
      state.settings = msg.settings;
      renderPluginState();
      if (!$('#modal-settings').classList.contains('hidden')) {
        $('#setting-notifications').checked = notificationsOn();
        $('#setting-sounds').checked = soundsOn();
        $('#setting-max-parallel').value = state.settings.maxParallelSessions || 3;
        $('#setting-merge-strategy').value = state.settings.mergeStrategy || 'merge';
        $('#setting-min-merge-grade').value = String(state.settings.minMergeGrade || 4);
        $('#setting-auto-resolve-conflicts').checked = !!state.settings.autoResolveConflicts;
        $('#setting-assign-pr-to-self').checked = !!state.settings.assignPrToSelf;
        $('#setting-memory').checked = !!state.settings.memory;
        $('#setting-resource-monitor').checked = resourceMonitorOn();
        renderSessionMemorySetting();
        updateNotifNote();
        renderEditorSetting();
        renderPlugins();
        renderCustomModels();
        renderRemoteAccess();
      }
      syncCustomModelOptions();
      // The resource-monitor toggle starts/stops the polling loop and the chip.
      syncResourceMonitor();
      // The default IDE names the header/modal buttons, so re-label on change.
      syncDesktopLabels();
      if (!$('#modal-linear').classList.contains('hidden')) renderLinearConfigState();
      renderBoard();
    } else if (msg.type === 'task-removed') {
      state.tasks.delete(msg.taskId);
      renderBoard();
    } else if (msg.type === 'grooming') {
      const prev = state.groomings.get(msg.grooming.id);
      state.groomings.set(msg.grooming.id, msg.grooming);
      renderBoard();
      if (state.openGroomingId === msg.grooming.id) renderGroomingDrawerHead(msg.grooming);
      maybeNotifyGroomingBrowser(prev, msg.grooming);
      maybePlayGroomingSound(prev, msg.grooming);
    } else if (msg.type === 'grooming-removed') {
      state.groomings.delete(msg.groomingId);
      if (state.openGroomingId === msg.groomingId) closeDrawer();
      renderBoard();
    } else if (msg.type === 'orchestration') {
      const prev = state.orchestrations.get(msg.orchestration.id);
      state.orchestrations.set(msg.orchestration.id, msg.orchestration);
      renderBoard();
      if (state.openOrchestrationId === msg.orchestration.id) renderOrchestrationDrawerHead(msg.orchestration);
      maybeNotifyOrchestrationBrowser(prev, msg.orchestration);
      maybePlayOrchestrationSound(prev, msg.orchestration);
    } else if (msg.type === 'orchestration-removed') {
      state.orchestrations.delete(msg.orchestrationId);
      if (state.openOrchestrationId === msg.orchestrationId) closeDrawer();
      renderBoard();
    } else if (msg.type === 'repos') {
      state.repos = msg.repos;
      renderRepoList();
      refreshRepoSelect();
      refreshBriefRepoSelect();
      refreshOrchRepoSelect();
      refreshLinearRepoSelect();
      // Fall back to the Super View if the workspace's own repo was just removed.
      if (state.view.mode === 'workspace' && !state.repos.some((r) => r.id === state.view.repoId)) exitWorkspace();
      else renderView();
    } else if (msg.type === 'log' && (msg.taskId === state.openTaskId || msg.taskId === state.openGroomingId || msg.taskId === state.openOrchestrationId)) {
      appendEvent(msg.event);
    } else if (msg.type === 'log' && msg.taskId === state.askId) {
      appendAskEvent(msg.event);
    } else if (msg.type === 'ask') {
      finishAsk(msg);
    } else if (msg.type === 'permission') {
      applyPermissionEvent(msg);
    } else if (msg.type === 'autonomous') {
      state.autonomous = msg.status || null;
      renderAutonomous();
    } else if (msg.type === 'pr') {
      // Background PR-status refresh (server/pr-refresh.ts) — keeps the
      // cached lookup honest even if no one opened this task's drawer.
      state.prByTask.set(msg.taskId, msg.result);
      const t = state.tasks.get(msg.taskId);
      if (t && state.openTaskId === msg.taskId) renderDrawerHead(t);
      renderBoard(); // update the card's PR chip color too
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
}

export { connectSSE };
