/* Sr. Popo — sidebar. No build step: native ES module. */
import { esc } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, ORCH_COLUMN, icon, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, state } from '../core/state.js';
import { openContextMenu } from './context-menu.js';
import { openDrawer, openGroomingDrawer, openOrchestrationDrawer } from './drawer.js';
import { filtersActive, groomingMatchesFilters, groomingsForRepo, orchestrationMatchesFilters, orchestrationsForRepo, taskMatchesFilters, tasksForRepo } from './filters.js';
import { openReposModal } from './repos-modal.js';
import { currentLayout } from './theme.js';
import { enterWorkspace, exitWorkspace, githubAvatarUrl, refreshRepoBranchCard } from './workspaces.js';


// ---------- project sidebar (experimental "sidebar" layout) ----------
// The alternate shell chosen in Settings → General → Appearance → Layout: a
// persistent left rail listing every repository with its cards grouped by
// board column, next to the same Super View / board the classic layout shows.
// It is pure navigation — clicking a project switches workspace, clicking a
// card opens the same drawer — so nothing here can change a task's state.
// Renders only while the layout is on; in the classic layout it's a no-op.

// Repos whose card list is unfolded. Kept in memory (not localStorage) like
// the rest of the board's transient UI state, so a re-render preserves it but
// a reload starts from the current workspace again.
const sidebarExpanded = new Set();
// The first render unfolds whichever workspace was restored from localStorage
// (entering one later does it in enterWorkspace). One-shot, so collapsing that
// project again isn't undone by the next SSE tick.
let sidebarSeeded = false;

const sidebarOn = () => currentLayout() === 'sidebar';

// One row per card, in board order: the same status dot, title and live
// spinner the card shows, compressed to a single line.
function sidebarCardRow(kind, id, title, dot, live, badge) {
  return `
      <button class="sidebar-card" data-${kind}="${esc(id)}" title="${esc(title)}">
        <span class="sidebar-card-dot" style="background:${dot}"></span>
        <span class="sidebar-card-title">${esc(title)}</span>
        ${live ? '<span class="spinner"></span>' : ''}
        ${badge ? `<span class="sidebar-card-badge">${esc(badge)}</span>` : ''}
      </button>`;
}

// A repo's cards, grouped by the column they sit in. Empty groups are dropped
// rather than rendered as six blank headings — the counts live on the group.
function sidebarGroupsHtml(repoId) {
  const groups = [];

  const groomings = groomingsForRepo(repoId).filter(groomingMatchesFilters)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (groomings.length) {
    groups.push({
      col: GROOMING_COLUMN,
      rows: groomings.map((g) => sidebarCardRow('grooming', g.id, g.title, GROOMING_COLUMN.dot,
        isGroomingLive(g), g.status === 'awaiting' ? 'needs input' : g.status === 'failed' ? 'failed' : '')),
    });
  }

  const orchestrations = orchestrationsForRepo(repoId).filter(orchestrationMatchesFilters)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  if (orchestrations.length) {
    groups.push({
      col: ORCH_COLUMN,
      rows: orchestrations.map((o) => sidebarCardRow('orchestration', o.id, o.title, ORCH_COLUMN.dot,
        isOrchestrationLive(o), o.status === 'awaiting' ? 'needs input' : o.status === 'failed' ? 'failed' : '')),
    });
  }

  const tasks = tasksForRepo(repoId).filter(taskMatchesFilters);
  for (const col of COLUMNS) {
    const inCol = tasks.filter((t) => COLUMN_OF_STATUS[t.status] === col.key)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    if (!inCol.length) continue;
    groups.push({
      col,
      rows: inCol.map((t) => sidebarCardRow('task', t.id, t.title, col.dot, isLive(t),
        t.status === 'failed' ? 'failed' : pendingPermissions(t.id).length ? 'approve' : '')),
    });
  }

  if (!groups.length) {
    return `<div class="sidebar-empty">${filtersActive() ? 'no matches' : 'no cards yet'}</div>`;
  }
  return groups.map(({ col, rows }) => `
      <div class="sidebar-group">
        <div class="sidebar-group-head">
          <span class="dot" style="background:${col.dot}"></span>
          <span class="sidebar-group-label">${esc(col.label)}</span>
          <span class="count">${rows.length}</span>
        </div>
        ${rows.join('')}
      </div>`).join('');
}

