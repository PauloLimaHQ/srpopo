/* Sr. Popo — cards. No build step: native ES module. */
import { agentBadge, api, elapsedSince, esc, fmtDuration, modelClass, toast } from '../core/api.js';
import { icon, isAutoApprove, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, state } from '../core/state.js';
import { openContextMenu, openGroomingContextMenu, showContextMenu } from './context-menu.js';
import { stopTask } from './dnd.js';
import { openDrawer, openGroomingDrawer, openOrchestrationDrawer } from './drawer.js';
import { orchestrationCoreActions } from './permissions.js';
import { prChipHtml, refreshPr } from './pr.js';
import { openTaskTerminal } from './terminal.js';


// The 1-5 mergeable grade the Code Review stage assigned (server/reviewer.ts),
// in the same wording the reviewer prompt and the PR comment use.
const GRADE_MEANINGS = {
  1: 'must not be merged',
  2: 'still not mergeable, but better than 1',
  3: 'mergeable with reservations',
  4: 'mergeable, only nits',
  5: 'good to go',
};

function gradeChipHtml(cr) {
  const g = Math.min(5, Math.max(1, Math.round(Number(cr.grade) || 0)));
  return `<span class="chip grade g${g}" title="Code review grade ${g}/5 — ${esc(GRADE_MEANINGS[g])}">${icon('search')} mergeable ${g}/5</span>`;
}

