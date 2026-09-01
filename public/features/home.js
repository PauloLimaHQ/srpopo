/* Sr. Popo — home. No build step: native ES module.
 *
 * The Super View's front door: a centered composer that queues a task into any
 * project without opening the New Task dialog, plus the last few tasks across
 * every project underneath it. The workspace grid still lives in
 * features/workspaces.js — this module owns everything above it.
 *
 * The composer is deliberately the *short* form of the New Task dialog: the
 * prompt, which project it runs in, the agent, the model and worktree. Every
 * other run setting comes from the same place the dialog would take it from —
 * the workspace's settings when it has any, the browser's last-used memory
 * otherwise (see features/repo-settings.js) — and "More options" hands what
 * you've typed to the full dialog rather than making you start over.
 *
 * Its markup is static in index.html, not rendered here: the Super View
 * re-renders on every SSE tick, and rebuilding the composer would wipe what
 * the user is typing. renderHome() only refills what actually changes.
 */
import { api, esc, relativeTime, toast } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, MOD, isLive, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { openDrawer } from './drawer.js';
import { repoSettingsFor, wsConfigured, wsTaskDefaults } from './repo-settings.js';
import { loadLastUsed, openTaskModalWith, saveLastUsed } from './task-modal.js';


// ---------- home ----------
// How many recent tasks the list shows. Same reasoning as the sidebar's row
// cap: this is a way back into what you were doing, not a second board.
const HOME_RECENT = 5;

// Which repos the <select> was last built from, so an SSE tick doesn't rebuild
// (and collapse) a picker the user may have open. Rebuilt only when the set of
// repositories, their order or their names actually changed.
let repoSelectSig = '';
// The first render seeds the composer from the workspace/last-used defaults;
// after that the user's picks are theirs to keep.
let seeded = false;

// Addressed by name when git knows one (GET /api/health reads `git config
// user.name` — see server/git.ts), by time of day otherwise. First name only:
// the greeting is a hello, not a signature.
function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const name = (state.health?.user || '').trim().split(/\s+/)[0];
  return name ? `${part}, ${name}` : part;
}

// Show only the chosen agent's models, exactly like the New Task dialog's
// picker does: options tagged data-agent (or data-custom, which are
// Claude/Bedrock models) belong to one backend; the untagged "Account default"
// is always there. A selection that belongs to another agent falls back to it.
function syncHomeModels() {
  const agent = $('#home-agent').value;
  const sel = $('#home-model');
  for (const opt of sel.options) {
    const a = opt.dataset.agent || (opt.dataset.custom ? 'claude' : null);
    opt.hidden = a ? a !== agent : false;
  }
  if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden) sel.value = 'default';
}

// Where a task created here takes its unshown settings from — the workspace's
// own defaults when it has any, the last task you created otherwise.
function defaultsFor(repoId) {
  const ws = repoSettingsFor(repoId);
  return wsConfigured(ws) ? wsTaskDefaults(ws) : loadLastUsed();
}

// Seed the three visible run settings from that source. Called when the
// project changes (its defaults are the whole point) and once on first render.
function applyHomeDefaults(repoId) {
  const src = defaultsFor(repoId);
  $('#home-agent').value = src.agent || 'claude';
  syncHomeModels();
  $('#home-model').value = src.model || 'default';
  syncHomeModels();
  $('#home-worktree').checked = src.useWorktree ?? true;
  renderHomeHint(repoId);
}

// One line under the composer saying where the settings it doesn't show came
// from, so "Create & Run" is never a surprise.
function renderHomeHint(repoId) {
  const configured = wsConfigured(repoSettingsFor(repoId));
  $('#home-hint').innerHTML =
    `${configured ? 'Using this workspace\'s task defaults' : 'Using your last-used task settings'}` +
    ` for permissions, add-ons and personas · <span class="kbd">${esc(MOD)}</span><span class="kbd">↵</span> to run` +
    ` · <strong>More options</strong> for the full form.`;
}

function refreshHomeRepoSelect() {
  const sel = $('#home-repo');
  const sig = state.repos.map((r) => `${r.id}:${r.name}`).join('|');
  if (sig === repoSelectSig) return;
  repoSelectSig = sig;
  const keep = sel.value;
  sel.innerHTML = state.repos.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  // Keep the picked project across a rebuild; otherwise fall back to the
  // last-used one, and finally to the first repository in the list.
  const last = loadLastUsed().repoId;
  if (state.repos.some((r) => r.id === keep)) sel.value = keep;
  else if (state.repos.some((r) => r.id === last)) sel.value = last;
}

// What a task's status reads as in the recent list: its column's label and dot,
// with `failed` called out rather than folded into Validation the way the board
// folds it (there's no red badge here to carry the distinction).
function statusMeta(t) {
  if (t.status === 'failed') return { label: 'Failed', dot: 'var(--red)' };
  const col = COLUMNS.find((c) => c.key === COLUMN_OF_STATUS[t.status]);
  return { label: col ? col.label : t.status, dot: col ? col.dot : 'var(--text-dim)' };
}

