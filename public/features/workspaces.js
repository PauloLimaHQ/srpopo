/* Sr. Popo — workspaces. No build step: native ES module. */
import { api, esc, toast } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, ORCH_COLUMN, icon, isGroomingLive, isLive, isOrchestrationLive, state } from '../core/state.js';
import { renderAutonomous } from './autonomous.js';
import { renderBoard } from './board.js';
import { defaultEditor } from './desktop.js';
import { groomingsForRepo, orchestrationsForRepo, tasksForRepo } from './filters.js';
import { openReposModal, renderRepoList } from './repos-modal.js';
import { renderRunButton } from './scripts.js';
import { renderSidebar, sidebarExpanded } from './sidebar.js';
import { applyPanes, noteRepoTab, noteSuperTab, renderTabStrip } from './tabs.js';
import { closeWorkspaceMenu } from './workspace-menu.js';


// ---------- workspaces / super view ----------
const VIEW_KEY = 'srpopo.view';
function saveView() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.view)); } catch { /* storage unavailable — non-fatal */ }
}
// Falls back to the Super View if nothing was saved, or the saved repo no
// longer exists (e.g. it was removed since the last visit).
function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY));
    if (v && v.mode === 'workspace' && state.repos.some((r) => r.id === v.repoId)) {
      return { mode: 'workspace', repoId: v.repoId };
    }
  } catch { /* ignore malformed storage */ }
  return { mode: 'super' };
}

function setView(view) {
  state.view = view;
  saveView();
  renderView();
}
// Entering a workspace unfolds it in the project sidebar (if that layout is
// on), so the board you switched to and the rail agree on what's in focus, and
// opens/raises its tab in the work-area strip (a no-op in the classic layout).
// Every surface that switches workspace goes through here — the sidebar, ⌘K,
// the header's switcher, a Super View card, a tab — which is what keeps the
// rail, the strip and the board from ever disagreeing.
const enterWorkspace = (repoId) => {
  sidebarExpanded.add(repoId);
  noteRepoTab(repoId);
  setView({ mode: 'workspace', repoId });
};
const exitWorkspace = () => { noteSuperTab(); setView({ mode: 'super' }); };
// The workspace open when a New Task / Brief / Linear modal is launched, so
// those flows default their repo <select> to it instead of the last-used repo.
const currentWorkspaceRepoId = () => (state.view.mode === 'workspace' ? state.view.repoId : null);

// Toggles the Super View / workspace board / terminal and re-renders whichever
// is now visible. applyPanes() owns the show/hide: in the classic layout it is
// the Super-View-or-board swap this always did, and in the sidebar layout the
// active tab can also be a shell session.
function renderView() {
  const isSuper = state.view.mode === 'super';
  // The actions menu is anchored to the header, but lives outside it — close it
  // so it can't outlive the workspace it acts on.
  closeWorkspaceMenu();
  renderSidebar();
  renderTabStrip();
  applyPanes();
  // The board behind a session tab is rendered anyway: it costs one pass over
  // state we already have, and it means tabbing back to it shows the current
  // board instead of an empty flash.
  if (isSuper) renderSuperView();
  else { renderWorkspaceHeader(); renderBoard(); }
  renderAutonomous();
}

// GitHub serves an org/user's avatar at this fixed, unauthenticated URL — no API
// call needed. Only for github.com remotes; other hosts (GitLab, Bitbucket, a
// bare local remote) have no equivalent we can derive for free, so no icon.
function githubAvatarUrl(remoteUrl) {
  if (!remoteUrl) return null;
  try {
    const u = new URL(remoteUrl);
    if (u.hostname !== 'github.com') return null;
    const org = u.pathname.split('/').filter(Boolean)[0];
    return org ? `https://github.com/${org}.png?size=64` : null;
  } catch { return null; }
}

