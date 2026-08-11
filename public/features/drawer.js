/* Sr. Popo — drawer. No build step: native ES module. */
import { api, toast } from '../core/api.js';
import { $, state } from '../core/state.js';
import { renderDrawerHead, renderGroomingDrawerHead, renderOrchestrationDrawerHead } from './context-menu.js';
import { renderPermissionPrompts } from './permissions.js';
import { appendEvent, refreshPr, refreshRepoBranchForTask, scrollTimeline } from './pr.js';


// ---------- drawer / timeline ----------
const timeline = {
  toolRows: new Map(),   // tool_use_id -> tool row element
  subagents: new Map(),  // Task tool_use_id -> { group, body, head }
  // The Grok text/thought block currently being streamed into, if any:
  // { kind, text, body }. See appendGrokDelta.
  stream: null,
};

// Drop the per-session render state before (re)playing a timeline, so a drawer
// never folds new events into the previous session's elements.
function resetTimelineState() {
  timeline.toolRows.clear();
  timeline.subagents.clear();
  timeline.stream = null;
}

async function openDrawer(taskId) {
  state.openTaskId = taskId;
  state.openGroomingId = null;
  state.openOrchestrationId = null;
  $('#drawer').classList.remove('hidden');
  $('#drawer-overlay').classList.remove('hidden');
  $('#timeline').innerHTML = '<div class="ev-meta">loading session…</div>';
  resetTimelineState();

  try {
    const { task, events } = await api('GET', `/api/tasks/${taskId}/logs`);
    state.tasks.set(task.id, task);
    renderDrawerHead(task);
    renderPermissionPrompts(taskId);
    if (task.branch) refreshPr(task.id, true); // lazily fetch the PR when the drawer opens
    if (!task.useWorktree) refreshRepoBranchForTask(task.id);
    $('#timeline').innerHTML = '';
    for (const ev of events) appendEvent(ev);
    scrollTimeline();
  } catch (e) { toast(e.message); }
}

// The same drawer, showing a grooming card: its idea, the read-only session's
// timeline, and (once finished) the tasks it spawned.
async function openGroomingDrawer(groomingId) {
  state.openTaskId = null;
  state.openGroomingId = groomingId;
  state.openOrchestrationId = null;
  $('#drawer').classList.remove('hidden');
  $('#drawer-overlay').classList.remove('hidden');
  $('#timeline').innerHTML = '<div class="ev-meta">loading session…</div>';
  resetTimelineState();
  renderPermissionPrompts(null);

  try {
    const { grooming, events } = await api('GET', `/api/groomings/${groomingId}/logs`);
    state.groomings.set(grooming.id, grooming);
    renderGroomingDrawerHead(grooming);
    $('#timeline').innerHTML = events.length ? '' : '<div class="ev-meta">not groomed yet — run it to start the session</div>';
    for (const ev of events) appendEvent(ev);
    scrollTimeline();
  } catch (e) { toast(e.message); }
}

// The same drawer again, showing an orchestration card: its goal, the orchestrator
// session's timeline, the worker tasks it spawned, and (when it asked
// something) a reply box.
async function openOrchestrationDrawer(orchestrationId) {
  state.openTaskId = null;
  state.openGroomingId = null;
  state.openOrchestrationId = orchestrationId;
  $('#drawer').classList.remove('hidden');
  $('#drawer-overlay').classList.remove('hidden');
  $('#timeline').innerHTML = '<div class="ev-meta">loading session…</div>';
  resetTimelineState();
  renderPermissionPrompts(null);

  try {
    const { orchestration, events } = await api('GET', `/api/orchestrations/${orchestrationId}/logs`);
    state.orchestrations.set(orchestration.id, orchestration);
    renderOrchestrationDrawerHead(orchestration);
    $('#timeline').innerHTML = events.length ? '' : '<div class="ev-meta">not started yet — run it to plan the goal</div>';
    for (const ev of events) appendEvent(ev);
    scrollTimeline();
  } catch (e) { toast(e.message); }
}

function closeDrawer() {
  state.openTaskId = null;
  state.openGroomingId = null;
  state.openOrchestrationId = null;
  $('#drawer').classList.add('hidden');
  $('#drawer-overlay').classList.add('hidden');
  renderPermissionPrompts(null);
}

export { closeDrawer, openDrawer, openGroomingDrawer, openOrchestrationDrawer, timeline };