function renderCard(t) {
  const el = document.createElement('div');
  el.className = `card ${isLive(t) ? 'running' : ''} ${t.status === 'failed' ? 'failed' : ''} ${t.resolvingConflicts ? 'resolving-conflicts' : ''}`;
  el.draggable = !isLive(t);
  el.dataset.id = t.id;

  const modelName = t.model === 'default' ? (t.resolvedModel || 'default') : t.model;
  const chips = [
    `<span class="chip repo">${esc(t.repoName)}</span>`,
  ];
  // Show the backend only for the non-default agent, so Claude cards read the
  // same as before; Codex and Grok get an explicit badge (no emoji — icons.js glyph).
  const badge = agentBadge(t);
  if (badge) chips.push(`<span class="chip agent-chip" title="${badge.title}">${icon(badge.icon)} ${badge.label}</span>`);
  chips.push(`<span class="chip model${modelClass(modelName)}">${esc(modelName)}</span>`);
  if (t.groomingId) chips.push(`<span class="chip grooming-chip" title="Spawned by a grooming">${icon('lightbulb')} groomed</span>`);
  if (t.resolvingConflicts) chips.push(`<span class="chip conflict-chip" title="Auto-resolving merge conflicts with main">${icon('git-branch')} Resolving Conflicts</span>`);
  if (t.useWorktree) chips.push(`<span class="chip worktree" title="${esc(t.worktreePath || 'worktree on dispatch')}">${icon('git-branch')} ${esc(t.branch || t.branchName || 'worktree')}</span>`);
  // Once a branch exists, prefer its live PR status (color-coded by
  // open/draft/merged/closed via prChipHtml) over the static "will open a
  // PR" hint — but only once we actually know there is one; an unknown or
  // not-yet-existing PR falls back to the addon's intent chip instead.
  const prRes = t.branch ? state.prByTask.get(t.id) : undefined;
  if (t.branch && (prRes === undefined || prRes === 'loading' || (prRes && prRes.pr))) {
    chips.push(prChipHtml(t));
    if (prRes === undefined) refreshPr(t.id);
  } else if (t.addons && t.addons.includes('pull_request')) {
    const draft = !!t.prDraft;
    chips.push(`<span class="chip addon-chip" title="${draft ? 'Opens a draft pull request when finished' : 'Opens a pull request when finished'}">${icon('git-pull-request')} PR${draft ? ' (draft)' : ''}</span>`);
  }
  if (t.addons && t.addons.includes('code_review')) chips.push(`<span class="chip addon-chip" title="Self code-reviews and fixes issues before finishing">${icon('search')} review</span>`);
  if (t.codeReview) chips.push(gradeChipHtml(t.codeReview));
  // Auto-detection replaces the hand-picked personas at dispatch, so show one
  // or the other — never both, which would misdescribe what actually runs.
  if (t.autoPersona) {
    chips.push(`<span class="chip persona-chip" title="Picks its own expert persona before starting">${icon('sparkles')} auto persona</span>`);
  } else {
    (t.personas || []).forEach((pid) => {
      const p = state.personas.find((x) => x.id === pid);
      chips.push(`<span class="chip persona-chip" title="${esc(p ? p.hint : 'persona')}">${icon('persona')} ${esc(p ? p.label : pid)}</span>`);
    });
  }
  if (t.costUsd > 0) chips.push(`<span class="chip cost">$${t.costUsd.toFixed(2)}</span>`);
  if (t.status === 'failed') chips.push(`<span class="chip badge-failed">FAILED</span>`);
  if (t.lastOutcome === 'stopped') chips.push(`<span class="chip badge-stopped">stopped</span>`);
  if (t.status === 'running' && t.activeSubagents > 0) {
    chips.push(`<span class="chip subagents">${icon('bot')} ${t.activeSubagents} subagent${t.activeSubagents > 1 ? 's' : ''}</span>`);
  }
  const pending = pendingPermissions(t.id).length;
  if (pending > 0) {
    chips.push(`<span class="chip needs-approval" title="Waiting for you to approve a tool">${icon('shield')} ${pending} to approve</span>`);
  }
  if (isLive(t) && isAutoApprove(t.id)) {
    chips.push(`<span class="chip auto-approve" title="Auto-approving every tool">${icon('zap')} auto</span>`);
  }

  let statusRow = '';
  if (isLive(t)) {
    statusRow = `
        <div class="card-status">
          <span class="spinner"></span>
          ${t.status === 'running' && t.resolvingConflicts ? '<span class="live-label">resolving conflicts</span>' : ''}
          ${t.status === 'code_review' ? '<span class="live-label">code review</span>' : ''}
          <span class="elapsed" data-start="${esc(t.startedAt)}">${elapsedSince(t.startedAt)}</span>
          <button class="btn icon danger card-stop" data-action="stop" title="Stop run" aria-label="Stop run">${icon('square')}</button>
        </div>`;
  } else if (t.durationMs != null) {
    statusRow = `<div class="card-status">last run ${fmtDuration(t.durationMs)} · ${t.numTurns ?? '?'} turns</div>`;
  }

  // Drop into a shell on this card's own checkout — its worktree once one has
  // been materialized, the repo root otherwise. It joins the session already
  // open on that directory rather than stacking a second one on it, which is
  // the point: sit down next to a run instead of watching it from the board.
  const termWhere = t.worktreePath || t.repoPath || '';
  const termTitle = `Terminal on this task's ${t.worktreePath ? 'worktree' : 'repo'} — joins the session already open on it${termWhere ? `\n${termWhere}` : ''}`;

  el.innerHTML = `
      <div class="card-head">
        <div class="card-title">${esc(t.title)}</div>
        <button class="btn icon card-terminal" data-action="terminal"
                title="${esc(termTitle)}" aria-label="${esc(`Open a terminal session on ${t.title}`)}">${icon('terminal')}</button>
      </div>
      <div class="card-chips">${chips.join('')}</div>
      ${statusRow}
      ${t.status === 'failed' && t.lastError ? `<div class="card-error">${esc(t.lastError.slice(0, 140))}</div>` : ''}`;

  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/task-id', t.id);
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="stop"]')) { stopTask(t.id); return; }
    if (e.target.closest('[data-action="terminal"]')) { openTaskTerminal(t); return; }
    openDrawer(t.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(t, e.clientX, e.clientY);
  });
  return el;
}

// Human labels for a grooming's target — where its spawned tasks land.
const GROOMING_TARGET_LABEL = { backlog: 'to backlog', ready: 'to ready', auto: 'auto' };