// Live lookup of a repo's current branch, cached like refreshRepoBranchForTask
// — used by both the Super View cards and the workspace header chip.
async function refreshRepoBranchCard(repoId, force) {
  if (!force && state.repoBranchByRepo.has(repoId)) return;
  state.repoBranchByRepo.set(repoId, 'loading');
  let branch = null, remoteUrl = null, ahead = null, behind = null;
  try { ({ branch, remoteUrl, ahead, behind } = await api('GET', `/api/repos/${repoId}/branch`)); } catch { /* stay null */ }
  state.repoBranchByRepo.set(repoId, branch);
  state.repoRemoteUrlByRepo.set(repoId, remoteUrl);
  state.repoAheadBehindByRepo.set(repoId, { ahead, behind });
  if (state.view.mode === 'super') renderSuperView();
  else if (state.view.mode === 'workspace' && state.view.repoId === repoId) renderWorkspaceHeader();
  // The sidebar shows the repo's GitHub avatar, which this lookup resolves.
  renderSidebar();
}

// A branch's ahead/behind vs its upstream, as an icon badge — arrow-up for
// unpushed commits, arrow-down for commits the upstream has that this branch
// doesn't. Empty when there's no upstream to compare against, or the branch
// is fully in sync (nothing useful to flag).
function aheadBehindHtml(ahead, behind) {
  const parts = [];
  if (ahead) parts.push(`<span class="ahead-behind ahead" title="${ahead} commit${ahead === 1 ? '' : 's'} ahead of upstream — not pushed yet">${icon('arrow-up')}${ahead}</span>`);
  if (behind) parts.push(`<span class="ahead-behind behind" title="${behind} commit${behind === 1 ? '' : 's'} behind upstream">${icon('arrow-down')}${behind}</span>`);
  return parts.join('');
}

// Live worktree list for a repo (ground truth from git, not stale task.worktreePath
// values) — feeds the Super View's worktree count and the workspace popover.
async function refreshRepoWorktreesCard(repoId, force) {
  if (!force && state.worktreesByRepo.has(repoId)) return;
  state.worktreesByRepo.set(repoId, 'loading');
  let worktrees = [];
  try { ({ worktrees } = await api('GET', `/api/repos/${repoId}/worktrees`)); } catch { /* stays [] */ }
  state.worktreesByRepo.set(repoId, worktrees);
  if (state.view.mode === 'super') renderSuperView();
  if (!$('#modal-workspace').classList.contains('hidden') && state.view.repoId === repoId) renderWorkspaceWorktreeList(repoId);
}

// A dependency-free "graph": a stacked bar whose segments are proportional
// (via flex-grow) to a repo's task counts per column (grooming cards lead).
function workspaceGraphHtml(tasks, groomings, orchestrations) {
  if (!tasks.length && !groomings.length && !orchestrations.length) return `<div class="workspace-graph empty"></div>`;
  const counts = new Map();
  for (const t of tasks) {
    const col = COLUMN_OF_STATUS[t.status];
    counts.set(col, (counts.get(col) || 0) + 1);
  }
  const segs = [GROOMING_COLUMN, ORCH_COLUMN, ...COLUMNS]
    .map((c) => ({
      c,
      n: c.key === 'grooming' ? groomings.length : c.key === 'orchestration' ? orchestrations.length : counts.get(c.key),
    }))
    .filter(({ n }) => n)
    .map(({ c, n }) =>
      `<span class="workspace-graph-seg" style="background:${c.dot};flex:${n} 0 0" title="${esc(c.label)}: ${n}"></span>`
    ).join('');
  return `<div class="workspace-graph">${segs}</div>`;
}