function sidebarRepoHtml(r) {
  const tasks = tasksForRepo(r.id);
  const live = tasks.filter(isLive).length + groomingsForRepo(r.id).filter(isGroomingLive).length +
    orchestrationsForRepo(r.id).filter(isOrchestrationLive).length;
  const open = sidebarExpanded.has(r.id);
  const active = state.view.mode === 'workspace' && state.view.repoId === r.id;
  const avatarUrl = githubAvatarUrl(state.repoRemoteUrlByRepo.get(r.id));
  return `
      <div class="sidebar-project${open ? ' open' : ''}">
        <div class="sidebar-project-head${active ? ' active' : ''}">
          <button class="sidebar-twisty" data-toggle="${esc(r.id)}" aria-expanded="${open}"
                  title="${open ? 'Collapse' : 'Expand'}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(r.name)}">
            ${icon(open ? 'chevron-down' : 'chevron-right')}
          </button>
          <button class="sidebar-project-btn" data-repo="${esc(r.id)}" title="${esc(r.path)}">
            ${avatarUrl
            ? `<img class="sidebar-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">`
            : `<span class="sidebar-project-icon">${icon('folder')}</span>`}
            <span class="sidebar-project-name">${esc(r.name)}</span>
            ${live
            ? `<span class="chip running-badge" title="${live} live session${live === 1 ? '' : 's'}"><span class="spinner"></span>${live}</span>`
            : `<span class="count">${tasks.length}</span>`}
          </button>
        </div>
        ${open ? `<div class="sidebar-project-body">${sidebarGroupsHtml(r.id)}</div>` : ''}
      </div>`;
}

function renderSidebar() {
  const el = $('#sidebar');
  if (!el || !sidebarOn()) return;
  // Waits for the first render that has repos — the layout is applied before
  // boot() has loaded any state, and that empty pass must not burn the seed.
  if (!sidebarSeeded && state.repos.length) {
    sidebarSeeded = true;
    if (state.view.mode === 'workspace') sidebarExpanded.add(state.view.repoId);
  }
  // innerHTML rebuild is the same choke point the board uses; keep the scroll
  // position so a live task's SSE tick doesn't yank the list from under you.
  const scroll = el.scrollTop;
  const superActive = state.view.mode === 'super';
  el.innerHTML = `
      <div class="sidebar-head">
        <span class="sidebar-head-title">Projects</span>
        <button class="btn ghost icon" id="sidebar-add-repo" title="Add a repository" aria-label="Add a repository">${icon('plus')}</button>
      </div>
      <button class="sidebar-super${superActive ? ' active' : ''}" data-super="1">
        ${icon('layout-grid')}<span>All projects</span>
        <span class="count">${state.repos.length}</span>
      </button>
      <div class="sidebar-projects">
        ${state.repos.length
        ? state.repos.map(sidebarRepoHtml).join('')
        : '<div class="sidebar-empty">No repositories yet.</div>'}
      </div>
      <div class="sidebar-foot">${icon('panel-left')} Experimental layout — switch back in Settings → Appearance</div>`;
  el.scrollTop = scroll;
  // Avatars come from the same per-repo branch lookup the Super View uses.
  for (const r of state.repos) refreshRepoBranchCard(r.id);
}

// Opening a card from another project switches the workspace too, so closing
// the drawer doesn't leave you on an unrelated board.
function sidebarOpenTask(taskId) {
  const t = state.tasks.get(taskId);
  if (t && t.repoId && state.view.repoId !== t.repoId) enterWorkspace(t.repoId);
  openDrawer(taskId);
}

// Load-time wiring. Called from app.js in the original source order.
export function init() {

  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('#sidebar-add-repo')) { openReposModal(); return; }
    const twisty = e.target.closest('[data-toggle]');
    if (twisty) {
      const id = twisty.dataset.toggle;
      if (sidebarExpanded.has(id)) sidebarExpanded.delete(id);
      else sidebarExpanded.add(id);
      renderSidebar();
      return;
    }
    if (e.target.closest('[data-super]')) { exitWorkspace(); return; }
    const repoBtn = e.target.closest('[data-repo]');
    if (repoBtn) { enterWorkspace(repoBtn.dataset.repo); return; }
    const taskBtn = e.target.closest('[data-task]');
    if (taskBtn) { sidebarOpenTask(taskBtn.dataset.task); return; }
    const groomBtn = e.target.closest('[data-grooming]');
    if (groomBtn) { openGroomingDrawer(groomBtn.dataset.grooming); return; }
    const orchBtn = e.target.closest('[data-orchestration]');
    if (orchBtn) openOrchestrationDrawer(orchBtn.dataset.orchestration);
  });

  // Same right-click menu as the board card, so the sidebar isn't a second-class
  // way to reach a task.
  $('#sidebar').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-task]');
    if (!row) return;
    const t = state.tasks.get(row.dataset.task);
    if (!t) return;
    e.preventDefault();
    openContextMenu(t, e.clientX, e.clientY);
  });
}


export { renderSidebar, sidebarExpanded };
