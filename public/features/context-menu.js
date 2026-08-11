/* Sr. Popo — context-menu. No build step: native ES module. */
import { agentBadge, api, esc, fmtTokens, hasPermissionBridge, mdInline, mdToHtml, modelClass, toast, tokensOnly, totalTokens } from '../core/api.js';
import { $, icon, isGroomingLive, isLive, isOrchestrationLive, state } from '../core/state.js';
import { GRADE_MEANINGS, GROOMING_TARGET_LABEL, orchestrationTaskLinksHtml } from './cards.js';
import { openDrawer } from './drawer.js';
import { groomingCoreActions, orchestrationCoreActions, taskContextMenuActions, taskCoreActions } from './permissions.js';
import { prChipHtml, refreshPr, repoBranchChipHtml } from './pr.js';


// ---------- card context menu ----------
function closeContextMenu() {
  $('#context-menu').classList.add('hidden');
}

function openContextMenu(t, x, y) {
  showContextMenu(taskContextMenuActions(t), x, y);
}

function openGroomingContextMenu(g, x, y) {
  showContextMenu(groomingCoreActions(g), x, y);
}

function showContextMenu(actions, x, y) {
  const menu = $('#context-menu');
  menu.innerHTML = actions.map((a) =>
    `<button class="context-menu-item${a.cls && a.cls.includes('danger') ? ' danger' : ''}" data-act="${a.id}"${a.title ? ` title="${esc(a.title)}"` : ''}>${a.icon ? icon(a.icon) : ''}<span>${esc(a.label)}</span></button>`
  ).join('');
  menu.classList.remove('hidden');
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 6;
  const maxY = window.innerHeight - rect.height - 6;
  menu.style.left = `${Math.max(6, Math.min(x, maxX))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, maxY))}px`;
  menu.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const action = actions.find((a) => a.id === act);
    closeContextMenu();
    if (!action) return;
    try { await action.run(); } catch (err) { toast(err.message); }
  };
}

// The Code Review verdict block under the drawer's meta row: the grade with its
// meaning, the reviewer's summary, any blockers, and a link to the review comment
// it posted on the PR. Hidden for a task that has never been graded (and for the
// grooming/orchestration drawers, which call this with nothing).
function renderCodeReview(cr) {
  const box = $('#drawer-review');
  if (!box) return;
  if (!cr) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const g = Math.min(5, Math.max(1, Math.round(Number(cr.grade) || 0)));
  const blockers = (cr.blockers || []).length
    ? `<ul class="drawer-review-blockers md">${cr.blockers.map((b) => `<li>${mdInline(b)}</li>`).join('')}</ul>`
    : '';
  const link = cr.commentUrl
    ? `<a class="chip" href="${esc(cr.commentUrl)}" target="_blank" rel="noopener">${icon('git-pull-request')} review comment</a>`
    : '';
  box.classList.remove('hidden');
  box.innerHTML = `
      <div class="drawer-review-head">
        <span class="tag">CODE REVIEW</span>
        <span class="chip grade g${g}" title="Code review grade ${g}/5">${g}/5 — ${esc(GRADE_MEANINGS[g])}</span>
        ${link}
      </div>
      ${cr.summary ? `<div class="drawer-review-summary md">${mdToHtml(cr.summary)}</div>` : ''}
      ${blockers}`;
}