function workspaceCardHtml(r) {
  const tasks = tasksForRepo(r.id);
  const groomings = groomingsForRepo(r.id);
  const orchestrations = orchestrationsForRepo(r.id);
  const liveCount = tasks.filter(isLive).length + groomings.filter(isGroomingLive).length +
    orchestrations.filter(isOrchestrationLive).length;
  const branch = state.repoBranchByRepo.get(r.id);
  const ab = state.repoAheadBehindByRepo.get(r.id) || {};
  const wt = state.worktreesByRepo.get(r.id);
  const wtCount = Array.isArray(wt) ? wt.length : null;
  const avatarUrl = githubAvatarUrl(state.repoRemoteUrlByRepo.get(r.id));
  return `
      <div class="workspace-card" data-repo="${esc(r.id)}" title="${esc(r.path)}" draggable="true">
        <div class="workspace-card-head">
          <span class="workspace-card-title">
            <span class="drag-handle" title="Drag to reorder" aria-hidden="true">${icon('grip-vertical')}</span>
            ${avatarUrl ? `<img class="workspace-card-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">` : ''}
            <span class="workspace-card-name">${esc(r.name)}</span>
          </span>
          ${liveCount ? `<span class="chip running-badge"><span class="spinner"></span>${liveCount} live</span>` : ''}
        </div>
        ${workspaceGraphHtml(tasks, groomings, orchestrations)}
        <div class="workspace-card-foot">
          ${branch && branch !== 'loading' ? `<span class="chip">${icon('git-branch')} ${esc(branch)}${aheadBehindHtml(ab.ahead, ab.behind)}</span>` : ''}
          <span class="chip">${wtCount == null ? '…' : wtCount} worktree${wtCount === 1 ? '' : 's'}</span>
          <span class="chip">${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>
        </div>
      </div>`;
}

// Generic HTML5 drag-and-drop reordering, shared by the Workspaces grid and
// the Manage Repositories list. Wire it once on the persistent container
// element (re-renders only replace its innerHTML) — it reads live children
// via querySelector on every drag event, so it keeps working across
// re-renders without being re-attached. During dragover it moves the
// dragged element next to whichever sibling's center is nearest the
// pointer, which reads naturally whether `container` is a vertical list or
// a wrapping grid. `onReorder(ids)` fires once per drop with the full
// sequence of `data-{idAttr}` values read back off the DOM.
function makeSortable(container, itemSelector, idAttr, onReorder) {
  let dragEl = null;
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(itemSelector);
    if (!item || !container.contains(item)) return;
    dragEl = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset[idAttr] || '');
  });
  container.addEventListener('dragover', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    let closest = null, closestDist = Infinity, after = false;
    for (const el of container.querySelectorAll(itemSelector)) {
      if (el === dragEl) continue;
      const box = el.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist < closestDist) {
        closestDist = dist;
        closest = el;
        after = e.clientY === cy ? e.clientX > cx : e.clientY > cy;
      }
    }
    if (!closest) container.appendChild(dragEl);
    else closest.insertAdjacentElement(after ? 'afterend' : 'beforebegin', dragEl);
  });
  container.addEventListener('drop', (e) => {
    if (!dragEl) return;
    e.preventDefault();
    onReorder([...container.querySelectorAll(itemSelector)].map((el) => el.dataset[idAttr]));
  });
  container.addEventListener('dragend', () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
  });
}

// Persists a drag-and-drop reorder. The server broadcasts the new `repos`
// order back over SSE on success, which re-renders both the Workspaces
// grid and this list from `state.repos` — so nothing here needs to touch
// state itself. On failure, re-render to snap the DOM back to server truth.
async function reorderRepos(order) {
  const before = state.repos.map((r) => r.id);
  if (order.length === before.length && order.every((rid, i) => rid === before[i])) return;
  try {
    await api('POST', '/api/repos/reorder', { order });
  } catch (e) {
    toast(e.message || 'Could not reorder repositories');
    renderRepoList();
    renderView();
  }
}

function renderSuperView() {
  const el = $('#super-view');
  if (!state.repos.length) {
    el.innerHTML = `
        <div class="workspace-empty">
          <p>No repositories yet.</p>
          <button class="btn primary" id="super-view-add-repo">${icon('plus')} Add a repository</button>
        </div>`;
    $('#super-view-add-repo').addEventListener('click', openReposModal);
    return;
  }
  el.innerHTML = `<div class="workspace-grid">${state.repos.map(workspaceCardHtml).join('')}</div>`;
  el.querySelectorAll('.workspace-card').forEach((card) => {
    card.addEventListener('click', () => enterWorkspace(card.dataset.repo));
  });
  for (const r of state.repos) {
    refreshRepoBranchCard(r.id);
    refreshRepoWorktreesCard(r.id);
  }
}

