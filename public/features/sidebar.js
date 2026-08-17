/* Sr. Popo — sidebar. No build step: native ES module. */
import { esc } from '../core/api.js';
import { $, COLUMNS, COLUMN_OF_STATUS, GROOMING_COLUMN, ORCH_COLUMN, icon, isGroomingLive, isLive, isOrchestrationLive, pendingPermissions, state } from '../core/state.js';
import { openContextMenu } from './context-menu.js';
import { openDrawer, openGroomingDrawer, openOrchestrationDrawer } from './drawer.js';
import { filtersActive, groomingMatchesFilters, groomingsForRepo, orchestrationMatchesFilters, orchestrationsForRepo, taskMatchesFilters, tasksForRepo } from './filters.js';
import { openReposModal } from './repos-modal.js';
import { STATUS_LABEL, focusSession, openNewSessionMenu, sessionsForRepo } from './terminal.js';
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
// Organization groups the user folded away, by org key. Inverted on purpose
// (collapsed rather than expanded): a group is open until you close it, so
// grouping never hides a project you could see before.
const sidebarOrgCollapsed = new Set();
// The first render unfolds whichever workspace was restored from localStorage
// (entering one later does it in enterWorkspace). One-shot, so collapsing that
// project again isn't undone by the next SSE tick.
let sidebarSeeded = false;

// How many rows a group shows before it truncates. A busy project has dozens of
// cards; listing them all turns the rail into a second board you have to scroll
// past to reach the next project. The overflow row is the way out: for cards it
// opens that project's board (where everything is visible, in columns), which is
// the surface that's actually built for reading them.
const SIDEBAR_MAX_ROWS = 5;
// Sessions have no column and no board, so theirs expands in place instead.
// Per repo, in memory like `sidebarExpanded`.
const sidebarSessionsExpanded = new Set();

const sidebarOn = () => currentLayout() === 'sidebar';

// The organization a repo belongs to, read off its `origin` remote — the owner
// segment of the web URL the server already resolves (`https://host/org/repo`),
// so `anplabs/intranet` and `anplabs/platform` share one org. Keyed by host too:
// two `anplabs` on different forges are two different organizations. A repo with
// no hosted remote has none.
function repoOrg(repoId) {
  const remoteUrl = state.repoRemoteUrlByRepo.get(repoId);
  if (!remoteUrl) return null;
  try {
    const u = new URL(remoteUrl);
    const owner = u.pathname.split('/').filter(Boolean)[0];
    return owner ? { key: `${u.host}/${owner}`, label: owner, remoteUrl } : null;
  } catch { return null; }
}

// Repos in their user-chosen order, with same-organization ones folded into a
// group. A group needs at least two members — nesting a lone repo under its own
// org heading costs a level of indentation and tells you nothing — so the rest
// stay top-level rows exactly where they were. A group sits at the position of
// its first member, keeping the list's drag-ordered feel.
function sidebarOrgEntries(repos) {
  const counts = new Map();
  for (const r of repos) {
    const org = repoOrg(r.id);
    if (org) counts.set(org.key, (counts.get(org.key) || 0) + 1);
  }
  const entries = [];
  const byKey = new Map();
  for (const r of repos) {
    const org = repoOrg(r.id);
    if (!org || counts.get(org.key) < 2) { entries.push({ org: null, repos: [r] }); continue; }
    let entry = byKey.get(org.key);
    if (!entry) { entry = { org, repos: [] }; byKey.set(org.key, entry); entries.push(entry); }
    entry.repos.push(r);
  }
  return entries;
}

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

// Terminal sessions for a repo. Not cards — they have no column and no board
// state — so they get their own group above the cards, always rendered (even
// empty) because its heading carries the "new session" button. Clicking a row
// jumps straight into that shell.
function sidebarSessionsHtml(repoId) {
  const rows = sessionsForRepo(repoId).map((s) => `
      <button class="sidebar-card sidebar-session" data-session="${esc(s.id)}"
              title="${esc(`${s.label} — ${STATUS_LABEL[s.status]}\n${s.cwd}`)}">
        <span class="term-dot ${esc(s.status)}"></span>
        <span class="sidebar-card-title">${esc(s.label)}</span>
        ${s.status === 'exited' ? '<span class="sidebar-card-badge">closed</span>' : ''}
      </button>`);
  const all = sidebarSessionsExpanded.has(repoId);
  const shown = all ? rows : rows.slice(0, SIDEBAR_MAX_ROWS);
  const hidden = rows.length - shown.length;
  return `
      <div class="sidebar-group">
        <div class="sidebar-group-head">
          ${icon('terminal')}
          <span class="sidebar-group-label">Sessions</span>
          <span class="count">${rows.length}</span>
          <button class="sidebar-group-add" data-new-session="${esc(repoId)}"
                  title="New terminal session" aria-label="New terminal session">${icon('plus')}</button>
        </div>
        ${shown.join('') || '<div class="sidebar-empty">no sessions</div>'}
        ${rows.length > SIDEBAR_MAX_ROWS
        ? `<button class="sidebar-more" data-more-sessions="${esc(repoId)}">
             ${icon(all ? 'chevron-up' : 'chevron-down')}
             <span>${all ? 'Show less' : `Show ${hidden} more`}</span>
           </button>`
        : ''}
      </div>`;
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
  // Truncated at SIDEBAR_MAX_ROWS: the overflow row opens the project's board
  // rather than growing the rail, since that's where every card is already laid
  // out in full — the rail stays a way in, not a place to read a backlog.
  return groups.map(({ col, rows }) => `
      <div class="sidebar-group">
        <div class="sidebar-group-head">
          <span class="dot" style="background:${col.dot}"></span>
          <span class="sidebar-group-label">${esc(col.label)}</span>
          <span class="count">${rows.length}</span>
        </div>
        ${rows.slice(0, SIDEBAR_MAX_ROWS).join('')}
        ${rows.length > SIDEBAR_MAX_ROWS
        ? `<button class="sidebar-more" data-more-board="${esc(repoId)}"
                   title="Open this project's board to see all ${rows.length} cards">
             ${icon('layout-grid')}
             <span>Show ${rows.length - SIDEBAR_MAX_ROWS} more</span>
           </button>`
        : ''}
      </div>`).join('');
}

