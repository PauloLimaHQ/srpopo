/* Sr. Popo — dnd. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, COLUMN_OF_STATUS, icon, isLive, state } from '../core/state.js';
import { openFollowupModal } from './followup.js';


async function onDrop(taskId, colKey) {
  const t = state.tasks.get(taskId);
  if (!t || COLUMN_OF_STATUS[t.status] === colKey) return;
  try {
    if (colKey === 'running') {
      if (t.status === 'backlog' || t.status === 'ready') {
        await api('POST', `/api/tasks/${t.id}/dispatch`);
      } else if (t.sessionId) {
        openFollowupModal(t); // finished tasks continue their session
      }
    } else if (colKey === 'code_review') {
      // Runner-owned status: a fresh read-only reviewer session grades the
      // branch and comments on its PR (rejected without an open one).
      if (!isLive(t)) await api('POST', `/api/tasks/${t.id}/code-review`);
    } else if (colKey === 'done' && !isLive(t)) {
      await moveToDone(t);
    } else if (!isLive(t)) {
      await api('PATCH', `/api/tasks/${t.id}`, { status: colKey });
    }
  } catch (e) { toast(e.message); }
}

// Moving a task to Done can carry two optional wrap-up steps: merge its open PR
// and/or delete its worktree. We surface whichever actually apply as checkboxes
// (see openDoneModal). If neither applies the move happens straight away — no
// dialog for the common case.
async function moveToDone(t) {
  const options = [];
  if (t.worktreePath) {
    options.push({
      id: 'delete-worktree',
      label: 'Delete the worktree',
      hint: t.worktreePath,
    });
  }
  // An unmerged PR is only meaningful for a task that has a resolved branch.
  // Always look it up fresh here — the background sweep (server/pr-refresh.ts)
  // and the cached value from a drawer visit can both be up to a minute stale,
  // and this is the one moment a stale "still open" would cause a needless
  // re-merge attempt — so the prompt reflects the PR's real state right now.
  let hasOpenPr = false;
  let hasMergedPr = false;
  // Whether the PR lookup itself could confirm one way or the other. A
  // transient `gh` failure (not authed, network blip, gh missing) must NOT
  // be treated the same as "confirmed no PR" — that silently offered a
  // bypass-review direct merge for a task that in fact had an open/merged
  // PR, just because this one lookup happened to fail.
  let lookupFailed = false;
  if (t.branch) {
    let res;
    try {
      res = await api('GET', `/api/tasks/${t.id}/pr`);
      state.prByTask.set(t.id, res);
    } catch { res = null; }
    if (res && res.pr) {
      if (res.pr.state === 'merged') {
        hasMergedPr = true;
      } else {
        hasOpenPr = res.pr.state === 'open';
        options.push({
          id: 'merge-pr',
          label: `Merge PR #${res.pr.number}`,
          hint: res.pr.title || '',
          group: 'merge',
        });
      }
    } else if (!res || res.reason !== 'no-pr') {
      lookupFailed = true;
    }
  }
  // Direct, PR-less merge — the fallback when no *open or merged* PR was
  // identified for the task: while a PR is open, landing the branch is the
  // PR's job (merge it or close it there), and a merged PR has already
  // landed the branch, so offering a local merge alongside either would
  // just invite bypassing review or re-merging what's already in. A closed
  // (abandoned) PR doesn't suppress it — a local merge is then the only way
  // left to land the branch. Offered only while there's still a worktree to
  // wrap up, so a task that already finished its merge/branch story
  // elsewhere doesn't gain a new confirmation dialog it never had before.
  // Only shown once we actually know the target branch — a guessed default
  // would promise a merge that never happens. Warned since it bypasses code
  // review and CI.
  if (!hasOpenPr && !hasMergedPr && !lookupFailed && t.worktreePath && t.branch) {
    let base = t.baseBranch || state.repoBranchByRepo.get(t.repoId);
    if (base === undefined || base === 'loading') {
      try {
        ({ branch: base } = await api('GET', `/api/repos/${t.repoId}/branch`));
        state.repoBranchByRepo.set(t.repoId, base);
      } catch { base = null; }
    }
    if (base) {
      options.push({
        id: 'merge-direct',
        label: `Merge branch into ${base} (no PR)`,
        hint: 'Skips code review and CI — merges locally right now',
        warn: true,
        group: 'merge',
      });
    }
  }
  if (!options.length) {
    await api('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
    return;
  }
  openDoneModal(t, options);
}

// Renders the applicable wrap-up steps as unchecked checkboxes. Cancel leaves
// the task where it is; confirming with nothing checked just moves it; any
// checked step runs (merge before worktree removal, so `gh` still has the
// worktree to run in) before the move.
//
// `completed` remembers which steps already succeeded, so retrying after a
// failed step resumes from that step instead of merging (or removing the
// worktree) a second time.
let doneModalCtx = null;
function openDoneModal(t, options) {
  doneModalCtx = { task: t, options, completed: new Set() };
  $('#done-modal-progress').classList.add('hidden');
  $('#done-modal-progress').innerHTML = '';
  $('#done-modal-options').classList.remove('hidden');
  $('#done-modal-confirm').textContent = 'Move to Done';
  $('#done-modal-cancel').disabled = false;
  $('#done-modal-sub').textContent =
    `“${t.title}” — choose any wrap-up steps to run, then it moves to Done.`;
  $('#done-modal-options').innerHTML = options.map((o) =>
    `<label class="done-option${o.warn ? ' done-option-warn' : ''}">` +
    `<input type="checkbox" data-done-opt="${esc(o.id)}"${o.group ? ` data-done-group="${esc(o.group)}"` : ''} />` +
    `<span class="done-option-text"><span class="done-option-label">${o.warn ? icon('triangle-alert') : ''}${esc(o.label)}</span>` +
    (o.hint ? `<span class="done-option-hint">${esc(o.hint)}</span>` : '') +
    `</span></label>`,
  ).join('');
  $('#done-modal-confirm').disabled = false;
  $('#modal-done').classList.remove('hidden');
}

// Renders the wrap-up steps (plus the final move itself) as a progress list,
// one row per step, so a slow merge/worktree-removal reads as "working on it"
// instead of a frozen dialog. `renderDoneProgress` re-renders the whole list on
// every state change; call it again after mutating a step's `state`.
// A failed step keeps its row (marked, with the error under it) so the list
// stays a truthful record of what did and didn't happen.
function renderDoneProgress(steps) {
  $('#done-modal-options').classList.add('hidden');
  const progress = $('#done-modal-progress');
  progress.classList.remove('hidden');
  progress.innerHTML = steps.map((s) => {
    const cls = s.state === 'active' ? 'active' : s.state === 'done' ? 'done' : s.state === 'error' ? 'error' : '';
    const glyph = s.state === 'done' ? icon('check')
      : s.state === 'error' ? icon('triangle-alert')
      : s.state === 'active' ? '<span class="spinner"></span>' : '';
    const detail = s.state === 'error' && s.error
      ? `<span class="done-progress-error">${esc(s.error)}</span>` : '';
    return `<div class="done-progress-step ${cls}"><span class="icon-slot">${glyph}</span>` +
      `<span class="done-progress-text"><span>${esc(s.label)}</span>${detail}</span></div>`;
  }).join('');
}

async function stopTask(id) {
  try { await api('POST', `/api/tasks/${id}/stop`); } catch (e) { toast(e.message); }
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // merge-pr and merge-direct share a 'group' — they're alternative ways to
  // land the same branch, so checking one clears the other rather than
  // letting both run (which would merge the branch in twice). They still
  // co-appear for a closed-but-unmerged PR; while a PR is open moveToDone
  // suppresses merge-direct entirely.
  $('#done-modal-options').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.matches('input[data-done-group]') || !el.checked) return;
    document.querySelectorAll(`#done-modal-options input[data-done-group="${el.dataset.doneGroup}"]`)
      .forEach((other) => { if (other !== el) other.checked = false; });
  });

  $('#done-modal-cancel').addEventListener('click', () => {
    $('#modal-done').classList.add('hidden');
    doneModalCtx = null;
  });

  $('#done-modal-confirm').addEventListener('click', async () => {
    if (!doneModalCtx) return;
    const { task, completed } = doneModalCtx;
    // Read the boxes only on the first pass: after a failure the progress list
    // (not the checkboxes) is what's on screen, and `steps` already holds the
    // plan the user confirmed.
    if (!doneModalCtx.steps) {
      const checked = new Set(
        [...document.querySelectorAll('#done-modal-options input[data-done-opt]:checked')]
          .map((el) => el.dataset.doneOpt),
      );
      // Merge first: worktree removal below would take away the dir `gh` runs in.
      const steps = [];
      if (checked.has('merge-pr')) {
        steps.push({ id: 'merge-pr', label: 'Merging your pull request…', state: 'pending' });
      }
      if (checked.has('merge-direct')) {
        steps.push({ id: 'merge-direct', label: 'Merging your branch…', state: 'pending' });
      }
      if (checked.has('delete-worktree')) {
        steps.push({ id: 'delete-worktree', label: 'Deleting your worktree…', state: 'pending' });
      }
      steps.push({ id: 'move', label: 'Moving task to Done…', state: 'pending' });
      doneModalCtx.steps = steps;
    }
    const steps = doneModalCtx.steps;
    const btn = $('#done-modal-confirm');
    btn.disabled = true;
    $('#done-modal-cancel').disabled = true;
    renderDoneProgress(steps);

    // A step that already succeeded is never run again — retrying a failed
    // merge must not merge the branch (or drop the worktree) a second time.
    // Returns whether it actually ran, so the toasts don't repeat either.
    async function runStep(id, fn) {
      const step = steps.find((s) => s.id === id);
      if (!step || completed.has(id)) return false;
      step.state = 'active';
      step.error = null;
      renderDoneProgress(steps);
      try {
        await fn();
      } catch (e) {
        step.state = 'error';
        step.error = e.message;
        renderDoneProgress(steps);
        throw e;
      }
      completed.add(id);
      step.state = 'done';
      renderDoneProgress(steps);
      return true;
    }

    try {
      const mergedPr = await runStep('merge-pr', async () => {
        await api('POST', `/api/tasks/${task.id}/pr/merge`);
        state.prByTask.delete(task.id); // force a fresh PR status next render
      });
      if (mergedPr) toast('Pull request merged', 'info');

      const mergedDirect = await runStep('merge-direct', async () => {
        await api('POST', `/api/tasks/${task.id}/merge`);
      });
      if (mergedDirect) toast('Branch merged directly (no PR)', 'info');

      let leftover = false;
      const removed = await runStep('delete-worktree', async () => {
        ({ leftover } = await api('POST', `/api/tasks/${task.id}/worktree/remove`));
      });
      // git drops the worktree even when a build cache (or anything else
      // writing into it) stops it from deleting every file — say so instead of
      // claiming a clean removal.
      if (removed) toast(leftover ? 'Worktree removed — some files were left on disk' : 'Worktree removed', 'info');

      await runStep('move', async () => {
        await api('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
      });
      $('#modal-done').classList.add('hidden');
      doneModalCtx = null;
    } catch (e) {
      // The progress list stays up with the failed step marked, so it's clear
      // which steps did land; Retry picks up from there.
      toast(e.message, 'error');
      btn.textContent = 'Retry';
    } finally {
      btn.disabled = false;
      $('#done-modal-cancel').disabled = false;
    }
  });
}


export { moveToDone, onDrop, stopTask };