function renderDrawerHead(t) {
  $('#drawer-title').textContent = t.title;
  const badge = agentBadge(t);
  const meta = [
    `<span class="chip repo">${esc(t.repoName)}</span>`,
  ];
  if (badge) meta.push(`<span class="chip agent-chip" title="${badge.title}">${icon(badge.icon)} ${badge.label}</span>`);
  meta.push(`<span class="chip model${modelClass(t.resolvedModel || t.model)}">${esc(t.resolvedModel || t.model)}</span>`);
  meta.push(`<span class="chip">${esc(t.permissionMode)}</span>`);
  // Only Claude asks before an unapproved tool, so the "asks" chip is Claude-only.
  if (t.promptPermissions && hasPermissionBridge(t)) meta.push(`<span class="chip" title="Asks you to approve otherwise-denied tools">${icon('shield')} asks</span>`);
  if (t.autoCodeReview) meta.push(`<span class="chip addon-chip" title="A fresh reviewer grades this branch in Code Review when the run finishes (needs an open PR)">${icon('search')} grades on finish</span>`);
  if (t.linearIssue && t.linearIssue.identifier) {
    meta.push(`<a class="chip linear-chip" href="${esc(t.linearIssue.url)}" target="_blank" rel="noopener" title="Open in Linear">${icon('linear')} ${esc(t.linearIssue.identifier)}</a>`);
  }
  if (t.specOrigin && t.specOrigin.path) {
    meta.push(`<span class="chip spec-chip" title="${esc(t.specOrigin.path)}">${icon('folder')} ${esc(t.specOrigin.path.split('/').pop())}</span>`);
  }
  if (t.worktreePath) {
    meta.push(`<span class="chip worktree" title="${esc(t.worktreePath)}">${icon('git-branch')} ${esc(t.branch)}</span>`);
  } else if (t.useWorktree && t.branchName) {
    meta.push(`<span class="chip worktree" title="Branch is created on dispatch">${icon('git-branch')} ${esc(t.branchName)} (planned)</span>`);
  } else if (!t.useWorktree) {
    meta.push(repoBranchChipHtml(t));
  }
  if (t.sessionId) meta.push(`<span class="chip" title="session id">${esc(t.sessionId.slice(0, 8))}…</span>`);
  if (tokensOnly(t)) {
    // This backend reported tokens but no dollar cost — show "—" for cost (never
    // a misleading $0) plus the token total the ledger recorded.
    const tok = totalTokens(t);
    meta.push(`<span class="chip cost" title="This run reported tokens, not a dollar cost">— cost</span>`);
    if (tok > 0) meta.push(`<span class="chip" title="input + output tokens across all runs">${fmtTokens(tok)} tok</span>`);
  } else if (t.costUsd > 0) {
    meta.push(`<span class="chip cost">$${t.costUsd.toFixed(2)} total</span>`);
  }
  if (t.numTurns != null) meta.push(`<span class="chip">${t.numTurns} turns</span>`);
  if (t.branch) meta.push(prChipHtml(t)); // GitHub PR for this branch, if any
  const metaEl = $('#drawer-meta');
  metaEl.innerHTML = meta.join('');
  // A branch's PR status can be re-checked on demand from the refresh affordance.
  metaEl.onclick = (e) => {
    if (e.target.closest('[data-act="refresh-pr"]')) { e.preventDefault(); refreshPr(t.id, true); }
  };

  renderCodeReview(t.codeReview);

  // The prompt block — always visible, even for a task that never ran. Tasks
  // spawned by a grooming show the original idea and the resulting prompt.
  const promptEl = $('#drawer-prompt');
  promptEl.onclick = null; // drop any grooming task-link handler left behind
  const blocks = [];
  if (t.brief) {
    blocks.push(`<div class="tag">IDEA</div><div class="drawer-prompt-body md">${mdToHtml(t.brief)}</div>`);
    if (t.prompt && t.prompt !== t.brief) {
      blocks.push(`<div class="tag">GROOMED PROMPT</div><div class="drawer-prompt-body md">${mdToHtml(t.prompt)}</div>`);
    }
  } else if (t.prompt) {
    blocks.push(`<div class="tag">ORIGINAL PROMPT</div><div class="drawer-prompt-body md">${mdToHtml(t.prompt)}</div>`);
  }
  if (blocks.length) {
    promptEl.classList.remove('hidden');
    promptEl.innerHTML = blocks.join('');
  } else {
    promptEl.classList.add('hidden');
    promptEl.innerHTML = '';
  }

  const actions = taskCoreActions(t);
  const box = $('#drawer-actions');
  box.innerHTML = actions.map((a) =>
    `<button class="btn ${a.cls}" data-act="${a.id}"${a.title ? ` title="${esc(a.title)}"` : ''}>${a.icon ? icon(a.icon) + ' ' : ''}${esc(a.label)}</button>`
  ).join('');
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const action = actions.find((a) => a.id === act);
    if (!action) return;
    try { await action.run(); } catch (err) { toast(err.message); }
  };

  const canFollowup = !isLive(t) && !!t.sessionId;
  $('#followup-input').disabled = !canFollowup;
  $('#followup-send').disabled = !canFollowup;
  $('#followup-input').placeholder = isLive(t)
    ? 'Task is running…'
    : t.sessionId ? 'Send a follow-up to this session…' : 'Run the task first to start a session';
}

