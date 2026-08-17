/* Sr. Popo — settings. No build step: native ES module. */
import { toast } from '../core/api.js';
import { $, isElectron, state } from '../core/state.js';
import { renderAutonomous } from './autonomous.js';
import { renderRunButton } from './scripts.js';
import { playSound } from './sounds.js';


// ---------- settings ----------
const notificationsOn = () => state.settings.notifications !== false;

function browserNotifySupported() {
  return typeof Notification !== 'undefined';
}

// Ask the browser for notification permission (no-op / already-resolved cases
// return synchronously via the resolved promise). Not needed under Electron.
async function ensureNotifyPermission() {
  if (isElectron || !browserNotifySupported()) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try { return (await Notification.requestPermission()) === 'granted'; }
  catch { return false; }
}

// Show a Web Notification (browser mode only). `force` surfaces a toast when we
// can't — used by the "test" button so the click always gives feedback.
function showBrowserNotification(title, opts, force = false) {
  if (!browserNotifySupported()) {
    if (force) toast('This browser does not support notifications', 'info');
    return;
  }
  if (Notification.permission === 'granted') {
    try { new Notification(title, opts); } catch { /* ignore */ }
  } else if (force) {
    ensureNotifyPermission().then((ok) => {
      if (ok) { try { new Notification(title, opts); } catch { /* ignore */ } }
      else toast('Allow notifications for this site in your browser first', 'info');
    });
  }
}

// Browser fallback: notify when a task leaves the running state (finished/
// failed). Under Electron the shell handles this natively, so skip it here.
function maybeNotifyBrowser(prev, task) {
  if (isElectron || !notificationsOn()) return;
  if (!prev || prev.status !== 'running' || task.status === 'running') return;
  if (task.lastOutcome === 'stopped') return;
  let title, body;
  if (task.status === 'failed') {
    title = `Task failed — ${task.title}`;
    body = task.lastError ? String(task.lastError).slice(0, 140) : task.repoName;
  } else {
    title = `Task finished — ${task.title}`;
    body = task.repoName;
  }
  showBrowserNotification(title, { body, tag: `srpopo-${task.id}` });
}

// Play a cue when a task leaves the running state — in both browser and
// Electron (unlike notifications, the tray shell doesn't sound these itself).
function maybePlayTaskSound(prev, task) {
  if (!prev || prev.status !== 'running' || task.status === 'running') return;
  if (task.lastOutcome === 'stopped') return;
  playSound(task.status === 'failed' ? 'failed' : 'finish');
}

// Same pair for grooming cards leaving their running state.
function maybeNotifyGroomingBrowser(prev, g) {
  if (isElectron || !notificationsOn()) return;
  if (!prev || prev.status !== 'running' || g.status === 'running') return;
  if (g.lastOutcome === 'stopped') return;
  let title, body;
  if (g.status === 'awaiting') {
    const q = (g.questions || []).length;
    title = `Grooming needs input — ${g.title}`;
    body = `${g.repoName} · ${q} question${q === 1 ? '' : 's'} to answer`;
  } else if (g.status === 'failed') {
    title = `Grooming failed — ${g.title}`;
    body = g.lastError ? String(g.lastError).slice(0, 140) : g.repoName;
  } else {
    const n = (g.taskIds || []).length;
    title = `Idea groomed — ${g.title}`;
    body = `${g.repoName} · ${n} task${n === 1 ? '' : 's'} created`;
  }
  showBrowserNotification(title, { body, tag: `srpopo-${g.id}` });
}

function maybePlayGroomingSound(prev, g) {
  if (!prev || prev.status !== 'running' || g.status === 'running') return;
  if (g.lastOutcome === 'stopped') return;
  // 'awaiting' and a clean finish both chime; only a real failure buzzes.
  playSound(g.status === 'failed' ? 'failed' : 'finish');
}

// Orchestration cards notify/chime only on the states that actually want the
// developer's attention — a turn ending in `waiting` is the engine doing its
// job, and announcing every one of those would be noise.
const ORCH_NOTIFY_STATES = ['awaiting', 'finished', 'failed'];

function maybeNotifyOrchestrationBrowser(prev, o) {
  if (isElectron || !notificationsOn()) return;
  if (!prev || prev.status !== 'running' || !ORCH_NOTIFY_STATES.includes(o.status)) return;
  if (o.lastOutcome === 'stopped') return;
  let title, body;
  if (o.status === 'awaiting') {
    title = `Orchestrator needs input — ${o.title}`;
    body = o.note ? String(o.note).slice(0, 140) : o.repoName;
  } else if (o.status === 'failed') {
    title = `Orchestration failed — ${o.title}`;
    body = o.lastError ? String(o.lastError).slice(0, 140) : o.repoName;
  } else {
    const n = (o.taskIds || []).length;
    title = `Goal complete — ${o.title}`;
    body = `${o.repoName} · ${n} worker task${n === 1 ? '' : 's'}`;
  }
  showBrowserNotification(title, { body, tag: `srpopo-${o.id}` });
}

function maybePlayOrchestrationSound(prev, o) {
  if (!prev || prev.status !== 'running' || !ORCH_NOTIFY_STATES.includes(o.status)) return;
  if (o.lastOutcome === 'stopped') return;
  playSound(o.status === 'failed' ? 'failed' : 'finish');
}

function updateNotifNote() {
  const note = $('#setting-notif-note');
  if (isElectron) { note.textContent = 'Delivered through your system’s notification center.'; return; }
  if (!browserNotifySupported()) { note.textContent = 'This browser does not support notifications.'; return; }
  if (Notification.permission === 'denied') {
    note.textContent = 'Blocked — enable notifications for this site in your browser settings.';
  } else {
    note.textContent = 'Shown by your browser while Sr. Popo is open.';
  }
}

// ---------- plugins / marketplace ----------
const installedPluginIds = () => state.settings.installedPlugins || [];
const pluginInstalled = (id) => installedPluginIds().includes(id);

// Show/hide plugin-gated UI on the board. A plugin's features only surface once
// it's installed — the "Brief an Idea" / "From Linear" header buttons and the
// Autonomous control. (The Grooming column itself is gated in renderBoard.)
function renderPluginState() {
  $('#btn-brief').classList.toggle('hidden', !pluginInstalled('grooming'));
  $('#btn-orchestrate').classList.toggle('hidden', !pluginInstalled('orchestration'));
  $('#btn-linear').classList.toggle('hidden', !pluginInstalled('linear'));
  $('#btn-specs').classList.toggle('hidden', !pluginInstalled('repo-specs'));
  // The workspace Run button also depends on the checkout having scripts, so
  // its own render decides — this just makes installing/removing the plugin
  // show up without a reload.
  renderRunButton();
  renderAutonomous();
}

export { ensureNotifyPermission, installedPluginIds, maybeNotifyBrowser, maybeNotifyGroomingBrowser, maybeNotifyOrchestrationBrowser, maybePlayGroomingSound, maybePlayOrchestrationSound, maybePlayTaskSound, notificationsOn, pluginInstalled, renderPluginState, showBrowserNotification, updateNotifNote };