// The last few tasks across every project, most recently touched first — the
// way back into whatever you were doing before, from the one screen that has
// no board of its own.
function renderHomeRecent() {
  const tasks = [...state.tasks.values()]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, HOME_RECENT);
  $('#home-recent-section').classList.toggle('hidden', !state.repos.length);
  const el = $('#home-recent');
  if (!tasks.length) {
    el.innerHTML = '<div class="home-recent-empty">No tasks yet — describe one above.</div>';
    return;
  }
  el.innerHTML = tasks.map((t) => {
    const { label, dot } = statusMeta(t);
    const repo = state.repos.find((r) => r.id === t.repoId);
    return `
      <button class="home-recent-row" data-task="${esc(t.id)}" title="${esc(t.title)}">
        <span class="home-recent-dot" style="background:${dot}"></span>
        <span class="home-recent-main">
          <span class="home-recent-title">${esc(t.title)}</span>
          <span class="home-recent-meta">${esc(repo ? repo.name : t.repoName || '')} · ${esc(label)}</span>
        </span>
        ${isLive(t) ? '<span class="spinner"></span>' : ''}
        <span class="home-recent-time">${esc(relativeTime(t.updatedAt || t.createdAt))}</span>
      </button>`;
  }).join('');
}

// Called by renderSuperView on every tick — so everything here is either cheap
// or guarded against clobbering what the user is doing.
function renderHome() {
  const has = state.repos.length > 0;
  $('#home-hero').classList.toggle('hidden', !has);
  $('#home-projects-head').classList.toggle('hidden', !has);
  $('#home-greeting-text').textContent = greeting();
  if (has) {
    refreshHomeRepoSelect();
    if (!seeded) { seeded = true; applyHomeDefaults($('#home-repo').value); }
    else renderHomeHint($('#home-repo').value);
  }
  renderHomeRecent();
}

// The composer's own fields, laid over the run settings it doesn't show.
function composerFields(repoId) {
  const ws = repoSettingsFor(repoId);
  const src = defaultsFor(repoId);
  return {
    prompt: $('#home-prompt').value.trim(),
    agent: $('#home-agent').value,
    model: $('#home-model').value,
    permissionMode: src.permissionMode || 'acceptEdits',
    allowedTools: src.allowedTools || '',
    useWorktree: $('#home-worktree').checked,
    branchName: '',
    // The workspace's base branch if it pins one; otherwise the historical
    // default (cut from whatever the repo is on at dispatch).
    baseBranch: ws.baseBranch || '',
    addons: src.addons || [],
    prDraft: !!src.prDraft,
    autoCodeReview: !!src.autoCodeReview,
    personas: src.personas || [],
    autoPersona: !!src.autoPersona,
  };
}

let submitting = false;

async function submitHome(run) {
  if (submitting) return;
  const repoId = $('#home-repo').value;
  if (!repoId) { toast('Add a repository first'); return; }
  const fields = composerFields(repoId);
  if (!fields.prompt) { toast('Describe the task first'); $('#home-prompt').focus(); return; }
  submitting = true;
  $('#home-run').disabled = true;
  $('#home-backlog').disabled = true;
  try {
    const task = await api('POST', '/api/tasks', { ...fields, repoId, status: run ? 'ready' : 'backlog' });
    saveLastUsed(fields, repoId);
    state.tasks.set(task.id, task);
    $('#home-prompt').value = '';
    autoGrow();
    renderBoard();
    if (!run) { toast(`Added to Backlog — ${task.title}`, 'info'); return; }
    try {
      await api('POST', `/api/tasks/${task.id}/dispatch`);
    } catch (e) { toast(e.message); }
    // Straight into the session it just started: the drawer sits over Home, so
    // closing it lands you back here rather than inside a board you didn't ask
    // to open.
    openDrawer(task.id);
  } catch (e) {
    toast(e.message);
  } finally {
    submitting = false;
    $('#home-run').disabled = false;
    $('#home-backlog').disabled = false;
  }
}

// Grow the prompt box with its content up to a ceiling, then scroll — a long
// brief shouldn't push the recent list off the screen.
function autoGrow() {
  const el = $('#home-prompt');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {
  $('#home-prompt').addEventListener('input', autoGrow);
  $('#home-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitHome(true); }
  });
  $('#home-repo').addEventListener('change', () => applyHomeDefaults($('#home-repo').value));
  $('#home-agent').addEventListener('change', syncHomeModels);
  $('#home-run').addEventListener('click', () => submitHome(true));
  $('#home-backlog').addEventListener('click', () => submitHome(false));
  $('#home-more').addEventListener('click', () => {
    openTaskModalWith({
      repoId: $('#home-repo').value,
      prompt: $('#home-prompt').value,
      agent: $('#home-agent').value,
      model: $('#home-model').value,
      useWorktree: $('#home-worktree').checked,
    });
    $('#home-prompt').value = '';
    autoGrow();
  });
  $('#home-recent').addEventListener('click', (e) => {
    const id = e.target.closest('[data-task]')?.dataset.task;
    if (id) openDrawer(id);
  });
  // The greeting is the one thing here that goes stale on its own — refresh it
  // (and the "5m ago" labels next to it) every minute while Home is on screen.
  setInterval(() => { if (state.view.mode === 'super') renderHome(); }, 60000);
}


export { renderHome };