// Drawer head for a grooming card: status + idea, actions from
// groomingCoreActions, and (once finished) links to the spawned tasks. The
// follow-up composer stays disabled — grooming sessions are never resumed.
// The questions form shown in an awaiting grooming's drawer: each clarifying
// question with its suggested options (radios) and, when free text is allowed,
// an "other" text field — mirroring Claude Desktop's ask-with-choices prompt.
function groomQuestionsHtml(g) {
  const rows = (g.questions || []).map((q, i) => {
    const opts = (q.options || []).map((opt, j) => `
        <label class="groom-opt">
          <input type="radio" name="gq-${i}" value="${esc(opt)}"${j === 0 && !q.allowText ? ' checked' : ''}>
          <span>${mdInline(opt)}</span>
        </label>`).join('');
    // A free-text field: an "Other" radio next to options, or a standalone
    // input when the question is open-ended (no options).
    const text = q.allowText
      ? (q.options || []).length
        ? `<label class="groom-opt groom-opt-other">
               <input type="radio" name="gq-${i}" value="__other__">
               <span>Other:</span>
             </label>
             <input type="text" class="groom-q-textinput" placeholder="Type your own answer…">`
        : `<input type="text" class="groom-q-textinput" placeholder="Type your answer…">`
      : '';
    return `
        <div class="groom-q md" data-qi="${i}">
          <div class="groom-q-text">${i + 1}. ${mdInline(q.question)}</div>
          <div class="groom-q-options">${opts}${text}</div>
        </div>`;
  }).join('');
  const n = (g.questions || []).length;
  return `
      <div class="tag">CLARIFY</div>
      <p class="groom-clarify-hint">Grooming is paused on ${n === 1 ? 'this question' : `these ${n} questions`} — answer below to continue.</p>
      <form class="groom-questions" id="groom-answers-form">
        ${rows}
        <button type="submit" class="btn primary groom-answers-send">${icon('sparkles')} Answer &amp; continue</button>
      </form>`;
}