// A grooming card. Unlike task cards it never moves columns: its status only
// recolors it in place — draft (gray), running (purple), finished (green,
// with links to the tasks it spawned), failed (red badge).
function renderGroomingCard(g) {
  const el = document.createElement('div');
  el.className = `card groom groom-${g.status}`;
  el.draggable = false;
  el.dataset.id = g.id;

  const chips = [
    `<span class="chip model">${esc(g.model === 'default' ? (g.resolvedModel || 'default') : g.model)}</span>`,
    `<span class="chip" title="Where spawned tasks land">${esc(GROOMING_TARGET_LABEL[g.target] || 'to backlog')}</span>`,
  ];
  if (g.status === 'draft') chips.push(`<span class="chip badge-draft">DRAFT</span>`);
  if (g.status === 'awaiting') chips.push(`<span class="chip badge-awaiting">${icon('circle-help')} NEEDS INPUT</span>`);
  if (g.status === 'finished') chips.push(`<span class="chip badge-groomed">${icon('circle-check')} GROOMED</span>`);
  if (g.status === 'failed') chips.push(`<span class="chip badge-failed">FAILED</span>`);
  if (g.lastOutcome === 'stopped') chips.push(`<span class="chip badge-stopped">stopped</span>`);
  if (g.costUsd > 0) chips.push(`<span class="chip cost">$${g.costUsd.toFixed(2)}</span>`);

  let statusRow = '';
  if (isGroomingLive(g)) {
    statusRow = `
        <div class="card-status">
          <span class="spinner"></span>
          <span class="live-label">grooming</span>
          <span class="elapsed" data-start="${esc(g.startedAt)}">${elapsedSince(g.startedAt)}</span>
          <button class="btn icon danger card-stop" data-action="stop" title="Stop grooming" aria-label="Stop grooming">${icon('square')}</button>
        </div>`;
  }

  // An awaiting grooming nudges the user to open it and answer.
  let awaitingRow = '';
  if (g.status === 'awaiting') {
    const n = (g.questions || []).length;
    awaitingRow = `<div class="groom-awaiting-hint">${icon('circle-help')} ${n} question${n === 1 ? '' : 's'} — click to answer</div>`;
  }

  // A finished grooming links straight to the tasks it spawned.
  let taskLinks = '';
  if (g.status === 'finished' && (g.taskIds || []).length) {
    taskLinks = `<div class="groom-tasks">` + g.taskIds.map((id) => {
      const t = state.tasks.get(id);
      const label = t ? t.title : 'task (removed)';
      const status = t ? t.status : '';
      return `<button type="button" class="groom-task-link" data-task-link="${esc(id)}" ${t ? '' : 'disabled'}>
            ${icon('chevron-right')} <span class="groom-task-title">${esc(label)}</span>${status ? `<span class="chip">${esc(status)}</span>` : ''}
          </button>`;
    }).join('') + `</div>`;
  }

  el.innerHTML = `
      <div class="card-title">${esc(g.title)}</div>
      <div class="card-chips">${chips.join('')}</div>
      ${statusRow}
      ${awaitingRow}
      ${taskLinks}
      ${g.status === 'failed' && g.lastError ? `<div class="card-error">${esc(g.lastError.slice(0, 140))}</div>` : ''}`;

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="stop"]')) { stopGrooming(g.id); return; }
    const link = e.target.closest('[data-task-link]');
    if (link && !link.disabled) { openDrawer(link.dataset.taskLink); return; }
    openGroomingDrawer(g.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openGroomingContextMenu(g, e.clientX, e.clientY);
  });
  return el;
}

async function stopGrooming(id) {
  try { await api('POST', `/api/groomings/${id}/stop`); } catch (e) { toast(e.message); }
}

// Worker-task links, shared by an orchestration's card and its drawer: one
// row per task the orchestrator spawned, with its live status chip.
function orchestrationTaskLinksHtml(o) {
  if (!(o.taskIds || []).length) return '';
  return `<div class="groom-tasks">` + o.taskIds.map((id) => {
    const t = state.tasks.get(id);
    const watching = (o.watch || []).includes(id);
    return `<button type="button" class="groom-task-link${watching ? ' orch-watching' : ''}" data-task-link="${esc(id)}" ${t ? '' : 'disabled'}
          ${watching ? 'title="The orchestrator is waiting on this task"' : ''}>
          ${icon('chevron-right')} <span class="groom-task-title">${esc(t ? t.title : 'task (removed)')}</span>${t ? `<span class="chip">${esc(t.status)}</span>` : ''}
        </button>`;
  }).join('') + `</div>`;
}