// Live sessions of every kind for a repo — the number the rail badges.
function repoLiveCount(repoId) {
  return tasksForRepo(repoId).filter(isLive).length +
    groomingsForRepo(repoId).filter(isGroomingLive).length +
    orchestrationsForRepo(repoId).filter(isOrchestrationLive).length;
}

// `inOrg` drops the repo's avatar: it is the *organization's* avatar (GitHub
// serves one per owner), so under an org heading that already shows it every
// child row would repeat the same picture.
function sidebarRepoHtml(r, inOrg) {
  const tasks = tasksForRepo(r.id);
  const live = repoLiveCount(r.id);
  const open = sidebarExpanded.has(r.id);
  const active = state.view.mode === 'workspace' && state.view.repoId === r.id;
  const avatarUrl = inOrg ? null : githubAvatarUrl(state.repoRemoteUrlByRepo.get(r.id));
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
        ${open ? `<div class="sidebar-project-body">${sidebarSessionsHtml(r.id)}<div class="sidebar-divider"></div>${sidebarGroupsHtml(r.id)}</div>` : ''}
      </div>`;
}

// An organization and the repos under it. Purely a container: the heading only
// folds the group away — clicking it never changes the workspace, since an org
// isn't a place you can be.
function sidebarOrgHtml({ org, repos }) {
  if (!org) return sidebarRepoHtml(repos[0], false);
  const open = !sidebarOrgCollapsed.has(org.key);
  const live = repos.reduce((n, r) => n + repoLiveCount(r.id), 0);
  const avatarUrl = githubAvatarUrl(org.remoteUrl);
  return `
      <div class="sidebar-org${open ? ' open' : ''}">
        <button class="sidebar-org-btn" data-org="${esc(org.key)}" aria-expanded="${open}"
                title="${esc(`${org.label} — ${repos.length} repositories`)}">
          <span class="sidebar-org-twisty">${icon(open ? 'chevron-down' : 'chevron-right')}</span>
          ${avatarUrl
          ? `<img class="sidebar-avatar" src="${esc(avatarUrl)}" alt="" loading="lazy">`
          : `<span class="sidebar-project-icon">${icon('folder')}</span>`}
          <span class="sidebar-org-name">${esc(org.label)}</span>
          ${live
          ? `<span class="chip running-badge" title="${live} live session${live === 1 ? '' : 's'}"><span class="spinner"></span>${live}</span>`
          : `<span class="count">${repos.length}</span>`}
        </button>
        ${open ? `<div class="sidebar-org-body">${repos.map((r) => sidebarRepoHtml(r, true)).join('')}</div>` : ''}
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
        ? sidebarOrgEntries(state.repos).map(sidebarOrgHtml).join('')
        : '<div class="sidebar-empty">No repositories yet.</div>'}
      </div>
      <div class="sidebar-foot">${icon('panel-left')} Experimental layout — projects and sessions open as tabs. Switch back in Settings → Appearance</div>`;
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
    // Sessions are handled before the project row they sit under, since both
    // live inside the same expanded project.
    const addSession = e.target.closest('[data-new-session]');
    if (addSession) { openNewSessionMenu(addSession.dataset.newSession, addSession); return; }
    // Overflow rows, checked before the card/project rows they sit among.
    const moreSessions = e.target.closest('[data-more-sessions]');
    if (moreSessions) {
      const id = moreSessions.dataset.moreSessions;
      if (sidebarSessionsExpanded.has(id)) sidebarSessionsExpanded.delete(id);
      else sidebarSessionsExpanded.add(id);
      renderSidebar();
      return;
    }
    const moreBoard = e.target.closest('[data-more-board]');
    if (moreBoard) { enterWorkspace(moreBoard.dataset.moreBoard); return; }
    const sessionBtn = e.target.closest('[data-session]');
    if (sessionBtn) { focusSession(sessionBtn.dataset.session); return; }
    const orgBtn = e.target.closest('[data-org]');
    if (orgBtn) {
      const key = orgBtn.dataset.org;
      if (sidebarOrgCollapsed.has(key)) sidebarOrgCollapsed.delete(key);
      else sidebarOrgCollapsed.add(key);
      renderSidebar();
      return;
    }
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