// Collect one answer string per question from the form and resume the session.
async function submitGroomingAnswers(g) {
  const form = $('#groom-answers-form');
  if (!form) return;
  const answers = (g.questions || []).map((_, i) => {
    const box = form.querySelector(`.groom-q[data-qi="${i}"]`);
    const checked = box ? box.querySelector('input[type=radio]:checked') : null;
    const textEl = box ? box.querySelector('.groom-q-textinput') : null;
    const textVal = textEl ? textEl.value.trim() : '';
    if (checked && checked.value !== '__other__') return checked.value;
    return textVal;
  });
  const btn = form.querySelector('.groom-answers-send');
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/groomings/${g.id}/answers`, { answers });
    toast('Resuming grooming with your answers…', 'info');
  } catch (e) {
    toast(e.message);
    if (btn) btn.disabled = false;
  }
}

function renderGroomingDrawerHead(g) {
  $('#drawer-title').textContent = g.title;
  const statusLabel = { draft: 'draft', running: 'grooming…', awaiting: 'needs input', finished: 'groomed', failed: 'failed' }[g.status] || g.status;
  const meta = [
    `<span class="chip repo">${esc(g.repoName)}</span>`,
    `<span class="chip model">${esc(g.resolvedModel || g.model)}</span>`,
    `<span class="chip groom-status groom-status-${esc(g.status)}">${esc(statusLabel)}</span>`,
    `<span class="chip" title="Where spawned tasks land">${esc(GROOMING_TARGET_LABEL[g.target] || 'to backlog')}</span>`,
  ];
  if (g.linearIssue && g.linearIssue.identifier) {
    meta.push(`<a class="chip linear-chip" href="${esc(g.linearIssue.url)}" target="_blank" rel="noopener" title="Open in Linear">${icon('linear')} ${esc(g.linearIssue.identifier)}</a>`);
  }
  if (g.costUsd > 0) meta.push(`<span class="chip cost">$${g.costUsd.toFixed(2)} total</span>`);
  if (g.numTurns != null) meta.push(`<span class="chip">${g.numTurns} turns</span>`);
  $('#drawer-meta').innerHTML = meta.join('');
  $('#drawer-meta').onclick = null;
  renderCodeReview(null); // task-only block; a card has no code-review verdict

  const promptEl = $('#drawer-prompt');
  const isClarify = g.status === 'awaiting' && (g.questions || []).length > 0;
  const blocks = [`<div class="tag">IDEA</div><div class="drawer-prompt-body md">${mdToHtml(g.idea)}</div>`];
  if (isClarify) {
    blocks.push(groomQuestionsHtml(g));
  }
  if (g.status === 'finished' && (g.taskIds || []).length) {
    const links = g.taskIds.map((id) => {
      const t = state.tasks.get(id);
      return `<button type="button" class="groom-task-link" data-task-link="${esc(id)}" ${t ? '' : 'disabled'}>
            ${icon('chevron-right')} <span class="groom-task-title">${esc(t ? t.title : 'task (removed)')}</span>${t ? `<span class="chip">${esc(t.status)}</span>` : ''}
          </button>`;
    }).join('');
    blocks.push(`<div class="tag">GROOMED TASKS</div><div class="groom-tasks">${links}</div>`);
  }
  promptEl.classList.remove('hidden');
  promptEl.classList.toggle('is-clarify', isClarify);
  promptEl.innerHTML = blocks.join('');
  promptEl.onclick = (e) => {
    const link = e.target.closest('[data-task-link]');
    if (link && !link.disabled) openDrawer(link.dataset.taskLink);
  };
  const answersForm = promptEl.querySelector('#groom-answers-form');
  if (answersForm) {
    answersForm.onsubmit = (e) => { e.preventDefault(); submitGroomingAnswers(g); };
  }
  // Scroll the panel so the questions are in view and move focus to the
  // first control — but only when the user isn't already mid-answer, since
  // this same render also re-runs on unrelated live-update broadcasts and
  // must not yank focus out from under someone typing.
  if (isClarify && !promptEl.contains(document.activeElement)) {
    promptEl.scrollTop = 0;
    const firstField = promptEl.querySelector('.groom-questions input');
    if (firstField) firstField.focus({ preventScroll: true });
  }

  const actions = groomingCoreActions(g);
  const box = $('#drawer-actions');
  box.innerHTML = actions.map((a) =>
    `<button class="btn ${a.cls}" data-act="${a.id}">${a.icon ? icon(a.icon) + ' ' : ''}${esc(a.label)}</button>`
  ).join('');
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const action = actions.find((a) => a.id === act);
    if (!action) return;
    try { await action.run(); } catch (err) { toast(err.message); }
  };

  $('#followup-input').disabled = true;
  $('#followup-send').disabled = true;
  $('#followup-input').placeholder = isGroomingLive(g)
    ? 'Grooming the idea…'
    : g.status === 'awaiting'
      ? 'Answer the questions above to continue grooming'
      : 'Grooming sessions run once and are never resumed';
}

// Send the developer's free-text answer to a paused (awaiting) orchestration
// and resume its session.
async function submitOrchestrationReply(o) {
  const form = $('#orchestrate-reply-form');
  if (!form) return;
  const input = form.querySelector('.orch-reply-input');
  const reply = input ? input.value.trim() : '';
  if (!reply) { toast('Type an answer first'); return; }
  const btn = form.querySelector('.orch-reply-send');
  if (btn) btn.disabled = true;
  try {
    await api('POST', `/api/orchestrations/${o.id}/reply`, { reply });
    toast('Resuming the orchestrator with your answer…', 'info');
  } catch (e) {
    toast(e.message);
    if (btn) btn.disabled = false;
  }
}

// The reply form shown in an awaiting orchestration's drawer: the question it
// asked plus one textarea. Deliberately simpler than grooming's structured
// options — an orchestrator's questions are open-ended by nature.
function orchestrationReplyHtml(o) {
  return `
      <div class="tag">NEEDS INPUT</div>
      <p class="groom-clarify-hint">The orchestrator is paused on this question — answer below to continue.</p>
      <div class="orch-question md">${mdToHtml(o.note || 'It asked for input but recorded no question.')}</div>
      <form class="orch-reply" id="orchestrate-reply-form">
        <textarea class="orch-reply-input groom-q-textinput" rows="3" placeholder="Type your answer…"></textarea>
        <button type="submit" class="btn primary orch-reply-send">${icon('crown')} Answer &amp; continue</button>
      </form>`;
}

const ORCH_STATUS_LABEL = {
  draft: 'draft',
  running: 'orchestrating…',
  waiting: 'watching workers',
  awaiting: 'needs input',
  finished: 'done',
  failed: 'failed',
};

function renderOrchestrationDrawerHead(o) {
  $('#drawer-title').textContent = o.title;
  const meta = [
    `<span class="chip repo">${esc(o.repoName)}</span>`,
    `<span class="chip model">${esc(o.resolvedModel || o.model)}</span>`,
    `<span class="chip orch-status orch-status-${esc(o.status)}">${esc(ORCH_STATUS_LABEL[o.status] || o.status)}</span>`,
  ];
  if (o.mode === 'autonomous') {
    meta.push(`<span class="chip orch-mode" title="Worker tasks are dispatched and merged by Autonomous Mode">${icon('bot')} autonomous</span>`);
  }
  if (o.sessionId) meta.push(`<span class="chip" title="session id">${esc(o.sessionId.slice(0, 8))}…</span>`);
  if (o.costUsd > 0) meta.push(`<span class="chip cost">$${o.costUsd.toFixed(2)} total</span>`);
  if (o.turnCount) meta.push(`<span class="chip" title="Orchestrator turns so far">${o.turnCount} turn${o.turnCount === 1 ? '' : 's'}</span>`);
  $('#drawer-meta').innerHTML = meta.join('');
  $('#drawer-meta').onclick = null;
  renderCodeReview(null); // task-only block; a card has no code-review verdict

  const promptEl = $('#drawer-prompt');
  const isAwaiting = o.status === 'awaiting';
  const blocks = [`<div class="tag">GOAL</div><div class="drawer-prompt-body md">${mdToHtml(o.goal)}</div>`];
  if (isAwaiting) blocks.push(orchestrationReplyHtml(o));
  else if (o.note) {
    const tag = o.status === 'finished' ? 'SUMMARY' : 'LATEST';
    blocks.push(`<div class="tag">${tag}</div><div class="drawer-prompt-body md">${mdToHtml(o.note)}</div>`);
  }
  if ((o.taskIds || []).length) {
    blocks.push(`<div class="tag">WORKER TASKS</div>${orchestrationTaskLinksHtml(o)}`);
  }
  promptEl.classList.remove('hidden');
  promptEl.classList.toggle('is-clarify', isAwaiting);
  promptEl.innerHTML = blocks.join('');
  promptEl.onclick = (e) => {
    const link = e.target.closest('[data-task-link]');
    if (link && !link.disabled) openDrawer(link.dataset.taskLink);
  };
  const replyForm = promptEl.querySelector('#orchestrate-reply-form');
  if (replyForm) {
    replyForm.onsubmit = (e) => { e.preventDefault(); submitOrchestrationReply(o); };
    // Same rule as the grooming clarify form: focus the answer box, but never
    // yank focus away from someone already typing on an unrelated re-render.
    if (!promptEl.contains(document.activeElement)) {
      promptEl.scrollTop = 0;
      const field = promptEl.querySelector('.orch-reply-input');
      if (field) field.focus({ preventScroll: true });
    }
  }

  const actions = orchestrationCoreActions(o);
  const box = $('#drawer-actions');
  box.innerHTML = actions.map((a) =>
    `<button class="btn ${a.cls}" data-act="${a.id}">${a.icon ? icon(a.icon) + ' ' : ''}${esc(a.label)}</button>`
  ).join('');
  box.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const action = actions.find((a) => a.id === act);
    if (!action) return;
    try { await action.run(); } catch (err) { toast(err.message); }
  };

  // The orchestrator's session is driven by the engine, never by a free-text
  // follow-up — the only way in is the reply box above.
  $('#followup-input').disabled = true;
  $('#followup-send').disabled = true;
  $('#followup-input').placeholder = isOrchestrationLive(o)
    ? 'Orchestrating the goal…'
    : o.status === 'waiting'
      ? 'Waiting on its worker tasks — it resumes itself when they land'
      : isAwaiting
        ? 'Answer the question above to continue'
        : 'Orchestrator sessions are resumed by Sr. Popo, not by hand';
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  // Click anywhere outside the menu, or right-click elsewhere, closes it — only
  // one context menu is ever open at a time.
  document.addEventListener('click', (e) => {
    if (!$('#context-menu').classList.contains('hidden') && !e.target.closest('#context-menu')) closeContextMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.card')) closeContextMenu();
  });
}


export { closeContextMenu, openContextMenu, openGroomingContextMenu, renderDrawerHead, renderGroomingDrawerHead, renderOrchestrationDrawerHead, showContextMenu };