// An orchestration card. Like a grooming card it never moves columns: its
// status only recolors it in place — draft (gray), running (purple), waiting
// on workers (blue), needs input (amber), finished (green), failed (red).
function renderOrchestrationCard(o) {
  const el = document.createElement('div');
  el.className = `card orch orch-${o.status}`;
  el.draggable = false;
  el.dataset.id = o.id;

  const chips = [
    `<span class="chip model">${esc(o.model === 'default' ? (o.resolvedModel || 'default') : o.model)}</span>`,
  ];
  if (o.mode === 'autonomous') {
    chips.push(`<span class="chip orch-mode" title="Worker tasks are dispatched and merged by Autonomous Mode">${icon('bot')} autonomous</span>`);
  }
  if (o.status === 'draft') chips.push(`<span class="chip badge-draft">DRAFT</span>`);
  if (o.status === 'waiting') chips.push(`<span class="chip badge-waiting">${icon('loader')} WATCHING</span>`);
  if (o.status === 'awaiting') chips.push(`<span class="chip badge-awaiting">${icon('circle-help')} NEEDS INPUT</span>`);
  if (o.status === 'finished') chips.push(`<span class="chip badge-groomed">${icon('circle-check')} DONE</span>`);
  if (o.status === 'failed') chips.push(`<span class="chip badge-failed">FAILED</span>`);
  if (o.lastOutcome === 'stopped') chips.push(`<span class="chip badge-stopped">stopped</span>`);
  if (o.costUsd > 0) chips.push(`<span class="chip cost">$${o.costUsd.toFixed(2)}</span>`);

  let statusRow = '';
  if (isOrchestrationLive(o)) {
    statusRow = `
        <div class="card-status">
          <span class="spinner"></span>
          <span class="live-label orch-live-label">orchestrating</span>
          <span class="elapsed" data-start="${esc(o.startedAt)}">${elapsedSince(o.startedAt)}</span>
          <button class="btn icon danger card-stop" data-action="stop" title="Stop orchestration" aria-label="Stop orchestration">${icon('square')}</button>
        </div>`;
  }

  // The orchestrator's latest word — what it's waiting on, its question, or its
  // closing summary — is the single most useful line on the card.
  const note = o.note
    ? `<div class="orch-note${o.status === 'awaiting' ? ' orch-note-awaiting' : ''}">${o.status === 'awaiting' ? icon('circle-help') : ''}${esc(String(o.note).slice(0, 200))}</div>`
    : '';

  el.innerHTML = `
      <div class="card-title">${esc(o.title)}</div>
      <div class="card-chips">${chips.join('')}</div>
      ${statusRow}
      ${note}
      ${orchestrationTaskLinksHtml(o)}
      ${o.status === 'failed' && o.lastError ? `<div class="card-error">${esc(o.lastError.slice(0, 140))}</div>` : ''}`;

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="stop"]')) { stopOrchestration(o.id); return; }
    const link = e.target.closest('[data-task-link]');
    if (link && !link.disabled) { openDrawer(link.dataset.taskLink); return; }
    openOrchestrationDrawer(o.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(orchestrationCoreActions(o), e.clientX, e.clientY);
  });
  return el;
}

async function stopOrchestration(id) {
  try { await api('POST', `/api/orchestrations/${id}/stop`); } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // Tick elapsed timers without re-rendering the whole board.
  setInterval(() => {
    document.querySelectorAll('.elapsed[data-start]').forEach((el) => {
      el.textContent = elapsedSince(el.dataset.start);
    });
  }, 1000);
}


export { GRADE_MEANINGS, GROOMING_TARGET_LABEL, orchestrationTaskLinksHtml, renderCard, renderGroomingCard, renderOrchestrationCard };