function renderWorkspaceHeader() {
  const repo = state.repos.find((r) => r.id === state.view.repoId);
  if (!repo) return;
  $('#workspace-title').textContent = repo.name;
  refreshRepoBranchCard(repo.id);
  // The Run button follows the workspace: it reads this checkout's package.json
  // scripts (and hides itself when there are none, or the plugin is off).
  renderRunButton();
  const branch = state.repoBranchByRepo.get(repo.id);
  const remoteUrl = state.repoRemoteUrlByRepo.get(repo.id);
  const ab = state.repoAheadBehindByRepo.get(repo.id) || {};
  const avatarUrl = githubAvatarUrl(remoteUrl);
  const avatar = $('#workspace-avatar');
  avatar.classList.toggle('hidden', !avatarUrl);
  if (avatarUrl) avatar.src = avatarUrl;
  $('#workspace-branch-chip').innerHTML = branch && branch !== 'loading'
    ? (remoteUrl
      ? `<a class="chip" href="${esc(remoteUrl)}/tree/${esc(encodeURIComponent(branch))}" target="_blank" rel="noopener" title="Open this branch on GitHub">${icon('git-branch')} ${esc(branch)}</a>${aheadBehindHtml(ab.ahead, ab.behind)}`
      : `<span class="chip">${icon('git-branch')} ${esc(branch)}</span>${aheadBehindHtml(ab.ahead, ab.behind)}`)
    : '';
}

function renderWorkspaceWorktreeList(repoId) {
  const list = state.worktreesByRepo.get(repoId);
  const el = $('#workspace-worktree-list');
  if (!Array.isArray(list)) { el.innerHTML = '<div class="muted">Loading…</div>'; return; }
  if (!list.length) { el.innerHTML = '<div class="muted">No live worktrees.</div>'; return; }
  el.innerHTML = list.map((w) => {
    const live = w.taskId && w.taskStatus === 'running';
    return `
      <div class="worktree-row">
        <span class="worktree-dot ${w.dirty ? 'dirty' : 'clean'}" title="${w.dirty ? 'Uncommitted changes' : 'Clean'}"></span>
        <span class="worktree-branch">${esc(w.branch || '(detached)')}</span>
        ${aheadBehindHtml(w.ahead, w.behind)}
        ${w.taskId
        ? `<span class="chip worktree-task-link" data-task-link="${esc(w.taskId)}">${esc(w.taskTitle)} · ${esc(w.taskStatus)}</span>`
        : '<span class="muted">no task</span>'}
        <button class="btn ghost icon" data-term-wt="${esc(w.path)}" title="Open a terminal here" aria-label="Open a terminal here">${icon('terminal')}</button>
        <button class="btn ghost icon" data-reveal-wt="${esc(w.path)}" title="Reveal in ${esc(state.desktop.fileManager || 'file manager')}" aria-label="Reveal this worktree in your file manager">${icon('folder-open')}</button>
        <button class="btn ghost icon" data-ide-wt="${esc(w.path)}" title="${esc(defaultEditor() ? `Open in ${defaultEditor().label}` : 'Open in IDE')}" aria-label="Open this worktree in your IDE" aria-haspopup="menu">${icon('code')}</button>
        ${live ? '' : `<button class="btn ghost danger" data-rm-wt="${esc(w.path)}" title="${w.dirty ? 'Has uncommitted changes' : 'Remove this worktree'}">Remove</button>`}
      </div>`;
  }).join('');
}

function openWorkspacePopover() {
  const repo = state.repos.find((r) => r.id === state.view.repoId);
  if (!repo) return;
  $('#workspace-modal-title').textContent = repo.name;
  $('#workspace-info-path').textContent = repo.path;
  $('#workspace-info-name').textContent = repo.name;
  const branch = state.repoBranchByRepo.get(repo.id);
  $('#workspace-info-branch').textContent = branch && branch !== 'loading' ? branch : '…';
  renderWorkspaceWorktreeList(repo.id);
  $('#modal-workspace').classList.remove('hidden');
  refreshRepoWorktreesCard(repo.id, true);
}

export { currentWorkspaceRepoId, enterWorkspace, exitWorkspace, githubAvatarUrl, loadView, makeSortable, openWorkspacePopover, refreshRepoBranchCard, refreshRepoWorktreesCard, renderSuperView, renderView, reorderRepos };
