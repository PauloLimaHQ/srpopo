/* Sr. Popo — frontend. No build step, no dependencies. */
(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    repos: [],
    tasks: new Map(), // id -> task
    groomings: new Map(), // id -> grooming card (own lifecycle, Grooming column)
    openTaskId: null, // task shown in drawer
    openGroomingId: null, // grooming card shown in drawer (mutually exclusive)
    addons: [],       // catalog of optional task behaviors (from /api/addons)
    personas: [],     // catalog of expert personas (from /api/personas)
    plugins: [],      // marketplace catalog (from /api/plugins)
    settings: { notifications: true, sounds: true, maxParallelSessions: 3, installedPlugins: [], mergeStrategy: 'merge', remoteAccess: false, remoteAccessConfigured: false, customModels: [] }, // user preferences (from /api/settings)
    filters: { search: '' }, // board filters (free-text only — repo scope comes from state.view)
    view: { mode: 'super' }, // { mode: 'super' } | { mode: 'workspace', repoId }
    prByTask: new Map(), // taskId -> 'loading' | { pr, reason } from /api/tasks/:id/pr
    repoBranchByTask: new Map(), // taskId -> 'loading' | repo's live current branch (non-worktree tasks only)
    repoBranchByRepo: new Map(), // repoId -> 'loading' | repo's live current branch (Super View / workspace header)
    worktreesByRepo: new Map(), // repoId -> 'loading' | [ WorktreeInfo ] from /api/repos/:id/worktrees
    permissions: new Map(), // taskId -> [ pending tool-approval requests ]
    autoApprove: new Set(), // taskIds whose live run is in auto-approve ("AUTO MODE")
    autonomous: null, // live autonomous-session snapshot (from /api/state + `autonomous` SSE)
    usage: { period: '30d', repoId: '', summary: null }, // Settings → Usage panel (from /api/usage)
  };

  // Pending permission-prompt helpers — a task's live tool-approval requests.
  function pendingPermissions(taskId) {
    return state.permissions.get(taskId) || [];
  }
  function setPendingPermissions(taskId, list) {
    if (list && list.length) state.permissions.set(taskId, list);
    else state.permissions.delete(taskId);
  }
  // Auto-approve ("AUTO MODE") helpers — a running task the user has told to allow
  // every otherwise-prompted tool. Process-local, tracked live off SSE.
  function isAutoApprove(taskId) {
    return state.autoApprove.has(taskId);
  }
  function setAutoApproveLocal(taskId, on) {
    if (on) state.autoApprove.add(taskId);
    else state.autoApprove.delete(taskId);
  }

  // In the desktop app native notifications are fired by the Electron shell; in a
  // plain browser we fall back to the Web Notifications API from here.
  const isElectron = !!(window.srpopo && window.srpopo.isElectron);

  // Dot colors are mid-tones chosen to read on both the light "paper" and dark
  // surfaces; running uses Claude's terracotta accent to match the theme.
  const COLUMNS = [
    { key: 'backlog', label: 'Backlog', dot: '#94897a' },
    { key: 'ready', label: 'Ready', dot: '#5b8cbe' },
    { key: 'running', label: 'Running', dot: '#d97757' },
    { key: 'review', label: 'Review', dot: '#8a78d6' },
    { key: 'done', label: 'Done', dot: '#5aa873' },
  ];
  // The Grooming column is not a task column: it's rendered first, holds only
  // grooming cards (their own draft/running/finished lifecycle), and is locked —
  // nothing is ever dragged into or out of it.
  const GROOMING_COLUMN = { key: 'grooming', label: 'Grooming', dot: '#c06fce' };
  // failed tasks are surfaced in the Review column with a FAILED badge
  const COLUMN_OF_STATUS = {
    backlog: 'backlog', ready: 'ready', running: 'running',
    review: 'review', failed: 'review', done: 'done',
  };
  // A live task runs a claude child process — its card can't be dragged/edited
  // and shows a spinner + stop button instead.
  const isLive = (t) => t.status === 'running';
  const isGroomingLive = (g) => g.status === 'running';

  const $ = (sel) => document.querySelector(sel);

  // Modifier label for on-screen keyboard hints — ⌘ on macOS, "Ctrl" elsewhere.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const MOD = IS_MAC ? '⌘' : 'Ctrl';

  // Inline SVG icon (Lucide, via icons.js). Returns trusted markup — insert it
  // into templates directly, never through esc(). No emojis in the UI.
  const icon = (name, opts) => (window.srpopoIcons ? window.srpopoIcons.svg(name, opts) : '');

  // ---------- api ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${url} failed (${res.status})`);
    return data;
  }

  function toast(msg, type = 'error') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // Persistent "update ready" banner (Electron only) — unlike toast() above it
  // does not auto-dismiss; it stays until the user relaunches.
  function showUpdateBanner(version) {
    if ($('#update-banner')) return;
    const el = document.createElement('div');
    el.id = 'update-banner';
    el.className = 'toast info update-banner';
    el.innerHTML =
      `${icon('rotate-cw')}` +
      `<span>A new version of Sr. Popo is ready${version ? ` (v${esc(version)})` : ''} — Relaunch to update.</span>` +
      `<button class="btn primary" id="update-banner-btn">Relaunch</button>`;
    $('#toasts').appendChild(el);
    $('#update-banner-btn').addEventListener('click', () => window.srpopo.restartToUpdate());
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Extra class for the model chip so each model gets its own color, tiered by
  // cost (fable reads red — the most expensive). Matches both the short alias
  // the user picked ("opus") and a resolved model id ("claude-opus-4-8").
  const modelClass = (name) => {
    const n = String(name || '').toLowerCase();
    for (const m of ['fable', 'opus', 'sonnet', 'haiku']) if (n.includes(m)) return ` model-${m}`;
    return '';
  };

  // Small, dependency-free markdown → HTML for Claude's own chat text (headings,
  // lists, code fences/spans, bold/italic, links). Always escapes the source first
  // and only ever re-introduces tags we generate ourselves — the markdown source
  // is never trusted to inject arbitrary markup.
  function mdToHtml(src) {
    const codeBlocks = [];
    const text = String(src ?? '').replace(/```[ \t]*(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push(`<pre class="md-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return ` B${codeBlocks.length - 1} `;
    });

    function inline(line) {
      const spans = [];
      let s = esc(line).replace(/`([^`]+)`/g, (_, c) => {
        spans.push(`<code>${c}</code>`);
        return ` S${spans.length - 1} `;
      });
      s = s
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
      return s.replace(/ S(\d+) /g, (_, i) => spans[Number(i)]);
    }

    const html = [];
    let list = null; // { tag: 'ul'|'ol', items: [] }
    let para = [];
    const flushPara = () => { if (para.length) { html.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const flushList = () => {
      if (list) html.push(`<${list.tag}>${list.items.map((it) => `<li>${it}</li>`).join('')}</${list.tag}>`);
      list = null;
    };

    for (const line of text.split('\n')) {
      const codeRef = line.match(/^ B(\d+) $/);
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      const quote = line.match(/^>\s?(.*)$/);
      const ul = line.match(/^[-*+]\s+(.+)$/);
      const ol = line.match(/^\d+\.\s+(.+)$/);
      const hr = /^([-*_])\1{2,}$/.test(line.trim());

      if (codeRef) { flushPara(); flushList(); html.push(codeBlocks[Number(codeRef[1])]); } else if (heading) {
        flushPara(); flushList();
        const level = Math.min(heading[1].length + 2, 6); // keep headings small inside a chat bubble
        html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      } else if (hr) {
        flushPara(); flushList(); html.push('<hr>');
      } else if (quote) {
        flushPara(); flushList(); html.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      } else if (ul) {
        flushPara();
        if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
        list.items.push(inline(ul[1]));
      } else if (ol) {
        flushPara();
        if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
        list.items.push(inline(ol[1]));
      } else if (line.trim() === '') {
        flushPara(); flushList();
      } else {
        flushList(); para.push(inline(line));
      }
    }
    flushPara(); flushList();
    return html.join('');
  }

  function fmtDuration(ms) {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function elapsedSince(iso) {
    return fmtDuration(Date.now() - new Date(iso).getTime());
  }

  // ---------- filters ----------
  // Inside a workspace there is only one repo in scope (state.view.repoId), so
  // the only filter left to apply is the free-text search over title/repo/prompt.
  function taskMatchesFilters(t) {
    const f = state.filters;
    if (f.search) {
      const hay = `${t.title} ${t.repoName} ${t.prompt || ''}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  }

  const filtersActive = () => !!state.filters.search;

  const FILTER_KEY = 'srpopo.filters';
  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ search: state.filters.search }));
    } catch { /* storage unavailable — non-fatal */ }
  }
  function loadFilters() {
    try {
      const f = JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
      state.filters.search = (f.search || '').toLowerCase();
    } catch { /* ignore malformed storage */ }
  }

  function onFiltersChanged() {
    saveFilters();
    renderBoard();
  }

  // Tasks scoped to the workspace currently open (empty outside a workspace).
  function tasksForRepo(repoId) {
    return [...state.tasks.values()].filter((t) => t.repoId === repoId);
  }

  // Grooming cards scoped to a workspace, same idea as tasksForRepo.
  function groomingsForRepo(repoId) {
    return [...state.groomings.values()].filter((g) => g.repoId === repoId);
  }

  function groomingMatchesFilters(g) {
    const f = state.filters;
    if (f.search) {
      const hay = `${g.title} ${g.repoName} ${g.idea || ''}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  }

  function updateFilterMeta() {
    const all = tasksForRepo(state.view.repoId);
    const shown = all.filter(taskMatchesFilters).length;
    $('#filter-count').textContent = filtersActive() ? `${shown} of ${all.length}` : `${all.length} tasks`;
    $('#filter-clear').classList.toggle('hidden', !filtersActive());
  }

  // ---------- board ----------
  // The single choke point every "something changed" handler calls. Outside a
  // workspace there's no board to draw — refresh the Super View instead so its
  // per-repo stats (graph, live badge, task count) stay live.
  function renderBoard() {
    if (state.view.mode !== 'workspace') { renderSuperView(); return; }
    updateFilterMeta();
    const board = $('#board');
    board.innerHTML = '';
    const repoTasks = tasksForRepo(state.view.repoId);
    const repoGroomings = groomingsForRepo(state.view.repoId);

    // Grooming leads the board. It's part of the process but has its own
    // lifecycle, so the column is locked: no drag in, no drag out. Shown when
    // the Idea Grooming plugin is installed, or when cards already exist (e.g.
    // a Linear import, or cards from before the plugin was uninstalled).
    if (pluginInstalled('grooming') || repoGroomings.length) {
      const groomings = repoGroomings
        .filter(groomingMatchesFilters)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      const colEl = document.createElement('div');
      colEl.className = 'column grooming-column';
      colEl.dataset.col = GROOMING_COLUMN.key;
      colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${GROOMING_COLUMN.dot}"></span>
          ${GROOMING_COLUMN.label}
          <span class="count">${groomings.length}</span>
        </div>
        <div class="column-body"></div>`;
      const body = colEl.querySelector('.column-body');
      if (!groomings.length) {
        body.innerHTML = `<div class="column-empty">${filtersActive() ? 'no matches' : 'brief an idea to fill this'}</div>`;
      }
      for (const g of groomings) body.appendChild(renderGroomingCard(g));
      board.appendChild(colEl);
    }

    for (const col of COLUMNS) {
      const tasks = repoTasks
        .filter((t) => COLUMN_OF_STATUS[t.status] === col.key)
        .filter(taskMatchesFilters)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      // The running column's count doubles as a live view of the parallel-session
      // cap (dispatched runs + grooming share the same claude-process budget —
      // see runner.runningCount), so a user can tell at a glance why a dispatch
      // was rejected without opening Settings.
      const max = state.settings.maxParallelSessions;
      const liveCount = [...state.tasks.values()].filter(isLive).length +
        [...state.groomings.values()].filter(isGroomingLive).length;
      const countLabel = col.key === 'running' && max ? `${liveCount}/${max}` : tasks.length;

      const colEl = document.createElement('div');
      colEl.className = 'column';
      colEl.dataset.col = col.key;
      colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${col.dot}"></span>
          ${col.label}
          <span class="count" ${col.key === 'running' && max ? `title="${liveCount} of ${max} parallel sessions in use (running + grooming)"` : ''}>${countLabel}</span>
        </div>
        <div class="column-body"></div>`;
      const body = colEl.querySelector('.column-body');

      if (!tasks.length) {
        const hint = filtersActive() ? 'no matches'
          : col.key === 'running' ? 'drag a card here to dispatch' : 'empty';
        body.innerHTML = `<div class="column-empty">${hint}</div>`;
      }
      for (const t of tasks) body.appendChild(renderCard(t));

      colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('drag-over'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
      colEl.addEventListener('drop', (e) => {
        e.preventDefault();
        colEl.classList.remove('drag-over');
        onDrop(e.dataTransfer.getData('text/task-id'), col.key);
      });
      board.appendChild(colEl);
    }
  }

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
  const enterWorkspace = (repoId) => setView({ mode: 'workspace', repoId });
  const exitWorkspace = () => setView({ mode: 'super' });
  // The workspace open when a New Task / Brief / Linear modal is launched, so
  // those flows default their repo <select> to it instead of the last-used repo.
  const currentWorkspaceRepoId = () => (state.view.mode === 'workspace' ? state.view.repoId : null);

  // Toggles the Super View / workspace board and re-renders whichever is now visible.
  function renderView() {
    const isSuper = state.view.mode === 'super';
    $('#super-view').classList.toggle('hidden', !isSuper);
    $('#board').classList.toggle('hidden', isSuper);
    $('#workspace-header').classList.toggle('hidden', isSuper);
    $('#filterbar').classList.toggle('hidden', isSuper);
    if (isSuper) renderSuperView();
    else { renderWorkspaceHeader(); renderBoard(); }
    renderAutonomous();
  }

  // Live lookup of a repo's current branch, cached like refreshRepoBranchForTask
  // — used by both the Super View cards and the workspace header chip.
  async function refreshRepoBranchCard(repoId, force) {
    if (!force && state.repoBranchByRepo.has(repoId)) return;
    state.repoBranchByRepo.set(repoId, 'loading');
    let branch = null;
    try { ({ branch } = await api('GET', `/api/repos/${repoId}/branch`)); } catch { /* stays null */ }
    state.repoBranchByRepo.set(repoId, branch);
    if (state.view.mode === 'super') renderSuperView();
    else if (state.view.mode === 'workspace' && state.view.repoId === repoId) renderWorkspaceHeader();
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
  function workspaceGraphHtml(tasks, groomings) {
    if (!tasks.length && !groomings.length) return `<div class="workspace-graph empty"></div>`;
    const counts = new Map();
    for (const t of tasks) {
      const col = COLUMN_OF_STATUS[t.status];
      counts.set(col, (counts.get(col) || 0) + 1);
    }
    const segs = [GROOMING_COLUMN, ...COLUMNS]
      .map((c) => ({ c, n: c.key === 'grooming' ? groomings.length : counts.get(c.key) }))
      .filter(({ n }) => n)
      .map(({ c, n }) =>
        `<span class="workspace-graph-seg" style="background:${c.dot};flex:${n} 0 0" title="${esc(c.label)}: ${n}"></span>`
      ).join('');
    return `<div class="workspace-graph">${segs}</div>`;
  }

  function workspaceCardHtml(r) {
    const tasks = tasksForRepo(r.id);
    const groomings = groomingsForRepo(r.id);
    const liveCount = tasks.filter(isLive).length + groomings.filter(isGroomingLive).length;
    const branch = state.repoBranchByRepo.get(r.id);
    const wt = state.worktreesByRepo.get(r.id);
    const wtCount = Array.isArray(wt) ? wt.length : null;
    return `
      <div class="workspace-card" data-repo="${esc(r.id)}" title="${esc(r.path)}">
        <div class="workspace-card-head">
          <span class="workspace-card-name">${esc(r.name)}</span>
          ${liveCount ? `<span class="chip running-badge"><span class="spinner"></span>${liveCount} live</span>` : ''}
        </div>
        ${workspaceGraphHtml(tasks, groomings)}
        <div class="workspace-card-foot">
          ${branch && branch !== 'loading' ? `<span class="chip">${icon('git-branch')} ${esc(branch)}</span>` : ''}
          <span class="chip">${wtCount == null ? '…' : wtCount} worktree${wtCount === 1 ? '' : 's'}</span>
          <span class="chip">${tasks.length} task${tasks.length === 1 ? '' : 's'}</span>
        </div>
      </div>`;
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
    const branch = state.repoBranchByRepo.get(repo.id);
    $('#workspace-branch-chip').innerHTML = branch && branch !== 'loading'
      ? `<span class="chip">${icon('git-branch')} ${esc(branch)}</span>` : '';
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
        ${w.taskId
          ? `<span class="chip worktree-task-link" data-task-link="${esc(w.taskId)}">${esc(w.taskTitle)} · ${esc(w.taskStatus)}</span>`
          : '<span class="muted">no task</span>'}
        <button class="btn ghost icon" data-term-wt="${esc(w.path)}" title="Open a terminal here">${icon('terminal')}</button>
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

  // ---------- workspace quick switcher (anchored popover) ----------
  // Jump straight from one workspace to another (or back to Super View) without
  // detouring through the Super View grid. Modeled on the command palette: a
  // filterable, arrow-key-navigable list, but anchored under the header title.
  let wsPickerResults = []; // flat, in on-screen order: { kind:'super' } | { kind:'repo', repo }
  let wsPickerActive = 0;

  function wsPickerIsCurrent(entry) {
    return entry.kind === 'super'
      ? state.view.mode === 'super'
      : state.view.mode === 'workspace' && state.view.repoId === entry.repo.id;
  }

  function renderWorkspacePicker(query) {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text) => tokens.every((t) => text.includes(t));
    wsPickerResults = [];
    if (matches('super view all workspaces home')) wsPickerResults.push({ kind: 'super' });
    for (const r of state.repos) {
      if (matches(`${r.name} ${r.path}`.toLowerCase())) wsPickerResults.push({ kind: 'repo', repo: r });
    }
    // Start the highlight on the current workspace so Enter is a no-op, not a surprise.
    const curIdx = wsPickerResults.findIndex(wsPickerIsCurrent);
    wsPickerActive = curIdx >= 0 ? curIdx : 0;

    const list = $('#workspace-popover-list');
    if (!wsPickerResults.length) {
      list.innerHTML = '<div class="palette-empty">No matching workspaces</div>';
      return;
    }
    list.innerHTML = wsPickerResults.map((e, i) => {
      let iconName, label, hint;
      if (e.kind === 'super') {
        iconName = 'arrow-left'; label = 'Super View'; hint = 'All workspaces';
      } else {
        iconName = 'folder'; label = e.repo.name;
        const tasks = tasksForRepo(e.repo.id);
        const live = tasks.filter(isLive).length;
        const count = `${tasks.length} task${tasks.length === 1 ? '' : 's'}`;
        hint = live ? `${count} · ${live} live` : count;
      }
      return `<div class="palette-option" data-index="${i}" role="menuitem">
        <span class="palette-option-icon">${icon(iconName)}</span>
        <span class="palette-option-body">
          <span class="palette-option-label">${esc(label)}</span>
          <span class="palette-option-hint">${esc(hint)}</span>
        </span>
        ${wsPickerIsCurrent(e) ? `<span class="ws-check" title="Current">${icon('check')}</span>` : ''}
      </div>`;
    }).join('');
    updateWsPickerActive();
  }

  function updateWsPickerActive() {
    const list = $('#workspace-popover-list');
    list.querySelectorAll('.palette-option').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === wsPickerActive);
    });
    list.querySelector('.palette-option.active')?.scrollIntoView({ block: 'nearest' });
  }

  function moveWsPicker(delta) {
    if (!wsPickerResults.length) return;
    wsPickerActive = (wsPickerActive + delta + wsPickerResults.length) % wsPickerResults.length;
    updateWsPickerActive();
  }

  function activateWsPicker(index) {
    const entry = wsPickerResults[index];
    if (!entry) return;
    closeWorkspacePicker();
    if (entry.kind === 'super') exitWorkspace();
    else enterWorkspace(entry.repo.id);
  }

  const wsPickerOpen = () => !$('#workspace-popover').classList.contains('hidden');
  function openWorkspacePicker() {
    $('#workspace-popover-search').value = '';
    renderWorkspacePicker('');
    $('#workspace-popover').classList.remove('hidden');
    $('#workspace-switcher').setAttribute('aria-expanded', 'true');
    $('#workspace-popover-search').focus();
  }
  function closeWorkspacePicker() {
    $('#workspace-popover').classList.add('hidden');
    $('#workspace-switcher').setAttribute('aria-expanded', 'false');
  }
  function toggleWorkspacePicker() { wsPickerOpen() ? closeWorkspacePicker() : openWorkspacePicker(); }

  $('#workspace-switcher').addEventListener('click', (e) => { e.stopPropagation(); toggleWorkspacePicker(); });
  $('#workspace-popover-search').addEventListener('input', (e) => renderWorkspacePicker(e.target.value));
  $('#workspace-popover-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveWsPicker(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveWsPicker(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activateWsPicker(wsPickerActive); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWorkspacePicker(); $('#workspace-switcher').focus(); }
  });
  $('#workspace-popover-list').addEventListener('click', (e) => {
    const row = e.target.closest('.palette-option');
    if (row) activateWsPicker(Number(row.dataset.index));
  });
  $('#workspace-popover-list').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.palette-option');
    if (row && Number(row.dataset.index) !== wsPickerActive) {
      wsPickerActive = Number(row.dataset.index);
      updateWsPickerActive();
    }
  });
  // Click anywhere outside the popover (or its trigger) closes it.
  document.addEventListener('click', (e) => {
    if (wsPickerOpen() && !e.target.closest('#workspace-popover') && !e.target.closest('#workspace-switcher')) {
      closeWorkspacePicker();
    }
  });

  // ---- In-app terminal (embedded shell, docked at the bottom) ----
  const termState = { xterm: null, fit: null, es: null, id: null, queue: '', sending: false };

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // Sends typed input to the shell in order. Fast keystrokes are coalesced into
  // one request and requests never overlap, so bytes can't arrive out of order.
  async function flushTermInput() {
    if (termState.sending || !termState.queue || !termState.id) return;
    termState.sending = true;
    const data = termState.queue;
    termState.queue = '';
    try { await api('POST', `/api/terminal/${termState.id}/input`, { data }); } catch (_) { /* session gone */ }
    termState.sending = false;
    if (termState.queue) flushTermInput();
  }

  function closeTerminal() {
    if (termState.id) api('POST', `/api/terminal/${termState.id}/close`).catch(() => {});
    if (termState.es) { termState.es.close(); termState.es = null; }
    if (termState.xterm) { termState.xterm.dispose(); termState.xterm = null; }
    termState.fit = null;
    termState.id = null;
    termState.queue = '';
    $('#terminal-panel').classList.add('hidden');
    window.removeEventListener('resize', fitTerminal);
  }

  function fitTerminal() {
    if (!termState.fit || !termState.id) return;
    try { termState.fit.fit(); } catch (_) { /* not mounted */ }
    api('POST', `/api/terminal/${termState.id}/resize`, { cols: termState.xterm.cols, rows: termState.xterm.rows }).catch(() => {});
  }

  // Opens an in-app shell rooted at a repo/worktree path. Omit `wtPath` for the
  // repo root (the "current page" the workspace is showing).
  async function openTerminalAt(repoId, wtPath) {
    if (typeof window.Terminal !== 'function') { toast('Terminal component failed to load', 'error'); return; }
    closeTerminal();
    const panel = $('#terminal-panel');
    panel.classList.remove('hidden');
    $('#terminal-cwd').textContent = wtPath || (state.repos.find((r) => r.id === repoId)?.path ?? '');

    const term = new window.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0e14', foreground: '#d7dce5', cursor: '#d7dce5' },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#terminal-mount'));
    fit.fit();
    termState.xterm = term;
    termState.fit = fit;

    let session;
    try {
      session = await api('POST', `/api/repos/${repoId}/terminal`, {
        path: wtPath || undefined,
        cols: term.cols,
        rows: term.rows,
      });
    } catch (e) {
      toast(e.message || 'Failed to open terminal', 'error');
      closeTerminal();
      return;
    }
    termState.id = session.id;

    term.onData((d) => { termState.queue += d; flushTermInput(); });
    window.addEventListener('resize', fitTerminal);

    const es = new EventSource(`/api/terminal/${session.id}/stream`);
    termState.es = es;
    es.onmessage = (ev) => {
      if (ev.data === '') { term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n'); return; }
      term.write(b64ToBytes(ev.data));
    };
    es.addEventListener('gone', () => term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n'));
    term.focus();
  }

  $('#terminal-close').addEventListener('click', closeTerminal);

  $('#workspace-back').addEventListener('click', exitWorkspace);
  $('#workspace-terminal').addEventListener('click', () => {
    const repoId = state.view.repoId;
    if (repoId) openTerminalAt(repoId);
  });
  $('#workspace-info').addEventListener('click', openWorkspacePopover);
  // Autonomous Mode: the header button starts a session (opens the budget modal)
  // or stops the one running for this workspace.
  $('#btn-autonomous').addEventListener('click', () => (autonomousForWorkspace() ? stopAutonomous() : openAutonomousModal()));
  $('#autonomous-cancel').addEventListener('click', () => $('#modal-autonomous').classList.add('hidden'));
  $('#autonomous-start').addEventListener('click', startAutonomous);
  $('#workspace-modal-close').addEventListener('click', () => $('#modal-workspace').classList.add('hidden'));
  $('#workspace-open-terminal').addEventListener('click', () => {
    const repoId = state.view.repoId;
    if (repoId) openTerminalAt(repoId);
  });
  $('#workspace-worktree-list').addEventListener('click', async (e) => {
    const id = e.target.closest('[data-task-link]')?.dataset.taskLink;
    if (id) { $('#modal-workspace').classList.add('hidden'); openDrawer(id); return; }
    const termPath = e.target.closest('[data-term-wt]')?.dataset.termWt;
    if (termPath) { $('#modal-workspace').classList.add('hidden'); openTerminalAt(state.view.repoId, termPath); return; }
    const wtPath = e.target.closest('[data-rm-wt]')?.dataset.rmWt;
    if (!wtPath) return;
    if (!confirm(`Remove worktree?\n${wtPath}\n\nThis discards any uncommitted changes in it.`)) return;
    const repoId = state.view.repoId;
    try {
      await api('POST', `/api/repos/${repoId}/worktrees/remove`, { path: wtPath });
      toast('Worktree removed', 'info');
      await refreshRepoWorktreesCard(repoId, true);
    } catch (e2) {
      toast(e2.message || 'Failed to remove worktree', 'error');
    }
  });

  function renderCard(t) {
    const el = document.createElement('div');
    el.className = `card ${t.status === 'running' ? 'running' : ''} ${t.status === 'failed' ? 'failed' : ''} ${t.resolvingConflicts ? 'resolving-conflicts' : ''}`;
    el.draggable = !isLive(t);
    el.dataset.id = t.id;

    const modelName = t.model === 'default' ? (t.resolvedModel || 'default') : t.model;
    const chips = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model${modelClass(modelName)}">${esc(modelName)}</span>`,
    ];
    if (t.groomingId) chips.push(`<span class="chip grooming-chip" title="Spawned by a grooming">${icon('lightbulb')} groomed</span>`);
    if (t.resolvingConflicts) chips.push(`<span class="chip conflict-chip" title="Auto-resolving merge conflicts with main">${icon('git-branch')} Resolving Conflicts</span>`);
    if (t.useWorktree) chips.push(`<span class="chip worktree" title="${esc(t.worktreePath || 'worktree on dispatch')}">${icon('git-branch')} ${esc(t.branch || t.branchName || 'worktree')}</span>`);
    if (t.addons && t.addons.includes('pull_request')) {
      const draft = !!t.prDraft;
      chips.push(`<span class="chip addon-chip" title="${draft ? 'Opens a draft pull request when finished' : 'Opens a pull request when finished'}">${icon('git-pull-request')} PR${draft ? ' (draft)' : ''}</span>`);
    }
    if (t.addons && t.addons.includes('code_review')) chips.push(`<span class="chip addon-chip" title="Self code-reviews and fixes issues before finishing">${icon('search')} review</span>`);
    (t.personas || []).forEach((pid) => {
      const p = state.personas.find((x) => x.id === pid);
      chips.push(`<span class="chip persona-chip" title="${esc(p ? p.hint : 'persona')}">${icon('persona')} ${esc(p ? p.label : pid)}</span>`);
    });
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
          <span class="elapsed" data-start="${esc(t.startedAt)}">${elapsedSince(t.startedAt)}</span>
          <button class="btn icon danger card-stop" data-action="stop" title="Stop run" aria-label="Stop run">${icon('square')}</button>
        </div>`;
    } else if (t.durationMs != null) {
      statusRow = `<div class="card-status">last run ${fmtDuration(t.durationMs)} · ${t.numTurns ?? '?'} turns</div>`;
    }

    el.innerHTML = `
      <div class="card-title">${esc(t.title)}</div>
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

  // Tick elapsed timers without re-rendering the whole board.
  setInterval(() => {
    document.querySelectorAll('.elapsed[data-start]').forEach((el) => {
      el.textContent = elapsedSince(el.dataset.start);
    });
  }, 1000);

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
      } else if (colKey === 'done' && t.status !== 'running') {
        await moveToDone(t);
      } else if (t.status !== 'running') {
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
    // Look it up fresh (the cached value may be stale or absent) so the prompt
    // reflects the PR's real state at the moment of the move.
    if (t.branch) {
      let res = state.prByTask.get(t.id);
      if (!res || res === 'loading') {
        try {
          res = await api('GET', `/api/tasks/${t.id}/pr`);
          state.prByTask.set(t.id, res);
        } catch { res = null; }
      }
      if (res && res.pr && res.pr.state !== 'merged') {
        options.push({
          id: 'merge-pr',
          label: `Merge PR #${res.pr.number}`,
          hint: res.pr.title || '',
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
  let doneModalCtx = null;
  function openDoneModal(t, options) {
    doneModalCtx = { task: t, options };
    $('#done-modal-sub').textContent =
      `“${t.title}” — choose any wrap-up steps to run, then it moves to Done.`;
    $('#done-modal-options').innerHTML = options.map((o) =>
      `<label class="done-option">` +
      `<input type="checkbox" data-done-opt="${esc(o.id)}" />` +
      `<span class="done-option-text"><span class="done-option-label">${esc(o.label)}</span>` +
      (o.hint ? `<span class="done-option-hint">${esc(o.hint)}</span>` : '') +
      `</span></label>`,
    ).join('');
    $('#done-modal-confirm').disabled = false;
    $('#modal-done').classList.remove('hidden');
  }

  $('#done-modal-cancel').addEventListener('click', () => {
    $('#modal-done').classList.add('hidden');
    doneModalCtx = null;
  });
  $('#done-modal-confirm').addEventListener('click', async () => {
    if (!doneModalCtx) return;
    const { task, options } = doneModalCtx;
    const checked = new Set(
      [...document.querySelectorAll('#done-modal-options input[data-done-opt]:checked')]
        .map((el) => el.dataset.doneOpt),
    );
    const btn = $('#done-modal-confirm');
    btn.disabled = true;
    try {
      // Merge first: worktree removal below would take away the dir `gh` runs in.
      if (checked.has('merge-pr') && options.some((o) => o.id === 'merge-pr')) {
        await api('POST', `/api/tasks/${task.id}/pr/merge`);
        state.prByTask.delete(task.id); // force a fresh PR status next render
        toast('Pull request merged', 'info');
      }
      if (checked.has('delete-worktree') && options.some((o) => o.id === 'delete-worktree')) {
        await api('POST', `/api/tasks/${task.id}/worktree/remove`);
        toast('Worktree removed', 'info');
      }
      await api('PATCH', `/api/tasks/${task.id}`, { status: 'done' });
      $('#modal-done').classList.add('hidden');
      doneModalCtx = null;
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
    }
  });

  async function stopTask(id) {
    try { await api('POST', `/api/tasks/${id}/stop`); } catch (e) { toast(e.message); }
  }

  // ---------- drawer / timeline ----------
  const timeline = {
    toolRows: new Map(),   // tool_use_id -> tool row element
    subagents: new Map(),  // Task tool_use_id -> { group, body, head }
  };

  async function openDrawer(taskId) {
    state.openTaskId = taskId;
    state.openGroomingId = null;
    $('#drawer').classList.remove('hidden');
    $('#drawer-overlay').classList.remove('hidden');
    $('#timeline').innerHTML = '<div class="ev-meta">loading session…</div>';
    timeline.toolRows.clear();
    timeline.subagents.clear();

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
    $('#drawer').classList.remove('hidden');
    $('#drawer-overlay').classList.remove('hidden');
    $('#timeline').innerHTML = '<div class="ev-meta">loading session…</div>';
    timeline.toolRows.clear();
    timeline.subagents.clear();
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

  function closeDrawer() {
    state.openTaskId = null;
    state.openGroomingId = null;
    $('#drawer').classList.add('hidden');
    $('#drawer-overlay').classList.add('hidden');
    renderPermissionPrompts(null);
  }

  // ---------- interactive permission prompts ----------

  // Render the pending tool-approval prompts for the drawer's task. Each shows the
  // requested tool + input and Allow/Deny buttons that resolve the waiting run.
  function renderPermissionPrompts(taskId) {
    const box = $('#permission-prompts');
    if (!box) return;
    const task = taskId ? state.tasks.get(taskId) : null;
    const live = !!(task && isLive(task));
    const list = taskId ? pendingPermissions(taskId) : [];
    // The AUTO MODE toggle only makes sense when the run asks before each tool,
    // i.e. its permission mode is "Accept edits" — 'bypassPermissions' never
    // prompts, and 'plan'/'default' aren't the accept-edits flow we auto-approve.
    const canAuto = live && task.permissionMode === 'acceptEdits';
    // The box carries that toggle plus the pending prompts. Nothing to show for a
    // task that can't auto-approve and has no prompts.
    if (!canAuto && !list.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    const auto = isAutoApprove(taskId);
    const toggle = canAuto ? `
      <div class="perm-auto ${auto ? 'on' : ''}">
        <div class="perm-auto-label">
          ${icon(auto ? 'zap' : 'shield')}
          <span>${auto ? 'Auto-approve is on — every tool runs without asking' : 'Ask before each tool'}</span>
        </div>
        <button class="btn ${auto ? 'ghost' : 'primary'}" data-auto="${auto ? 'off' : 'on'}" title="Shift+Tab">
          ${auto ? 'Turn off auto' : 'Auto-approve all'}
        </button>
      </div>` : '';
    const prompts = list.map((r) => {
      const summary = toolInputSummary(r.toolName, r.input || {});
      return `
        <div class="perm-prompt" data-req="${esc(r.id)}">
          <div class="perm-head">${icon('shield')} <span>Approve <code>${esc(r.toolName)}</code>?</span></div>
          ${summary ? `<pre class="perm-summary">${esc(String(summary).slice(0, 400))}</pre>` : ''}
          <div class="perm-actions">
            <button class="btn ghost danger" data-perm="deny" data-req="${esc(r.id)}">Deny</button>
            <button class="btn primary" data-perm="allow" data-req="${esc(r.id)}">Allow</button>
          </div>
        </div>`;
    }).join('');
    box.innerHTML = toggle + prompts;
  }

  // Flip the open task's auto-approve mode. The server broadcasts the new state,
  // which re-renders the toggle; we optimistically set it so the button responds.
  async function toggleAutoApprove(taskId, on) {
    if (!taskId) return;
    const task = state.tasks.get(taskId);
    if (!task || !isLive(task)) return;
    setAutoApproveLocal(taskId, on);
    renderPermissionPrompts(taskId);
    renderBoard();
    try {
      await api('POST', `/api/tasks/${taskId}/auto-approve`, { auto: on });
    } catch (e) { toast(e.message); }
  }

  async function decidePermission(taskId, reqId, behavior) {
    // Optimistically clear it locally so the buttons can't be double-clicked.
    setPendingPermissions(taskId, pendingPermissions(taskId).filter((r) => r.id !== reqId));
    renderPermissionPrompts(state.openTaskId);
    renderBoard();
    try {
      await api('POST', `/api/tasks/${taskId}/permissions/${reqId}`, { behavior });
    } catch (e) { toast(e.message); }
  }

  // One delegated handler for every Allow/Deny button and the AUTO MODE toggle.
  $('#permission-prompts').addEventListener('click', (e) => {
    if (!state.openTaskId) return;
    const autoBtn = e.target.closest('[data-auto]');
    if (autoBtn) { toggleAutoApprove(state.openTaskId, autoBtn.dataset.auto === 'on'); return; }
    const btn = e.target.closest('[data-perm]');
    if (btn) decidePermission(state.openTaskId, btn.dataset.req, btn.dataset.perm);
  });

  // Shift+Tab, while a live task's drawer is open, toggles AUTO MODE — mirrors the
  // Claude Code shortcut. Ignored while typing so it can't fire from an input.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || !e.shiftKey) return;
    if (!state.openTaskId) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    const task = state.tasks.get(state.openTaskId);
    // Only the "Accept edits" flow exposes AUTO MODE — match renderPermissionPrompts.
    if (!task || !isLive(task) || task.permissionMode !== 'acceptEdits') return;
    e.preventDefault();
    toggleAutoApprove(state.openTaskId, !isAutoApprove(state.openTaskId));
  });

  // Live permission-prompt updates from the server: a new request appears, or an
  // existing one is resolved (by anyone, or by the run ending).
  function applyPermissionEvent(msg) {
    const list = pendingPermissions(msg.taskId);
    if (msg.action === 'request') {
      const isNew = !list.some((r) => r.id === msg.request.id);
      if (isNew) setPendingPermissions(msg.taskId, [...list, msg.request]);
      // The run is blocked until answered, so notify even under Electron — the tray
      // shell only surfaces task lifecycle, not permission prompts.
      if (isNew && notificationsOn()) maybeNotifyPermission(msg);
      if (isNew) playSound('permission');
    } else if (msg.action === 'resolved') {
      setPendingPermissions(msg.taskId, list.filter((r) => r.id !== msg.requestId));
    } else if (msg.action === 'auto') {
      setAutoApproveLocal(msg.taskId, !!msg.auto);
    }
    if (state.openTaskId === msg.taskId) renderPermissionPrompts(msg.taskId);
    renderBoard();
  }

  // Nudge the user that a run is blocked waiting on them — it can't proceed alone.
  function maybeNotifyPermission(msg) {
    const t = state.tasks.get(msg.taskId);
    const title = t ? t.title : 'A task';
    showBrowserNotification('Approval needed', {
      body: `${title} wants to run ${msg.request.toolName}`,
      tag: `srpopo-perm-${msg.taskId}`,
    });
  }

  // The per-task action set shared by the drawer's action row and the card's
  // right-click menu, so the two can never drift out of sync. Each action owns
  // its label/icon/class plus the async handler that performs it.
  function taskCoreActions(t) {
    const actions = [];
    if (isLive(t)) {
      actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
        run: () => api('POST', `/api/tasks/${t.id}/stop`) });
    } else {
      if (t.status === 'backlog' || t.status === 'ready') {
        actions.push({ id: 'dispatch', label: 'Run', icon: 'play', cls: 'primary',
          run: () => api('POST', `/api/tasks/${t.id}/dispatch`) });
      }
      actions.push({ id: 'edit', label: 'Edit', icon: 'pencil', cls: 'ghost',
        run: () => { openTaskModal(t); } });
      actions.push({ id: 'archive', label: 'Archive', cls: 'ghost',
        run: async () => {
          await api('POST', `/api/tasks/${t.id}/archive`);
          if (state.openTaskId === t.id) closeDrawer();
        } });
    }
    if (t.worktreePath) {
      actions.push({ id: 'copy-wt', label: 'Copy worktree path', cls: 'ghost', title: t.worktreePath,
        run: async () => { await navigator.clipboard.writeText(t.worktreePath); toast('Worktree path copied', 'info'); } });
      if (!isLive(t)) {
        actions.push({ id: 'rm-wt', label: 'Remove worktree', cls: 'ghost danger',
          run: async () => { await api('POST', `/api/tasks/${t.id}/worktree/remove`); toast('Worktree removed', 'info'); } });
      }
    }
    return actions;
  }

  // Adds the two actions only reachable via drag-and-drop today (dropping a
  // finished card on Running/Done) so the context menu offers them directly.
  function taskContextMenuActions(t) {
    const actions = taskCoreActions(t);
    if (!isLive(t) && t.sessionId) {
      actions.push({ id: 'followup', label: 'Follow-up', icon: 'play', cls: 'ghost',
        run: () => { openFollowupModal(t); } });
    }
    if (!isLive(t) && t.status !== 'done') {
      actions.push({ id: 'move-done', label: 'Move to Done', icon: 'check', cls: 'ghost',
        run: () => moveToDone(t) });
    }
    return actions;
  }

  // The per-grooming action set shared by the drawer's action row and the
  // card's right-click menu — mirrors taskCoreActions for grooming cards.
  function groomingCoreActions(g) {
    const actions = [];
    if (isGroomingLive(g)) {
      actions.push({ id: 'stop', label: 'Stop', icon: 'square', cls: 'danger',
        run: () => api('POST', `/api/groomings/${g.id}/stop`) });
      return actions;
    }
    if (g.status === 'draft' || g.status === 'failed') {
      actions.push({ id: 'groom', label: 'Groom', icon: 'sparkles', cls: 'primary',
        run: () => api('POST', `/api/groomings/${g.id}/run`) });
      actions.push({ id: 'edit', label: 'Edit', icon: 'pencil', cls: 'ghost',
        run: () => { openBriefModal(g); } });
    }
    // An awaiting card answers via the drawer form; the action here is the escape
    // hatch to discard the questions and groom the idea again from scratch.
    if (g.status === 'awaiting') {
      actions.push({ id: 'regroom', label: 'Start over', icon: 'rotate-cw', cls: 'ghost',
        run: () => api('POST', `/api/groomings/${g.id}/run`) });
    }
    actions.push({ id: 'archive', label: 'Archive', cls: 'ghost',
      run: async () => {
        await api('POST', `/api/groomings/${g.id}/archive`);
        if (state.openGroomingId === g.id) closeDrawer();
      } });
    actions.push({ id: 'delete', label: 'Delete', icon: 'trash', cls: 'ghost danger',
      run: async () => {
        if (!confirm(`Delete grooming “${g.title}”?\n\nThis removes the card and its session log. Tasks it spawned are kept.`)) return;
        await api('DELETE', `/api/groomings/${g.id}`);
        if (state.openGroomingId === g.id) closeDrawer();
      } });
    return actions;
  }

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

  // Click anywhere outside the menu, or right-click elsewhere, closes it — only
  // one context menu is ever open at a time.
  document.addEventListener('click', (e) => {
    if (!$('#context-menu').classList.contains('hidden') && !e.target.closest('#context-menu')) closeContextMenu();
  });
  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.card')) closeContextMenu();
  });

  function renderDrawerHead(t) {
    $('#drawer-title').textContent = t.title;
    const meta = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model${modelClass(t.resolvedModel || t.model)}">${esc(t.resolvedModel || t.model)}</span>`,
      `<span class="chip">${esc(t.permissionMode)}</span>`,
    ];
    if (t.promptPermissions) meta.push(`<span class="chip" title="Asks you to approve otherwise-denied tools">${icon('shield')} asks</span>`);
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
    if (t.costUsd > 0) meta.push(`<span class="chip cost">$${t.costUsd.toFixed(2)} total</span>`);
    if (t.numTurns != null) meta.push(`<span class="chip">${t.numTurns} turns</span>`);
    if (t.branch) meta.push(prChipHtml(t)); // GitHub PR for this branch, if any
    const metaEl = $('#drawer-meta');
    metaEl.innerHTML = meta.join('');
    // A branch's PR status can be re-checked on demand from the refresh affordance.
    metaEl.onclick = (e) => {
      if (e.target.closest('[data-act="refresh-pr"]')) { e.preventDefault(); refreshPr(t.id, true); }
    };

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
          <span>${esc(opt)}</span>
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
        <div class="groom-q" data-qi="${i}">
          <div class="groom-q-text">${i + 1}. ${esc(q.question)}</div>
          <div class="groom-q-options">${opts}${text}</div>
        </div>`;
    }).join('');
    return `
      <div class="tag">CLARIFY</div>
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

    const promptEl = $('#drawer-prompt');
    const blocks = [`<div class="tag">IDEA</div><div class="drawer-prompt-body md">${mdToHtml(g.idea)}</div>`];
    if (g.status === 'awaiting' && (g.questions || []).length) {
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
    promptEl.innerHTML = blocks.join('');
    promptEl.onclick = (e) => {
      const link = e.target.closest('[data-task-link]');
      if (link && !link.disabled) openDrawer(link.dataset.taskLink);
    };
    const answersForm = promptEl.querySelector('#groom-answers-form');
    if (answersForm) {
      answersForm.onsubmit = (e) => { e.preventDefault(); submitGroomingAnswers(g); };
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

  // ---------- GitHub PR chip ----------

  // Subtle, non-alarming hints for the reasons a lookup can't produce a PR link.
  // 'no-pr'/'no-branch' render nothing; the rest show a quiet muted chip.
  const PR_HINTS = {
    'gh-missing': 'GitHub CLI (gh) not found on PATH',
    'not-authed': 'Not logged in to GitHub — run `gh auth login`',
    'not-github': "This branch's remote isn't a GitHub repository",
    error: "Couldn't look up the pull request",
  };

  // Render the PR chip for a task from the cached /api/tasks/:id/pr result.
  // Only called when the task has a branch.
  function prChipHtml(t) {
    const refresh = `<button class="pr-refresh" data-act="refresh-pr" title="Refresh PR status" aria-label="Refresh PR status">${icon('rotate-cw')}</button>`;
    const res = state.prByTask.get(t.id);
    if (res === undefined || res === 'loading') {
      return `<span class="chip pr pr-muted" title="Looking up pull request…">PR …</span>`;
    }
    if (res.pr) {
      const pr = res.pr;
      const st = pr.isDraft && pr.state === 'open' ? 'draft' : (pr.state || 'open');
      const title = pr.title ? `${pr.title} — ${st}` : `PR #${pr.number} — ${st}`;
      return (
        `<a class="chip pr pr-${esc(st)}" href="${esc(pr.url)}" target="_blank" rel="noopener" title="${esc(title)}">` +
        `<span class="pr-dot"></span>PR #${esc(pr.number)} · ${esc(st)}</a>` +
        refresh
      );
    }
    // No PR (or no branch resolved yet) — stay quiet; only hint on real failures.
    if (res.reason === 'no-pr' || res.reason === 'no-branch') return '';
    const hint = PR_HINTS[res.reason] || PR_HINTS.error;
    return `<span class="chip pr pr-muted" title="${esc(hint)}">no PR</span>` + refresh;
  }

  // Fetch (or re-fetch) the PR for a task and re-render the drawer head if it's
  // still the open task. Skips the network when a result is already cached unless
  // forced (e.g. from the refresh affordance or a fresh drawer open).
  async function refreshPr(taskId, force) {
    const task = state.tasks.get(taskId);
    if (!task || !task.branch) return;
    if (!force && state.prByTask.has(taskId)) return;
    state.prByTask.set(taskId, 'loading');
    if (state.openTaskId === taskId) renderDrawerHead(task);
    let res;
    try {
      res = await api('GET', `/api/tasks/${taskId}/pr`);
    } catch {
      res = { pr: null, reason: 'error' };
    }
    state.prByTask.set(taskId, res);
    if (state.openTaskId === taskId) renderDrawerHead(state.tasks.get(taskId) || task);
  }

  // For a task that runs directly against the repo (no worktree), show the
  // repo's live current branch — that's whatever branch the run will actually
  // affect, and it can drift from the snapshot taken when the repo was added.
  function repoBranchChipHtml(t) {
    const res = state.repoBranchByTask.get(t.id);
    if (res === undefined || res === 'loading') {
      return `<span class="chip" title="Looking up the repo's current branch…">branch …</span>`;
    }
    if (!res) return '';
    return `<span class="chip" title="This task runs directly on the repo's checked-out branch">${icon('git-branch')} ${esc(res)}</span>`;
  }

  async function refreshRepoBranchForTask(taskId) {
    const task = state.tasks.get(taskId);
    if (!task || task.useWorktree) return;
    state.repoBranchByTask.set(taskId, 'loading');
    if (state.openTaskId === taskId) renderDrawerHead(task);
    let branch = null;
    try { ({ branch } = await api('GET', `/api/repos/${task.repoId}/branch`)); } catch { /* stays null */ }
    state.repoBranchByTask.set(taskId, branch);
    if (state.openTaskId === taskId) renderDrawerHead(state.tasks.get(taskId) || task);
  }

  function scrollTimeline() {
    const tl = $('#timeline');
    tl.scrollTop = tl.scrollHeight;
  }

  // Where should this event be appended? Subagent output nests in its group.
  function containerFor(ev) {
    const parent = ev.parent_tool_use_id;
    if (parent && timeline.subagents.has(parent)) return timeline.subagents.get(parent).body;
    return $('#timeline');
  }

  function toolInputSummary(name, input = {}) {
    switch (name) {
      case 'Bash': return input.command || input.description || '';
      case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return input.file_path || '';
      case 'Glob': case 'Grep': return input.pattern || '';
      case 'WebFetch': return input.url || '';
      case 'WebSearch': return input.query || '';
      case 'Task': return `${input.description || ''} (${input.subagent_type || 'agent'})`;
      case 'TodoWrite': return `${(input.todos || []).length} todos`;
      default: {
        const v = Object.values(input).find((x) => typeof x === 'string');
        return v ? v.slice(0, 120) : JSON.stringify(input).slice(0, 120);
      }
    }
  }

  function appendEvent(ev) {
    const type = ev.type;
    if (type === 'prompt') {
      const tag = ev.groom ? 'GROOMING' : ev.resume ? 'FOLLOW-UP' : 'PROMPT';
      addHtml(containerFor(ev), `
        <div class="ev-prompt">
          <span class="tag">${tag} · run ${ev.run || 1}</span>${esc(ev.text)}
        </div>`);
    } else if (type === 'system' && ev.subtype === 'init') {
      addHtml(containerFor(ev), `<div class="ev-meta">${icon('zap')} session started · ${esc(ev.model || '')} · ${esc((ev.session_id || '').slice(0, 8))}</div>`);
    } else if (type === 'assistant') {
      const blocks = (ev.message && ev.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          addHtml(containerFor(ev), `<div class="ev-text md">${mdToHtml(b.text)}</div>`);
        } else if (b.type === 'thinking' && b.thinking) {
          addHtml(containerFor(ev), `
            <details class="ev-thinking"><summary>${icon('brain')} thinking</summary><pre>${esc(b.thinking)}</pre></details>`);
        } else if (b.type === 'tool_use') {
          appendToolUse(ev, b);
        }
      }
    } else if (type === 'user') {
      const blocks = (ev.message && ev.message.content);
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_result') attachToolResult(b);
        }
      }
    } else if (type === 'result') {
      const cls = ev.is_error ? 'error' : '';
      const resIcon = ev.is_error ? icon('circle-x') : icon('circle-check');
      const text = typeof ev.result === 'string' ? ev.result : (ev.subtype || '');
      addHtml($('#timeline'), `
        <div class="ev-result ${cls}">
          ${resIcon} <span class="md">${mdToHtml(String(text).slice(0, 600))}</span>
          <div class="stats">${fmtDuration(ev.duration_ms)} · ${ev.num_turns ?? '?'} turns · $${(ev.total_cost_usd || 0).toFixed(2)}</div>
        </div>`);
    } else if (type === 'stderr') {
      addHtml($('#timeline'), `<div class="ev-stderr">${esc(ev.text)}</div>`);
    } else if (type === 'proc') {
      addHtml($('#timeline'), `<div class="ev-meta">${icon('square')} ${esc(ev.text)}</div>`);
    } else if (type === 'permission') {
      const allowed = ev.decision && ev.decision.behavior === 'allow';
      const auto = ev.reason === 'auto';
      const verb = allowed ? (auto ? 'Auto-approved' : 'Allowed') : 'Denied';
      const why = !allowed && ev.decision && ev.decision.message ? ` — ${ev.decision.message}` : '';
      addHtml($('#timeline'), `<div class="ev-meta perm-log ${allowed ? 'ok' : 'no'}">${icon(auto ? 'zap' : 'shield')} ${verb} ${esc(ev.toolName || 'tool')}${esc(why)}</div>`);
    } else if (type === 'raw') {
      addHtml($('#timeline'), `<div class="ev-stderr">${esc(ev.text)}</div>`);
    }
  }

  function appendToolUse(ev, block) {
    const container = containerFor(ev);
    const isSubagent = block.name === 'Task' && !ev.parent_tool_use_id;

    if (isSubagent) {
      const group = document.createElement('div');
      group.className = 'subagent-group';
      group.innerHTML = `
        <div class="subagent-head">${icon('bot')} ${esc(block.input?.description || 'subagent')}
          <span class="chip">${esc(block.input?.subagent_type || 'agent')}</span>
          <span class="status">running…</span>
        </div>
        <div class="subagent-body"></div>`;
      container.appendChild(group);
      timeline.subagents.set(block.id, {
        group, body: group.querySelector('.subagent-body'),
        head: group.querySelector('.status'),
      });
      // The Task prompt is useful context — show it collapsed inside the group.
      addHtml(group.querySelector('.subagent-body'), `
        <details class="ev-thinking"><summary>subagent prompt</summary><pre>${esc(block.input?.prompt || '')}</pre></details>`);
      scrollTimeline();
      return;
    }

    const row = document.createElement('details');
    row.className = 'ev-tool';
    row.innerHTML = `
      <summary>
        <span class="tool-name">${esc(block.name)}</span>
        <span class="tool-summary">${esc(toolInputSummary(block.name, block.input))}</span>
        <span class="tool-state">${icon('loader', { spin: true })}</span>
      </summary>
      <div class="tool-detail">
        <div class="result-label">input</div>
        <pre>${esc(JSON.stringify(block.input, null, 2))}</pre>
        <div class="result-slot"></div>
      </div>`;
    container.appendChild(row);
    timeline.toolRows.set(block.id, row);
    scrollTimeline();
  }

  function attachToolResult(block) {
    // Subagent finished?
    if (timeline.subagents.has(block.tool_use_id)) {
      const sa = timeline.subagents.get(block.tool_use_id);
      sa.head.innerHTML = block.is_error ? `${icon('circle-x')} failed` : `${icon('circle-check')} done`;
      sa.group.style.borderStyle = 'solid';
      const text = extractResultText(block);
      if (text) {
        addHtml(sa.body, `
          <details class="ev-tool" open><summary><span class="tool-name">result</span></summary>
          <div class="tool-detail"><pre>${esc(text.slice(0, 4000))}</pre></div></details>`);
      }
      return;
    }
    const row = timeline.toolRows.get(block.tool_use_id);
    if (!row) return;
    row.querySelector('.tool-state').innerHTML = block.is_error ? icon('circle-x') : icon('circle-check');
    const slot = row.querySelector('.result-slot');
    const text = extractResultText(block);
    slot.innerHTML = `<div class="result-label">${block.is_error ? 'error' : 'result'}</div><pre>${esc((text || '(empty)').slice(0, 4000))}</pre>`;
  }

  function extractResultText(block) {
    const c = block.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    return '';
  }

  function addHtml(container, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    container.appendChild(tpl.content);
    scrollTimeline();
  }

  // ---------- follow-up ----------
  async function sendFollowup(taskId, message) {
    if (!message.trim()) return;
    await api('POST', `/api/tasks/${taskId}/dispatch`, { message });
  }

  $('#followup-send').addEventListener('click', async () => {
    const input = $('#followup-input');
    try {
      await sendFollowup(state.openTaskId, input.value);
      input.value = '';
    } catch (e) { toast(e.message); }
  });
  $('#followup-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#followup-send').click();
  });

  let followupTarget = null;
  function openFollowupModal(t) {
    followupTarget = t;
    $('#followup-modal-sub').textContent = `“${t.title}” already has a session — describe what to do next and it will resume where it left off.`;
    $('#followup-modal-input').value = '';
    $('#modal-followup').classList.remove('hidden');
    $('#followup-modal-input').focus();
  }
  $('#followup-modal-cancel').addEventListener('click', () => $('#modal-followup').classList.add('hidden'));
  $('#followup-modal-send').addEventListener('click', async () => {
    try {
      await sendFollowup(followupTarget.id, $('#followup-modal-input').value);
      $('#modal-followup').classList.add('hidden');
    } catch (e) { toast(e.message); }
  });
  $('#followup-modal-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#followup-modal-send').click();
  });

  // ---------- new task modal ----------
  function refreshRepoSelect() {
    const sel = $('#task-repo');
    sel.innerHTML = state.repos.length
      ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
      : '<option value="">No repos yet — add one first</option>';
  }

  // Show the repo's live current branch (not the stale snapshot taken when it
  // was added) next to a repo <select>, so the user knows what a non-worktree
  // task would run against. `hintEl` is a <span> updated in place; a repo with
  // no branch (detached HEAD, lookup failure) clears the hint quietly.
  async function refreshRepoBranchHint(repoId, hintEl) {
    if (!repoId) { hintEl.textContent = ''; return; }
    try {
      const { branch } = await api('GET', `/api/repos/${repoId}/branch`);
      hintEl.textContent = branch ? `Repo is currently on ${branch}` : '';
    } catch {
      hintEl.textContent = '';
    }
  }

  // Populate the base-branch <select> for a repo: every local branch, with the
  // one currently checked out flagged. The picker defaults to `selected` (a task's
  // stored baseBranch) or the current branch. `dataset.current` remembers the live
  // branch so saveTask can tell "left on the default" from an explicit pick.
  async function refreshBaseBranchPicker(repoId, selectEl, selected) {
    selectEl.dataset.current = '';
    if (!repoId) { selectEl.innerHTML = ''; selectEl.disabled = true; return; }
    selectEl.disabled = true;
    selectEl.innerHTML = '<option>Loading…</option>';
    let current = null, branches = [];
    try { ({ current, branches } = await api('GET', `/api/repos/${repoId}/branches`)); } catch { /* leave empty */ }
    // Guard against a racing repo switch that already moved on to another repo.
    if ($('#task-repo').value && $('#task-repo').value !== repoId && !editingTaskId) return;
    if (current && !branches.includes(current)) branches = [current, ...branches];
    const want = (selected && branches.includes(selected)) ? selected : current;
    selectEl.dataset.current = current || '';
    selectEl.innerHTML = branches.length
      ? branches.map((b) => `<option value="${esc(b)}"${b === want ? ' selected' : ''}>${esc(b)}${b === current ? ' (current)' : ''}</option>`).join('')
      : '<option value="">No branches</option>';
    selectEl.disabled = !branches.length;
  }

  // Optional task behaviors — checkboxes derived from the /api/addons catalog.
  // These render below the worktree toggle inside the "Extra behavior" section.
  // The `pull_request` addon gets an extra sibling control (like the branch-name
  // field under the worktree toggle) so both PR modes — ready for review or
  // draft — are one click away instead of needing a second setting elsewhere.
  function renderAddonOptions(selected = [], prDraft = false) {
    const chosen = new Set(selected);
    $('#task-addon-list').innerHTML = state.addons.map((a) => {
      const checked = chosen.has(a.id);
      const prMode = a.id !== 'pull_request' ? '' : `
        <div class="pr-mode ${checked ? '' : 'pr-mode-disabled'}" role="radiogroup" aria-label="Pull request mode">
          <label class="pr-mode-option">
            <input type="radio" name="task-pr-mode" value="ready" ${prDraft ? '' : 'checked'} ${checked ? '' : 'disabled'} />
            Ready for review
          </label>
          <label class="pr-mode-option">
            <input type="radio" name="task-pr-mode" value="draft" ${prDraft ? 'checked' : ''} ${checked ? '' : 'disabled'} />
            Draft
          </label>
        </div>`;
      return `
      <label class="check addon">
        <input type="checkbox" data-addon="${esc(a.id)}" ${checked ? 'checked' : ''} />
        <span class="addon-text">
          <span class="addon-label">${esc(a.label)}</span>
          ${a.hint ? `<span class="addon-hint">${esc(a.hint)}</span>` : ''}
        </span>
      </label>${prMode}`;
    }).join('');
    // Enable/disable the ready-vs-draft radios as the PR checkbox is toggled —
    // the choice only means something once "Create a Pull Request" is checked.
    const prCheckbox = document.querySelector('#task-addon-list input[data-addon="pull_request"]');
    const prModeEl = document.querySelector('#task-addon-list .pr-mode');
    if (prCheckbox && prModeEl) {
      prCheckbox.addEventListener('change', () => {
        prModeEl.classList.toggle('pr-mode-disabled', !prCheckbox.checked);
        prModeEl.querySelectorAll('input').forEach((r) => { r.disabled = !prCheckbox.checked; });
      });
    }
  }

  function selectedAddons() {
    return [...document.querySelectorAll('#task-addons input[data-addon]:checked')]
      .map((el) => el.dataset.addon);
  }

  // Whether the "draft" radio is picked for the pull_request addon's PR mode.
  // Meaningless (and ignored server-side) unless that addon is also selected.
  function selectedPrDraft() {
    const el = document.querySelector('input[name="task-pr-mode"][value="draft"]');
    return !!(el && el.checked);
  }

  // The chosen base branch, but only when it differs from the repo's current
  // branch — leaving the picker on the default keeps the historical behavior
  // (worktree cut from HEAD at dispatch), so we send an empty value there.
  function selectedBaseBranch() {
    const sel = $('#task-base-branch');
    const val = sel.value.trim();
    return val && val !== (sel.dataset.current || '') ? val : '';
  }

  // Expert personas — a compact, Claude-style multi-select instead of a wall of
  // checkboxes. Selected personas show as removable chips; more are added from a
  // searchable, keyboard-navigable popover. A selected persona is prepended to
  // the prompt as a role preamble at dispatch.
  const personaPicker = {
    selected: new Set(), // chosen persona ids
    activeIndex: 0,      // highlighted option within the currently filtered list
  };

  // Seed the picker when the modal opens (create or edit); keep only known ids.
  function initPersonaPicker(selected = []) {
    const known = new Set(state.personas.map((p) => p.id));
    personaPicker.selected = new Set(selected.filter((id) => known.has(id)));
    closePersonaMenu();
    renderPersonaChips();
  }

  // Selected ids in catalog order — matches how the server sanitizes them.
  function selectedPersonas() {
    return state.personas.filter((p) => personaPicker.selected.has(p.id)).map((p) => p.id);
  }

  function renderPersonaChips() {
    const box = $('#task-persona-chips');
    const ids = selectedPersonas();
    if (!ids.length) {
      box.innerHTML = '<span class="persona-empty">No persona — Claude works as itself.</span>';
      return;
    }
    box.innerHTML = ids.map((id) => {
      const p = state.personas.find((x) => x.id === id);
      const label = p ? p.label : id;
      return `<span class="persona-tag" role="listitem">
          <span class="persona-tag-label">${icon('persona')} ${esc(label)}</span>
          <button type="button" class="persona-tag-x" data-remove="${esc(id)}"
                  title="Remove ${esc(label)}" aria-label="Remove ${esc(label)}">${icon('x')}</button>
        </span>`;
    }).join('');
  }

  function personaMenuOpen() {
    return !$('#task-persona-menu').classList.contains('hidden');
  }

  // Catalog filtered by the search box (matches label or hint).
  function visiblePersonas() {
    const q = $('#task-persona-search').value.trim().toLowerCase();
    if (!q) return state.personas;
    return state.personas.filter((p) =>
      p.label.toLowerCase().includes(q) || (p.hint || '').toLowerCase().includes(q));
  }

  function renderPersonaMenu() {
    const list = $('#task-persona-options');
    const opts = visiblePersonas();
    if (personaPicker.activeIndex > opts.length - 1) personaPicker.activeIndex = opts.length - 1;
    if (personaPicker.activeIndex < 0) personaPicker.activeIndex = 0;
    // Point the combobox at the highlighted option for screen readers.
    const active = opts[personaPicker.activeIndex];
    $('#task-persona-search').setAttribute('aria-activedescendant', active ? `persona-opt-${active.id}` : '');
    if (!opts.length) {
      list.innerHTML = '<div class="persona-none">No matching persona</div>';
      return;
    }
    list.innerHTML = opts.map((p, i) => {
      const on = personaPicker.selected.has(p.id);
      const active = i === personaPicker.activeIndex;
      return `<div class="persona-option${on ? ' on' : ''}${active ? ' active' : ''}"
          role="option" id="persona-opt-${esc(p.id)}" aria-selected="${on}"
          data-persona="${esc(p.id)}">
          <span class="persona-check" aria-hidden="true">${on ? icon('check') : ''}</span>
          <span class="addon-text">
            <span class="addon-label">${esc(p.label)}</span>
            ${p.hint ? `<span class="addon-hint">${esc(p.hint)}</span>` : ''}
          </span>
        </div>`;
    }).join('');
  }

  function scrollActiveOptionIntoView() {
    const el = $('#task-persona-options').querySelector('.persona-option.active');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }

  function openPersonaMenu() {
    $('#task-persona-menu').classList.remove('hidden');
    $('#task-persona-add').setAttribute('aria-expanded', 'true');
    $('#task-persona-search').value = '';
    personaPicker.activeIndex = 0;
    renderPersonaMenu();
    $('#task-persona-search').focus();
    $('#task-persona-menu').scrollIntoView({ block: 'nearest' });
  }

  function closePersonaMenu() {
    $('#task-persona-menu').classList.add('hidden');
    $('#task-persona-add').setAttribute('aria-expanded', 'false');
  }

  function togglePersona(id) {
    if (personaPicker.selected.has(id)) personaPicker.selected.delete(id);
    else personaPicker.selected.add(id);
    renderPersonaChips();
    renderPersonaMenu();
  }

  // --- persona picker wiring (elements are static, so wire once) ---
  $('#task-persona-add').addEventListener('click', () => {
    if (personaMenuOpen()) { closePersonaMenu(); $('#task-persona-add').focus(); }
    else openPersonaMenu();
  });
  $('#task-persona-chips').addEventListener('click', (e) => {
    const id = e.target.closest('[data-remove]')?.dataset.remove;
    if (id) togglePersona(id);
  });
  $('#task-persona-options').addEventListener('click', (e) => {
    const id = e.target.closest('[data-persona]')?.dataset.persona;
    if (id) { togglePersona(id); $('#task-persona-search').focus(); }
  });
  $('#task-persona-search').addEventListener('input', () => {
    personaPicker.activeIndex = 0;
    renderPersonaMenu();
  });
  $('#task-persona-search').addEventListener('keydown', (e) => {
    const opts = visiblePersonas();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      personaPicker.activeIndex = Math.min(opts.length - 1, personaPicker.activeIndex + 1);
      renderPersonaMenu(); scrollActiveOptionIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      personaPicker.activeIndex = Math.max(0, personaPicker.activeIndex - 1);
      renderPersonaMenu(); scrollActiveOptionIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const p = opts[personaPicker.activeIndex];
      if (p) togglePersona(p.id);
    } else if (e.key === 'Escape') {
      // Close just the menu — don't let the global handler dismiss the modal.
      e.preventDefault(); e.stopPropagation();
      closePersonaMenu(); $('#task-persona-add').focus();
    }
  });
  // Click anywhere outside the picker closes the menu.
  document.addEventListener('click', (e) => {
    if (personaMenuOpen() && !e.target.closest('.persona-picker')) closePersonaMenu();
  });

  // Remember the settings used on the last created task so a new task defaults
  // to them instead of the hardcoded defaults — no need to re-pick every time.
  const LAST_USED_KEY = 'srpopo.lastTaskSettings';
  function loadLastUsed() {
    try { return JSON.parse(localStorage.getItem(LAST_USED_KEY)) || {}; }
    catch { return {}; }
  }
  function saveLastUsed(fields, repoId) {
    try {
      localStorage.setItem(LAST_USED_KEY, JSON.stringify({
        model: fields.model,
        permissionMode: fields.permissionMode,
        allowedTools: fields.allowedTools,
        promptPermissions: fields.promptPermissions,
        useWorktree: fields.useWorktree,
        addons: fields.addons,
        prDraft: fields.prDraft,
        personas: fields.personas,
        repoId,
      }));
    } catch { /* storage unavailable — non-fatal */ }
  }

  // null => create mode; a task => edit that task.
  let editingTaskId = null;
  // Attachments held for the modal: `staged` are File objects not yet uploaded
  // (create mode — uploaded after the task exists); `saved` are Attachment
  // entries already on the server (edit mode — removable via the delete route).
  let stagedFiles = [];
  let savedAttachments = [];

  function renderAttachments() {
    const rows = [];
    savedAttachments.forEach((a) => {
      rows.push(`<div class="attachment-row" data-saved="${esc(a.name)}">` +
        `<span class="i" data-icon="paperclip"></span>` +
        `<span class="attachment-name">${esc(a.name)}</span>` +
        `<span class="attachment-size">${fmtBytes(a.size)}</span>` +
        `<button type="button" class="icon-btn attachment-remove" data-remove-saved="${esc(a.name)}" ` +
        `title="Remove" aria-label="Remove ${esc(a.name)}">${icon('x')}</button></div>`);
    });
    stagedFiles.forEach((f, i) => {
      rows.push(`<div class="attachment-row" data-staged="${i}">` +
        `<span class="i" data-icon="paperclip"></span>` +
        `<span class="attachment-name">${esc(f.name)}</span>` +
        `<span class="attachment-size">${fmtBytes(f.size)}</span>` +
        `<button type="button" class="icon-btn attachment-remove" data-remove-staged="${i}" ` +
        `title="Remove" aria-label="Remove ${esc(f.name)}">${icon('x')}</button></div>`);
    });
    const el = $('#task-attachment-list');
    el.innerHTML = rows.join('');
    if (window.srpopoIcons) window.srpopoIcons.hydrate(el);
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  // Upload one File to a task's attachment route as raw bytes.
  async function uploadAttachment(taskId, file) {
    const res = await fetch(`/api/tasks/${taskId}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload of ${file.name} failed (${res.status})`);
    return data;
  }

  // Add files chosen via the picker or dropped on the zone. In edit mode they
  // upload immediately; in create mode they stage until the task is created.
  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (editingTaskId) {
      try {
        let task;
        for (const f of files) task = await uploadAttachment(editingTaskId, f);
        if (task) {
          state.tasks.set(task.id, task);
          renderBoard();
          savedAttachments = task.attachments || [];
          renderAttachments();
        }
      } catch (e) { toast(e.message); }
    } else {
      stagedFiles.push(...files);
      renderAttachments();
    }
  }

  function openTaskModal(task = null) {
    editingTaskId = task ? task.id : null;
    stagedFiles = [];
    savedAttachments = task ? (task.attachments || []).slice() : [];
    renderAttachments();
    // In create mode, seed the form from the last task the user created.
    const last = task ? {} : loadLastUsed();
    refreshRepoSelect();
    $('#task-title').value = task ? task.title : '';
    $('#task-prompt').value = task ? task.prompt : '';
    $('#task-model').value = task ? (task.model || 'default') : (last.model || 'default');
    $('#task-perm').value = task ? (task.permissionMode || 'acceptEdits') : (last.permissionMode || 'acceptEdits');
    $('#task-allowed-tools').value = task ? (task.allowedTools || '') : (last.allowedTools || '');
    $('#task-prompt-permissions').checked = task
      ? (task.promptPermissions !== false)
      : (last.promptPermissions ?? true);
    $('#task-worktree').checked = task ? !!task.useWorktree : (last.useWorktree ?? true);
    // A materialized worktree can't be toggled off; the repo can't move after creation.
    $('#task-worktree').disabled = !!(task && task.worktreePath);
    $('#task-branch').value = task ? (task.branchName || '') : '';
    // The branch is fixed once the worktree is materialized.
    $('#task-branch').disabled = !!(task && task.worktreePath);
    renderAddonOptions(task ? (task.addons || []) : (last.addons || []), task ? !!task.prDraft : !!last.prDraft);
    initPersonaPicker(task ? (task.personas || []) : (last.personas || []));
    $('#task-repo-field').classList.toggle('hidden', !!task);
    if (task) $('#task-repo').value = task.repoId;
    else if (currentWorkspaceRepoId()) $('#task-repo').value = currentWorkspaceRepoId();
    // Restore the last-used repo if it still exists in the current list.
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#task-repo').value = last.repoId;
    refreshRepoBranchHint($('#task-repo').value, $('#task-repo-branch'));
    // The base branch is fixed once the worktree is materialized.
    const baseLocked = !!(task && task.worktreePath);
    $('#task-new-branch').disabled = baseLocked;
    refreshBaseBranchPicker($('#task-repo').value, $('#task-base-branch'), task ? task.baseBranch : null)
      .then(() => { if (baseLocked) $('#task-base-branch').disabled = true; });

    $('#task-modal-title').textContent = task ? 'Edit Task' : 'New Task';
    $('#task-create').textContent = task ? 'Save' : 'Create in Backlog';
    $('#task-create-run').innerHTML = `${task ? 'Save & Run' : 'Create & Run'} ${icon('play')}`;

    $('#modal-task').classList.remove('hidden');
    $('#task-title').focus();
  }

  async function saveTask(run) {
    const title = $('#task-title').value.trim();
    const prompt = $('#task-prompt').value.trim();
    if (!title || !prompt) { toast('Title and prompt are required'); return; }
    const fields = {
      title,
      prompt,
      model: $('#task-model').value,
      permissionMode: $('#task-perm').value,
      allowedTools: $('#task-allowed-tools').value,
      promptPermissions: $('#task-prompt-permissions').checked,
      useWorktree: $('#task-worktree').checked,
      branchName: $('#task-branch').value.trim(),
      // Only pin a base branch when the user picked one other than the repo's
      // current branch; otherwise keep the historical "cut from HEAD" default.
      baseBranch: selectedBaseBranch(),
      addons: selectedAddons(),
      prDraft: selectedPrDraft(),
      personas: selectedPersonas(),
    };
    try {
      let task;
      if (editingTaskId) {
        task = await api('PATCH', `/api/tasks/${editingTaskId}`, fields);
      } else {
        const repoId = $('#task-repo').value;
        if (!repoId) { toast('Add a repository first'); return; }
        task = await api('POST', '/api/tasks', { ...fields, repoId, status: run ? 'ready' : 'backlog' });
        saveLastUsed(fields, repoId);
        // Uploads are keyed by task id, so they wait until the task exists.
        for (const f of stagedFiles) task = await uploadAttachment(task.id, f);
        stagedFiles = [];
      }
      state.tasks.set(task.id, task);
      $('#modal-task').classList.add('hidden');
      if (run) await api('POST', `/api/tasks/${task.id}/dispatch`);
    } catch (e) { toast(e.message); }
  }

  $('#btn-new-task').addEventListener('click', () => openTaskModal());
  $('#task-cancel').addEventListener('click', () => $('#modal-task').classList.add('hidden'));
  $('#task-create').addEventListener('click', () => saveTask(false));
  $('#task-create-run').addEventListener('click', () => saveTask(true));
  $('#task-prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#task-create-run').click();
  });
  $('#task-add-repo').addEventListener('click', () => {
    $('#modal-task').classList.add('hidden');
    openReposModal();
  });
  $('#task-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#task-repo').value, $('#task-repo-branch'));
    refreshBaseBranchPicker($('#task-repo').value, $('#task-base-branch'), null);
  });
  // Create a fresh branch (checked out from the repo's current one) and select it.
  $('#task-new-branch').addEventListener('click', async () => {
    const repoId = editingTaskId ? (state.tasks.get(editingTaskId)?.repoId) : $('#task-repo').value;
    if (!repoId) { toast('Add a repository first'); return; }
    const current = $('#task-base-branch').dataset.current || '';
    const name = (prompt(current ? `New branch name (checked out from ${current}):` : 'New branch name:') || '').trim();
    if (!name) return;
    try {
      await api('POST', `/api/repos/${repoId}/branches`, { name });
      await refreshBaseBranchPicker(repoId, $('#task-base-branch'), name);
      refreshRepoBranchHint(repoId, $('#task-repo-branch'));
      toast(`Created and checked out ${name}`, 'info');
    } catch (e) { toast(e.message); }
  });

  // ---------- attachments (picker + drag-and-drop) ----------
  $('#task-add-files').addEventListener('click', () => $('#task-file-input').click());
  $('#task-file-input').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = ''; // let the same file be re-picked later
  });
  const dropzone = $('#task-dropzone');
  ['dragover', 'dragenter'].forEach((ev) => dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove('dragging')));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
  // Remove an attachment: staged files drop from the list; saved ones hit the delete route.
  $('#task-attachment-list').addEventListener('click', async (e) => {
    const staged = e.target.closest('[data-remove-staged]');
    if (staged) {
      stagedFiles.splice(Number(staged.dataset.removeStaged), 1);
      renderAttachments();
      return;
    }
    const saved = e.target.closest('[data-remove-saved]');
    if (saved && editingTaskId) {
      const name = saved.dataset.removeSaved;
      try {
        const task = await api('DELETE', `/api/tasks/${editingTaskId}/attachments/${encodeURIComponent(name)}`);
        state.tasks.set(task.id, task);
        renderBoard();
        savedAttachments = task.attachments || [];
        renderAttachments();
      } catch (err) { toast(err.message); }
    }
  });

  // ---------- brief an idea (grooming) ----------
  function refreshBriefRepoSelect() {
    const sel = $('#brief-repo');
    sel.innerHTML = state.repos.length
      ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
      : '<option value="">No repos yet — add one first</option>';
  }

  // null => new grooming; a grooming card => edit that draft (or failed card).
  let briefEditingId = null;

  function openBriefModal(grooming = null) {
    // Guard: the header button passes its click event here — treat it as "new".
    if (!grooming || !grooming.id) grooming = null;
    briefEditingId = grooming ? grooming.id : null;
    refreshBriefRepoSelect();
    const last = loadLastUsed();
    $('#brief-text').value = grooming ? grooming.idea : '';
    $('#brief-branch').value = grooming ? (grooming.branchName || '') : '';
    $('#brief-target').value = grooming ? (grooming.target || 'backlog') : 'backlog';
    $('#brief-model').value = grooming ? (grooming.model || 'default') : (last.model || 'default');
    // The repo is fixed once the card exists — hide the picker in edit mode.
    $('#brief-repo-field').classList.toggle('hidden', !!grooming);
    if (grooming) $('#brief-repo').value = grooming.repoId;
    else if (currentWorkspaceRepoId()) $('#brief-repo').value = currentWorkspaceRepoId();
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#brief-repo').value = last.repoId;
    refreshRepoBranchHint($('#brief-repo').value, $('#brief-repo-branch'));
    $('#brief-modal-title').innerHTML = `${icon('lightbulb')}${grooming ? 'Edit Draft' : 'Brief an Idea'}`;
    $('#brief-draft').textContent = grooming ? 'Save Draft' : 'Save as Draft';
    $('#modal-brief').classList.remove('hidden');
    $('#brief-text').focus();
  }

  // Create (or update) a grooming card. `run` starts the read-only session
  // right away; otherwise the card stays parked in the Grooming column as a
  // gray draft to groom later.
  async function submitBrief(run) {
    const idea = $('#brief-text').value.trim();
    const repoId = $('#brief-repo').value;
    if (!idea) { toast('Describe your idea first'); return; }
    if (!briefEditingId && !repoId) { toast('Add a repository first'); return; }
    const fields = {
      idea,
      model: $('#brief-model').value,
      branchName: $('#brief-branch').value.trim(),
      target: $('#brief-target').value,
    };
    try {
      let grooming;
      if (briefEditingId) {
        grooming = await api('PATCH', `/api/groomings/${briefEditingId}`, fields);
        if (run) grooming = await api('POST', `/api/groomings/${grooming.id}/run`);
      } else {
        grooming = await api('POST', '/api/groomings', { ...fields, repoId, run: !!run });
      }
      state.groomings.set(grooming.id, grooming);
      $('#modal-brief').classList.add('hidden');
      briefEditingId = null;
      renderBoard();
      if (run) {
        toast('Grooming your idea into tasks…', 'info');
        openGroomingDrawer(grooming.id);
      }
    } catch (e) { toast(e.message); }
  }

  $('#btn-brief').addEventListener('click', () => openBriefModal());
  $('#brief-cancel').addEventListener('click', () => $('#modal-brief').classList.add('hidden'));
  $('#brief-submit').addEventListener('click', () => submitBrief(true));
  $('#brief-draft').addEventListener('click', () => submitBrief(false));
  $('#brief-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitBrief(true);
  });
  $('#brief-add-repo').addEventListener('click', () => {
    $('#modal-brief').classList.add('hidden');
    openReposModal();
  });
  $('#brief-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#brief-repo').value, $('#brief-repo-branch'));
  });

  // ---------- create task from linear ----------
  const linearConfigured = () => !!state.settings.linearConfigured;
  let linearSelectedId = null; // the Linear UUID picked from the browse list, if any

  function refreshLinearRepoSelect() {
    const sel = $('#linear-repo');
    if (!sel) return;
    sel.innerHTML = state.repos.length
      ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
      : '<option value="">No repos yet — add one first</option>';
  }

  // Toggle between the configured form and the "add a key first" note.
  function renderLinearConfigState() {
    const configured = linearConfigured();
    $('#linear-unconfigured').classList.toggle('hidden', configured);
    $('#linear-config').classList.toggle('hidden', !configured);
  }

  function openLinearModal() {
    refreshLinearRepoSelect();
    const last = loadLastUsed();
    $('#linear-issue-id').value = '';
    $('#linear-branch').value = '';
    $('#linear-model').value = last.model || 'default';
    if (currentWorkspaceRepoId()) $('#linear-repo').value = currentWorkspaceRepoId();
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#linear-repo').value = last.repoId;
    refreshRepoBranchHint($('#linear-repo').value, $('#linear-repo-branch'));
    linearSelectedId = null;
    $('#linear-issue-list').innerHTML = '';
    renderLinearConfigState();
    $('#modal-linear').classList.remove('hidden');
    if (linearConfigured()) { loadLinearIssues(); $('#linear-issue-id').focus(); }
  }

  async function loadLinearIssues() {
    const list = $('#linear-issue-list');
    list.innerHTML = '<div class="muted linear-loading">Loading your issues…</div>';
    try {
      const { issues } = await api('GET', '/api/linear/issues');
      if (!issues || !issues.length) {
        list.innerHTML = '<div class="muted">No assigned issues found.</div>';
        return;
      }
      list.innerHTML = issues.map((i) => `
        <button type="button" class="linear-issue" data-id="${esc(i.id)}" data-identifier="${esc(i.identifier)}">
          <span class="linear-issue-id">${esc(i.identifier)}</span>
          <span class="linear-issue-title">${esc(i.title)}</span>
          ${i.state ? `<span class="chip">${esc(i.state)}</span>` : ''}
        </button>`).join('');
    } catch (e) {
      list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
    }
  }

  // Clicking an issue selects it: fill the id field with its identifier and
  // remember its UUID. Typing in the id field clears the selection (typed wins).
  $('#linear-issue-list').addEventListener('click', (e) => {
    const btn = e.target.closest('.linear-issue');
    if (!btn) return;
    linearSelectedId = btn.dataset.id;
    $('#linear-issue-id').value = btn.dataset.identifier;
    // Suggest the issue's own identifier as the branch name unless the user
    // already typed a custom one.
    if (!$('#linear-branch').value.trim()) {
      $('#linear-branch').value = btn.dataset.identifier.toLowerCase();
    }
    for (const el of $('#linear-issue-list').querySelectorAll('.linear-issue')) el.classList.remove('selected');
    btn.classList.add('selected');
  });
  $('#linear-issue-id').addEventListener('input', () => {
    linearSelectedId = null;
    for (const el of $('#linear-issue-list').querySelectorAll('.linear-issue')) el.classList.remove('selected');
  });

  async function submitLinear() {
    const repoId = $('#linear-repo').value;
    const typed = $('#linear-issue-id').value.trim();
    const issueId = typed || linearSelectedId;
    if (!repoId) { toast('Add a repository first'); return; }
    if (!issueId) { toast('Paste an issue ID or pick one from the list'); return; }
    try {
      const grooming = await api('POST', '/api/linear/briefs', {
        issueId, repoId, model: $('#linear-model').value, branchName: $('#linear-branch').value.trim(),
      });
      state.groomings.set(grooming.id, grooming);
      $('#modal-linear').classList.add('hidden');
      renderBoard();
      toast('Importing the Linear issue…', 'info');
      openGroomingDrawer(grooming.id);
    } catch (e) { toast(e.message); }
  }

  $('#btn-linear').addEventListener('click', openLinearModal);
  $('#linear-cancel').addEventListener('click', () => $('#modal-linear').classList.add('hidden'));
  $('#linear-submit').addEventListener('click', submitLinear);
  $('#linear-refresh').addEventListener('click', loadLinearIssues);
  $('#linear-issue-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitLinear();
  });
  $('#linear-add-repo').addEventListener('click', () => {
    $('#modal-linear').classList.add('hidden');
    openReposModal();
  });
  $('#linear-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#linear-repo').value, $('#linear-repo-branch'));
  });
  $('#linear-open-settings').addEventListener('click', () => {
    $('#modal-linear').classList.add('hidden');
    openSettingsModal('plugins');
  });

  // ---------- create task(s) from repo specs ----------
  // Unlike the Linear import, this is a direct import: a spec file's own
  // content already reads like a self-contained instruction, so it becomes
  // task.prompt as-is — no grooming/LLM pass in between.
  let specsFiles = []; // last GET /api/repos/:id/specs result for the current repo
  let specsSelected = new Set(); // checked paths, staged for import
  let specsPreviewCache = new Map(); // "repoId:path" -> file content
  // The statuses the list defaults to showing (repo-declared, else built-in);
  // `specsShowAll` reveals the retired/shipped ones behind the "Show all" toggle.
  let specsActionableStatuses = ['draft', 'in-progress', 'partial'];
  let specsShowAll = false;

  // A spec is actionable when its status is in the actionable set, or when it has
  // no status at all (plain-markdown specs are always shown).
  const specIsActionable = (f) => !f.status || specsActionableStatuses.includes(f.status);
  // Any status present at all means this is a frontmatter-driven repo, so the
  // status chips and the "Show all" toggle are worth surfacing.
  const specsHaveStatus = () => specsFiles.some((f) => f.status);
  const statusSlug = (status) => String(status).toLowerCase().replace(/[^a-z0-9]+/g, '-');

  // Coarse "N time-unit(s) ago" label for a spec's mtime — good enough for a
  // browse list; no need for anything fancier here.
  function relativeTime(iso) {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.round(months / 12)}y ago`;
  }

  const specRoot = (specPath) => (specPath.startsWith('.specs/') ? '.specs' : 'specs');

  function refreshSpecsRepoSelect() {
    const sel = $('#specs-repo');
    if (!sel) return;
    sel.innerHTML = state.repos.length
      ? state.repos.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.path)}</option>`).join('')
      : '<option value="">No repos yet — add one first</option>';
  }

  function specsFilterQuery() {
    return $('#specs-filter').value.trim().toLowerCase();
  }

  function filteredSpecFiles() {
    const q = specsFilterQuery();
    return specsFiles.filter((f) => {
      if (!specsShowAll && !specIsActionable(f)) return false;
      if (!q) return true;
      return f.title.toLowerCase().includes(q) || f.path.toLowerCase().includes(q);
    });
  }

  function updateSpecsSelectAllState() {
    const master = $('#specs-select-all');
    const files = filteredSpecFiles();
    const allChecked = files.length > 0 && files.every((f) => specsSelected.has(f.path));
    const someChecked = files.some((f) => specsSelected.has(f.path));
    master.disabled = !specsFiles.length;
    master.checked = allChecked;
    master.indeterminate = !allChecked && someChecked;
  }

  // The "Show all" toggle only makes sense for a frontmatter-driven repo (one
  // with statuses); a plain-markdown repo hides it and behaves exactly as before.
  function updateSpecsShowAllToggle() {
    const toggle = $('#specs-show-all-field');
    if (!toggle) return;
    toggle.classList.toggle('hidden', !specsHaveStatus());
  }

  function renderSpecsList() {
    updateSpecsShowAllToggle();
    const list = $('#specs-list');
    if (!specsFiles.length) {
      list.innerHTML = '<div class="specs-empty">No specs found under specs/ or .specs/ in this repo.</div>';
      updateSpecsSelectAllState();
      return;
    }
    const files = filteredSpecFiles();
    if (!files.length) {
      const msg = specsFilterQuery()
        ? 'No specs match your filter.'
        : 'No actionable specs. Turn on “Show all” to see implemented, superseded and reserved specs.';
      list.innerHTML = `<div class="specs-empty">${esc(msg)}</div>`;
      updateSpecsSelectAllState();
      return;
    }
    const groups = new Map(); // root -> files[]
    for (const f of files) {
      const root = specRoot(f.path);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(f);
    }
    let html = '';
    for (const [root, items] of groups) {
      html += `<div class="specs-group-label">${esc(root)}/</div>`;
      html += items.map((f) => {
        const num = f.number ? `<span class="spec-row-num">${esc(f.number)}</span> ` : '';
        const chip = f.status
          ? `<span class="spec-status spec-status-${esc(statusSlug(f.status))}">${esc(f.status)}</span>`
          : '';
        return `
        <div class="spec-row${specsSelected.has(f.path) ? ' picked' : ''}" data-path="${esc(f.path)}">
          <input type="checkbox" class="spec-row-check" ${specsSelected.has(f.path) ? 'checked' : ''} />
          <div class="spec-row-body">
            <span class="spec-row-title">${num}${esc(f.title)}</span>
            <span class="spec-row-meta">${chip}<span class="spec-row-path">${esc(f.path)}</span> · ${esc(relativeTime(f.updatedAt))}</span>
          </div>
        </div>`;
      }).join('');
    }
    list.innerHTML = html;
    updateSpecsSelectAllState();
  }

  function resetSpecsPreview() {
    $('#specs-preview').textContent = 'Select a spec to preview it.';
    $('#specs-preview').classList.add('muted');
  }

  async function previewSpec(relPath) {
    for (const row of $('#specs-list').querySelectorAll('.spec-row')) {
      row.classList.toggle('previewing', row.dataset.path === relPath);
    }
    const repoId = $('#specs-repo').value;
    const preview = $('#specs-preview');
    const cacheKey = `${repoId}:${relPath}`;
    if (specsPreviewCache.has(cacheKey)) {
      preview.textContent = specsPreviewCache.get(cacheKey);
      preview.classList.remove('muted');
      return;
    }
    preview.textContent = 'Loading…';
    preview.classList.add('muted');
    try {
      const { content } = await api('GET', `/api/repos/${repoId}/specs/preview?path=${encodeURIComponent(relPath)}`);
      specsPreviewCache.set(cacheKey, content);
      preview.textContent = content;
      preview.classList.remove('muted');
    } catch (e) {
      preview.textContent = e.message;
    }
  }

  async function loadSpecsList() {
    const repoId = $('#specs-repo').value;
    const list = $('#specs-list');
    if (!repoId) { specsFiles = []; renderSpecsList(); return; }
    list.innerHTML = '<div class="muted specs-loading">Loading specs…</div>';
    try {
      const { specs, actionableStatuses } = await api('GET', `/api/repos/${repoId}/specs`);
      specsFiles = specs || [];
      if (Array.isArray(actionableStatuses) && actionableStatuses.length) specsActionableStatuses = actionableStatuses;
    } catch (e) {
      specsFiles = [];
      list.innerHTML = `<div class="muted">${esc(e.message)}</div>`;
      return;
    }
    renderSpecsList();
  }

  function openSpecsModal() {
    refreshSpecsRepoSelect();
    const last = loadLastUsed();
    $('#specs-filter').value = '';
    $('#specs-target').value = 'backlog';
    $('#specs-model').value = last.model || 'default';
    if (currentWorkspaceRepoId()) $('#specs-repo').value = currentWorkspaceRepoId();
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#specs-repo').value = last.repoId;
    specsSelected = new Set();
    specsPreviewCache = new Map();
    specsShowAll = false;
    if ($('#specs-show-all')) $('#specs-show-all').checked = false;
    resetSpecsPreview();
    $('#modal-specs').classList.remove('hidden');
    loadSpecsList();
  }

  async function submitSpecsImport() {
    const repoId = $('#specs-repo').value;
    if (!repoId) { toast('Add a repository first'); return; }
    const paths = Array.from(specsSelected);
    if (!paths.length) { toast('Pick at least one spec file'); return; }
    try {
      const { tasks, skipped } = await api('POST', `/api/repos/${repoId}/specs/import`, {
        paths, target: $('#specs-target').value, model: $('#specs-model').value,
      });
      $('#modal-specs').classList.add('hidden');
      const n = tasks.length;
      toast(
        skipped.length ? `Imported ${n} task${n === 1 ? '' : 's'}, skipped ${skipped.length}` : `Imported ${n} task${n === 1 ? '' : 's'}`,
        'info',
      );
    } catch (e) { toast(e.message); }
  }

  $('#btn-specs').addEventListener('click', openSpecsModal);
  $('#specs-cancel').addEventListener('click', () => $('#modal-specs').classList.add('hidden'));
  $('#specs-submit').addEventListener('click', submitSpecsImport);
  $('#specs-add-repo').addEventListener('click', () => {
    $('#modal-specs').classList.add('hidden');
    openReposModal();
  });
  $('#specs-repo').addEventListener('change', () => {
    specsSelected = new Set();
    specsPreviewCache = new Map();
    resetSpecsPreview();
    loadSpecsList();
  });
  $('#specs-filter').addEventListener('input', renderSpecsList);
  $('#specs-show-all').addEventListener('change', () => {
    specsShowAll = $('#specs-show-all').checked;
    renderSpecsList();
  });
  $('#specs-select-all').addEventListener('change', () => {
    const checked = $('#specs-select-all').checked;
    for (const f of filteredSpecFiles()) {
      if (checked) specsSelected.add(f.path); else specsSelected.delete(f.path);
    }
    renderSpecsList();
  });
  $('#specs-list').addEventListener('click', (e) => {
    const row = e.target.closest('.spec-row');
    if (!row || e.target.closest('.spec-row-check')) return;
    previewSpec(row.dataset.path);
  });
  $('#specs-list').addEventListener('change', (e) => {
    const cb = e.target.closest('.spec-row-check');
    if (!cb) return;
    const row = cb.closest('.spec-row');
    if (cb.checked) specsSelected.add(row.dataset.path); else specsSelected.delete(row.dataset.path);
    row.classList.toggle('picked', cb.checked);
    updateSpecsSelectAllState();
  });

  // ---------- sounds ----------
  // Short synthesized cues for two moments: a tool needs approval, and a task
  // finishes. Built with the Web Audio API so there are no audio assets to ship
  // and it works identically in the browser and the Electron shell. Gated behind
  // the "sounds" setting.
  const soundsOn = () => state.settings.sounds !== false;

  let audioCtx = null;
  function audio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) { try { audioCtx = new Ctx(); } catch { return null; } }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  // Browsers block audio until the first user gesture — resume the context then.
  ['pointerdown', 'keydown'].forEach((ev) =>
    window.addEventListener(ev, () => audio(), { once: true }));

  // Play a small sequence of tones — each [freq(Hz), start(s), dur(s)] — as a
  // soft chime, with a short attack/decay so notes don't click.
  function playTones(tones, { gain = 0.08, type = 'sine' } = {}) {
    const ctx = audio();
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const [freq, start, dur] of tones) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.linearRampToValueAtTime(gain, now + start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    }
  }

  const SOUNDS = {
    // Two-note rise that reads as a friendly nudge for attention.
    permission: () => playTones([[660, 0, 0.18], [880, 0.14, 0.26]], { type: 'triangle' }),
    // Bright ascending three-note chime for a successful finish.
    finish: () => playTones([[523.25, 0, 0.16], [659.25, 0.12, 0.16], [783.99, 0.24, 0.3]]),
    // Gentle two-note fall to signal a failed run without being harsh.
    failed: () => playTones([[392, 0, 0.2], [294, 0.18, 0.32]], { type: 'triangle' }),
  };

  // Play a named cue if it exists. `force` bypasses the setting (used by the test
  // button so the click always gives feedback).
  function playSound(name, force = false) {
    if (!force && !soundsOn()) return;
    const fn = SOUNDS[name];
    if (fn) { try { fn(); } catch { /* audio unavailable */ } }
  }

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
    $('#btn-linear').classList.toggle('hidden', !pluginInstalled('linear'));
    $('#btn-specs').classList.toggle('hidden', !pluginInstalled('repo-specs'));
    renderAutonomous();
  }

  // ---------- autonomous mode ----------
  const autonomousActive = () => !!(state.autonomous && state.autonomous.active);
  // The active session is scoped to one repo; its controls only belong to that
  // workspace. `null` here means "no session for the workspace I'm looking at".
  function autonomousForWorkspace() {
    if (!autonomousActive()) return null;
    if (state.view.mode !== 'workspace') return null;
    return state.autonomous.repoId === state.view.repoId ? state.autonomous : null;
  }

  // Toggle the workspace-header Autonomous button and (when a session is live for
  // this workspace) the live status banner.
  function renderAutonomous() {
    const btn = $('#btn-autonomous');
    const banner = $('#autonomous-banner');
    const inWorkspace = state.view.mode === 'workspace';
    const installed = pluginInstalled('autonomous');
    // The button lives in the workspace header and only makes sense there.
    btn.classList.toggle('hidden', !(installed && inWorkspace));

    const sess = autonomousForWorkspace();
    if (installed && inWorkspace) {
      btn.innerHTML = sess
        ? `${icon('square')} Stop Autonomous`
        : `${icon('bot')} Autonomous`;
      btn.classList.toggle('danger', !!sess);
    }

    if (!sess) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
    renderAutonomousBanner(sess);
  }

  const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

  function renderAutonomousBanner(sess) {
    const banner = $('#autonomous-banner');
    const live = (sess.tasks || []).filter((t) => t.running);
    const done = (sess.tasks || []).filter((t) => t.status === 'done').length;
    const chips = live.map((t) => t.resolvingConflicts
      ? `<span class="chip conflict-chip">${icon('git-branch')} ${esc(t.title)} — resolving conflicts</span>`
      : `<span class="chip">${icon('loader')} ${esc(t.title)}</span>`).join('');
    const state_ = sess.stopping
      ? 'Stopping — letting in-flight runs finish'
      : live.length === 0
        ? 'Standing by — waiting for Ready tasks'
        : 'Running';
    const reviewTag = sess.reviewMode ? ' · reviewing' : '';
    banner.innerHTML = `
      <span class="autonomous-banner-head">
        <span class="autonomous-pulse"></span>${icon('bot')} Autonomous Mode${reviewTag}
      </span>
      <span class="autonomous-banner-reason">${esc(state_)}</span>
      <span class="autonomous-banner-spend">Spent <strong>${money(sess.spentUsd)}</strong> / ${money(sess.budgetUsd)}${done ? ` · ${done} merged` : ''}</span>
      <span class="autonomous-banner-tasks">${chips || '<span class="muted">No task in flight</span>'}</span>`;
    banner.classList.remove('hidden');
  }

  async function startAutonomous() {
    const repoId = currentWorkspaceRepoId();
    if (!repoId) return;
    const budgetUsd = Number($('#autonomous-budget').value);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return toast('Enter a budget greater than 0');
    const reviewMode = $('#autonomous-review-mode').checked;
    try {
      state.autonomous = await api('POST', '/api/autonomous/start', { repoId, budgetUsd, reviewMode });
      $('#modal-autonomous').classList.add('hidden');
      renderAutonomous();
    } catch (e) { toast(e.message); }
  }

  async function stopAutonomous() {
    try {
      state.autonomous = await api('POST', '/api/autonomous/stop', {});
      renderAutonomous();
    } catch (e) { toast(e.message); }
  }

  function openAutonomousModal() {
    const repo = state.repos.find((r) => r.id === currentWorkspaceRepoId());
    if (!repo) return;
    const ready = [...state.tasks.values()].filter((t) => t.repoId === repo.id && t.status === 'ready' && !t.archived).length;
    $('#autonomous-modal-repo').innerHTML =
      `<strong>${esc(repo.name)}</strong> — ${ready} task${ready === 1 ? '' : 's'} ready to run.`;
    $('#modal-autonomous').classList.remove('hidden');
    $('#autonomous-budget').focus();
  }

  // A plugin's config block (only Linear needs one today — its API key). Rendered
  // inside the plugin card when installed. The password field always starts empty:
  // we never echo the stored token back, only the redacted `linearConfigured` flag.
  function pluginConfigHtml(p) {
    if (p.id !== 'linear' || !p.requiresApiKey) return '';
    const configured = linearConfigured();
    const note = configured
      ? 'A Linear API key is saved. Enter a new one to replace it, or clear it.'
      : 'Create a personal API key in Linear (Settings → Security & access → Personal API keys).';
    return `
      <div class="plugin-config">
        <label>Personal API key <span class="field-hint">— stored locally, used to import issues</span>
          <input class="plugin-key-input" type="password" placeholder="lin_api_…" autocomplete="off" />
        </label>
        <p class="addon-hint plugin-key-note">${esc(note)}</p>
        <div class="row">
          <button class="btn plugin-key-save">Save key</button>
          <button class="btn ghost plugin-key-clear${configured ? '' : ' hidden'}">Clear</button>
        </div>
      </div>`;
  }

  function pluginCardHtml(p, installed) {
    const badge = installed ? '<span class="plugin-badge">Installed</span>' : '';
    const action = installed
      ? '<button class="btn ghost plugin-uninstall">Uninstall</button>'
      : '<button class="btn primary plugin-install">Install</button>';
    return `
      <div class="plugin-card" data-plugin="${esc(p.id)}">
        <div class="plugin-card-icon">${icon(p.icon)}</div>
        <div class="plugin-card-body">
          <div class="plugin-card-head"><span class="plugin-card-name">${esc(p.name)}</span>${badge}</div>
          <p class="plugin-card-desc">${esc(p.description)}</p>
          ${installed ? pluginConfigHtml(p) : ''}
        </div>
        <div class="plugin-card-actions">${action}</div>
      </div>`;
  }

  // Two groups, Claude-desktop style: what's installed, and the rest of the
  // marketplace still available to add.
  function renderPlugins() {
    const body = $('#settings-plugins-body');
    if (!body) return;
    const installed = state.plugins.filter((p) => pluginInstalled(p.id));
    const available = state.plugins.filter((p) => !pluginInstalled(p.id));
    body.innerHTML = `
      <div class="plugin-group">
        <div class="plugin-group-title">Installed</div>
        ${installed.length
          ? installed.map((p) => pluginCardHtml(p, true)).join('')
          : '<p class="plugin-empty">No plugins installed yet.</p>'}
      </div>
      <div class="plugin-group">
        <div class="plugin-group-title">Marketplace</div>
        ${available.length
          ? available.map((p) => pluginCardHtml(p, false)).join('')
          : '<p class="plugin-empty">You\'ve installed everything available.</p>'}
      </div>`;
  }

  async function setInstalledPlugins(ids) {
    await saveSettings({ installedPlugins: ids });
    renderPlugins();
    renderPluginState();
  }

  // Delegated handlers for the dynamically-rendered plugin cards.
  $('#settings-plugins-body').addEventListener('click', async (e) => {
    const card = e.target.closest('.plugin-card');
    if (!card) return;
    const id = card.dataset.plugin;
    if (e.target.closest('.plugin-install')) {
      await setInstalledPlugins([...installedPluginIds(), id]);
      toast('Plugin installed', 'info');
    } else if (e.target.closest('.plugin-uninstall')) {
      await setInstalledPlugins(installedPluginIds().filter((x) => x !== id));
      toast('Plugin uninstalled', 'info');
    } else if (e.target.closest('.plugin-key-save')) {
      const input = card.querySelector('.plugin-key-input');
      const token = (input && input.value.trim()) || '';
      if (!token) { toast('Paste your Linear API key first'); return; }
      await saveSettings({ linearApiToken: token });
      renderPlugins();
      toast('Linear API key saved', 'info');
    } else if (e.target.closest('.plugin-key-clear')) {
      await saveSettings({ linearApiToken: '' });
      renderPlugins();
      toast('Linear API key cleared', 'info');
    }
  });

  // ---------- usage (Settings → Usage) ----------
  const fmtCompactNum = (n) => {
    const v = Number(n) || 0;
    try { return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v); }
    catch { return String(Math.round(v)); }
  };
  const fmtPct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;

  function usageRepoOptionsHtml() {
    return ['<option value="">All projects</option>']
      .concat(state.repos.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`))
      .join('');
  }

  // A model id like "claude-sonnet-5" or "claude-haiku-4-5-20251001" reads
  // better shortened for the breakdown rows.
  function usageModelLabel(model) {
    return String(model || 'unknown').replace(/-\d{8}$/, '');
  }

  function usageStatTile(label, value, delta) {
    const deltaHtml = delta == null ? ''
      : `<div class="usage-stat-delta ${delta >= 0 ? 'up' : 'down'}">${fmtPct(delta)} vs previous period</div>`;
    return `
      <div class="usage-stat">
        <div class="usage-stat-label">${esc(label)}</div>
        <div class="usage-stat-value">${value}</div>
        ${deltaHtml}
      </div>`;
  }

  function usageBarRowHtml(label, sub, costUsd, maxCost, runs) {
    const pct = maxCost > 0 ? Math.max(2, Math.round((costUsd / maxCost) * 100)) : 0;
    return `
      <div class="usage-row">
        <div class="usage-row-head">
          <span class="usage-row-label">${esc(label)}</span>
          <span class="usage-row-value">${money(costUsd)}${sub ? ` <span class="usage-row-sub">${sub}</span>` : ''}</span>
        </div>
        <div class="usage-row-bar"><div class="usage-row-bar-fill" style="width:${pct}%"></div></div>
        <div class="usage-row-runs">${runs} run${runs === 1 ? '' : 's'}</div>
      </div>`;
  }

  function usageChartHtml(byDay) {
    if (!byDay.length) return '<p class="usage-empty">No runs in this period.</p>';
    const MAX_BARS = 60;
    const shown = byDay.length > MAX_BARS ? byDay.slice(byDay.length - MAX_BARS) : byDay;
    const maxCost = Math.max(...shown.map((d) => d.costUsd), 0.01);
    const note = byDay.length > MAX_BARS
      ? `<p class="usage-chart-note">Showing the most recent ${MAX_BARS} of ${byDay.length} days.</p>` : '';
    const bars = shown.map((d) => {
      const h = Math.max(3, Math.round((d.costUsd / maxCost) * 64));
      return `<div class="usage-chart-bar" style="height:${h}px" title="${esc(d.date)}: ${money(d.costUsd)} · ${d.runs} run${d.runs === 1 ? '' : 's'}"></div>`;
    }).join('');
    return `<div class="usage-chart">${bars}</div>${note}`;
  }

  function renderUsage() {
    const body = $('#settings-usage-body');
    if (!body) return;
    const s = state.usage.summary;
    if (!s) { body.innerHTML = '<p class="usage-empty">Loading…</p>'; return; }

    const stats = [
      usageStatTile('Total spend', money(s.totals.costUsd), s.deltaPct),
      usageStatTile('Runs', s.totals.runs, null),
      usageStatTile('Tasks touched', s.totals.tasks, null),
      usageStatTile('Tokens in / out', `${fmtCompactNum(s.totals.inputTokens)} / ${fmtCompactNum(s.totals.outputTokens)}`, null),
    ];

    const maxModelCost = Math.max(...s.byModel.map((m) => m.costUsd), 0.01);
    const modelRows = s.byModel.length
      ? s.byModel.map((m) => usageBarRowHtml(
          usageModelLabel(m.model),
          `${fmtCompactNum(m.inputTokens)} in · ${fmtCompactNum(m.outputTokens)} out`,
          m.costUsd, maxModelCost, m.runs,
        )).join('')
      : '<p class="usage-empty">No runs in this period.</p>';

    const maxRepoCost = Math.max(...s.byRepo.map((r) => r.costUsd), 0.01);
    const repoRows = s.byRepo.length
      ? s.byRepo.map((r) => usageBarRowHtml(r.repoName, '', r.costUsd, maxRepoCost, r.runs)).join('')
      : '<p class="usage-empty">No runs in this period.</p>';

    body.innerHTML = `
      <div class="usage-stats">${stats.join('')}</div>
      <div class="usage-section-block">
        <div class="usage-block-title">By day</div>
        ${usageChartHtml(s.byDay)}
      </div>
      <div class="usage-section-block">
        <div class="usage-block-title">By model</div>
        <div class="usage-rows">${modelRows}</div>
      </div>
      <div class="usage-section-block">
        <div class="usage-block-title">By project</div>
        <div class="usage-rows">${repoRows}</div>
      </div>`;
  }

  async function loadUsage() {
    try {
      const qs = new URLSearchParams({ period: state.usage.period });
      if (state.usage.repoId) qs.set('repoId', state.usage.repoId);
      state.usage.summary = await api('GET', `/api/usage?${qs.toString()}`);
    } catch (e) {
      toast(e.message);
    }
    renderUsage();
  }

  for (const btn of document.querySelectorAll('.usage-period-btn')) {
    btn.addEventListener('click', () => {
      state.usage.period = btn.dataset.period;
      for (const b of document.querySelectorAll('.usage-period-btn')) b.classList.toggle('active', b === btn);
      loadUsage();
    });
  }
  $('#usage-repo-filter').addEventListener('change', (e) => {
    state.usage.repoId = e.target.value;
    loadUsage();
  });

  // ---------- settings modal ----------
  function showSettingsSection(name) {
    for (const item of document.querySelectorAll('.settings-nav-item')) {
      item.classList.toggle('active', item.dataset.section === name);
    }
    for (const sec of document.querySelectorAll('.settings-section')) {
      sec.classList.toggle('hidden', sec.dataset.section !== name);
    }
    if (name === 'usage') {
      const select = $('#usage-repo-filter');
      const prev = select.value;
      select.innerHTML = usageRepoOptionsHtml();
      select.value = state.repos.some((r) => r.id === prev) ? prev : '';
      loadUsage();
    }
  }

  // `section` may be a string ('general' | 'plugins') or a DOM event (from the
  // header button); anything non-string falls back to the General section.
  function openSettingsModal(section) {
    $('#setting-notifications').checked = notificationsOn();
    $('#setting-sounds').checked = soundsOn();
    updateNotifNote();
    $('#setting-max-parallel').value = state.settings.maxParallelSessions || 3;
    $('#setting-merge-strategy').value = state.settings.mergeStrategy || 'merge';
    $('#setting-auto-resolve-conflicts').checked = !!state.settings.autoResolveConflicts;
    $('#setting-assign-pr-to-self').checked = !!state.settings.assignPrToSelf;
    renderPlugins();
    renderCustomModels();
    renderRemoteAccess();
    showSettingsSection(typeof section === 'string' ? section : 'general');
    $('#modal-settings').classList.remove('hidden');
  }

  async function saveSettings(patch) {
    try {
      state.settings = await api('PATCH', '/api/settings', patch);
    } catch (e) { toast(e.message); }
  }

  // ---------- custom models ----------
  const customModels = () => state.settings.customModels || [];

  // Rebuild the custom-model <option>s in every model picker (New Task, Brief,
  // Linear import). The built-in options stay in the HTML; we only manage the
  // ones we tag data-custom, and preserve the current selection across a rebuild.
  function syncCustomModelOptions() {
    for (const sel of document.querySelectorAll('#task-model, #brief-model, #linear-model')) {
      const keep = sel.value;
      for (const opt of [...sel.querySelectorAll('option[data-custom]')]) opt.remove();
      for (const m of customModels()) {
        const opt = document.createElement('option');
        opt.value = m.model;
        opt.textContent = m.label;
        opt.dataset.custom = '1';
        sel.appendChild(opt);
      }
      // Keep the selection if it still exists; otherwise the browser falls back
      // to the first option (Account default), which is the right thing.
      if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    }
  }

  // Parse the add-model env textarea (one KEY=value per line) into an object.
  // Blank lines and #comments are skipped; ANTHROPIC_API_KEY is refused here too
  // (the server strips it as well) so the subscription-only invariant holds.
  function parseEnvLines(text) {
    const env = {};
    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || key === 'ANTHROPIC_API_KEY') continue;
      env[key] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  function renderCustomModels() {
    const body = $('#settings-models-body');
    if (!body) return;
    const models = customModels();
    if (!models.length) {
      body.innerHTML = '<p class="plugin-empty">No custom models yet. Add one below.</p>';
      return;
    }
    body.innerHTML = models.map((m) => {
      const keys = Object.keys(m.env || {});
      const envStr = keys.length
        ? keys.map((k) => `${esc(k)}=${esc(m.env[k])}`).join(' · ')
        : 'no extra environment';
      return `
        <div class="model-row" data-id="${esc(m.id)}">
          <div class="model-row-main">
            <div class="model-row-label">${esc(m.label)}</div>
            <div class="model-row-id"><code>${esc(m.model)}</code></div>
            <div class="model-row-env">${envStr}</div>
          </div>
          <button class="btn icon danger model-remove" title="Remove" aria-label="Remove model">${icon('trash')}</button>
        </div>`;
    }).join('');
  }

  async function setCustomModels(models) {
    await saveSettings({ customModels: models });
    syncCustomModelOptions();
    renderCustomModels();
  }

  $('#model-add-btn').addEventListener('click', async () => {
    const label = $('#model-add-label').value.trim();
    const model = $('#model-add-id').value.trim();
    if (!label || !model) { toast('A model needs a name and a model id.'); return; }
    const env = parseEnvLines($('#model-add-env').value);
    await setCustomModels([...customModels(), { label, model, env }]);
    $('#model-add-label').value = '';
    $('#model-add-id').value = '';
    $('#model-add-env').value = '';
  });

  $('#settings-models-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.model-remove');
    if (!btn) return;
    const id = btn.closest('.model-row').dataset.id;
    await setCustomModels(customModels().filter((m) => m.id !== id));
  });

  for (const item of document.querySelectorAll('.settings-nav-item')) {
    item.addEventListener('click', () => showSettingsSection(item.dataset.section));
  }
  $('#btn-settings').addEventListener('click', () => openSettingsModal());
  $('#settings-close').addEventListener('click', () => $('#modal-settings').classList.add('hidden'));
  $('#setting-notifications').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (enabled) await ensureNotifyPermission(); // prompt on opt-in (browser only)
    await saveSettings({ notifications: enabled });
    updateNotifNote();
  });
  $('#setting-notif-test').addEventListener('click', () => {
    // Works in both modes: under Electron the Web Notification routes to a native one.
    showBrowserNotification('Sr. Popo', { body: 'Notifications are working.' }, true);
  });
  $('#setting-sounds').addEventListener('change', async (e) => {
    await saveSettings({ sounds: e.target.checked });
  });
  $('#setting-sound-test').addEventListener('click', () => playSound('finish', true));
  $('#setting-max-parallel').addEventListener('change', async (e) => {
    const n = Math.min(20, Math.max(1, Math.trunc(Number(e.target.value)) || 1));
    e.target.value = n;
    await saveSettings({ maxParallelSessions: n });
    renderBoard();
  });
  $('#setting-merge-strategy').addEventListener('change', async (e) => {
    await saveSettings({ mergeStrategy: e.target.value });
  });
  $('#setting-auto-resolve-conflicts').addEventListener('change', async (e) => {
    await saveSettings({ autoResolveConflicts: e.target.checked });
  });
  $('#setting-assign-pr-to-self').addEventListener('change', async (e) => {
    await saveSettings({ assignPrToSelf: e.target.checked });
  });

  // ---------- remote access (LAN) ----------
  const remoteAccessOn = () => !!state.settings.remoteAccess;

  // Fetch the raw token + pairing URL(s) from the localhost-only endpoint. A
  // browser that reached us over the LAN gets a 403 → returns null (it doesn't
  // need the pairing info; it's already paired). Toggling remote access on
  // re-binds the server, briefly dropping connections, so a transient failure is
  // retried a couple of times before giving up.
  async function fetchRemoteInfo() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/remote-access');
        if (res.status === 403) return null; // remote (already-paired) client
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.json();
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((r) => setTimeout(r, 400)); // ride out the re-bind window
      }
    }
    return null;
  }

  // Reflect the current toggle state, then — when enabled — render the token +
  // pairing URL(s). The secret never rides in state.settings (it's not in
  // publicSettings), so we ask for it here on demand.
  async function renderRemoteAccess() {
    const on = remoteAccessOn();
    $('#setting-remote-access').checked = on;
    $('#remote-warning').classList.toggle('hidden', !on);
    const pairing = $('#remote-pairing');
    pairing.classList.toggle('hidden', !on);
    if (!on) return;
    let info;
    try {
      info = await fetchRemoteInfo();
    } catch {
      pairing.classList.add('hidden');
      return;
    }
    if (!info) { pairing.classList.add('hidden'); return; } // remote client
    const urlsBox = $('#remote-urls');
    const noLan = $('#remote-no-lan');
    const urls = Array.isArray(info.urls) ? info.urls : (info.url ? [info.url] : []);
    if (!urls.length) {
      urlsBox.innerHTML = '';
      noLan.textContent = 'No local network address was found. Connect this machine to Wi-Fi or a LAN, then reopen this pane.';
      noLan.classList.remove('hidden');
      return;
    }
    noLan.classList.add('hidden');
    urlsBox.innerHTML = urls.map((u) => `
      <div class="remote-url">
        <code>${esc(u)}</code>
        <button class="btn ghost icon remote-copy" data-url="${esc(u)}" title="Copy link" aria-label="Copy link">${icon('copy')}</button>
      </div>`).join('');
  }

  $('#setting-remote-access').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    if (enabled && !confirm(
      'Enable remote access?\n\nSr. Popo will be reachable from other devices on your ' +
      'local network. Anyone with the link and token can control your tasks and repos. ' +
      'Only do this on a network you trust.')) {
      e.target.checked = false;
      return;
    }
    await saveSettings({ remoteAccess: enabled });
    await renderRemoteAccess();
  });

  $('#remote-regen').addEventListener('click', async () => {
    if (!confirm('Regenerate the access token? Every currently-paired device will be signed out.')) return;
    await saveSettings({ regenerateRemoteToken: true });
    await renderRemoteAccess();
    toast('Access token regenerated', 'info');
  });

  $('#remote-urls').addEventListener('click', async (e) => {
    const btn = e.target.closest('.remote-copy');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.url);
      toast('Link copied', 'info');
    } catch {
      toast('Could not copy — select and copy the link manually');
    }
  });

  // ---------- repos modal ----------
  function renderRepoList() {
    const ul = $('#repo-list');
    ul.innerHTML = state.repos.length ? '' : '<li class="muted">No repositories yet.</li>';
    for (const r of state.repos) {
      const li = document.createElement('li');
      li.innerHTML = `
        <span class="repo-name">${esc(r.name)}</span>
        <span class="repo-path">${esc(r.path)}</span>
        <button class="btn icon danger" title="Remove" aria-label="Remove repository">${icon('x')}</button>`;
      li.querySelector('button').addEventListener('click', async () => {
        try { await api('DELETE', `/api/repos/${r.id}`); } catch (e) { toast(e.message); }
      });
      ul.appendChild(li);
    }
  }

  function openReposModal() {
    renderRepoList();
    $('#modal-repos').classList.remove('hidden');
    $('#repo-path').focus();
  }

  async function addRepo(path) {
    const p = String(path || '').trim();
    if (!p) return;
    try {
      await api('POST', '/api/repos', { path: p });
      $('#repo-path').value = '';
    } catch (e) { toast(e.message); }
  }

  $('#btn-repos').addEventListener('click', openReposModal);
  $('#repos-close').addEventListener('click', () => $('#modal-repos').classList.add('hidden'));
  $('#repo-add').addEventListener('click', () => addRepo($('#repo-path').value));
  $('#repo-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#repo-add').click(); });

  // In Electron, offer a native folder picker instead of typing the path by hand.
  if (window.srpopo && window.srpopo.isElectron) {
    const browse = $('#repo-browse');
    browse.classList.remove('hidden');
    browse.addEventListener('click', async () => {
      const picked = await window.srpopo.pickFolder();
      if (picked) await addRepo(picked);
    });
  }

  // ---------- filter bar wiring ----------
  $('#filter-search').addEventListener('input', (e) => {
    state.filters.search = e.target.value.trim().toLowerCase();
    saveFilters();
    renderBoard();
  });
  $('#filter-clear').addEventListener('click', () => {
    state.filters.search = '';
    $('#filter-search').value = '';
    onFiltersChanged();
  });
  // Press "/" to jump to the filter box (unless already typing somewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    e.preventDefault();
    $('#filter-search').focus();
  });

  // ---------- command palette (⌘K) ----------
  // A quick switcher: jump straight to any task by name, or run a top-bar
  // action, without hunting across columns/filters or reaching for the mouse.
  let paletteResults = []; // flat, in on-screen order: { type: 'command'|'task', item }
  let paletteActive = 0;

  function paletteCommands() {
    return [
      { label: 'New Task', hint: 'Start a task from scratch', icon: 'plus', kbd: `${MOD}N`, run: () => openTaskModal() },
      // Plugin-gated commands surface only when their plugin is installed.
      ...(pluginInstalled('grooming')
        ? [{ label: 'Brief an Idea', hint: 'Groom a rough idea into tasks', icon: 'lightbulb', run: () => openBriefModal() }]
        : []),
      ...(pluginInstalled('linear')
        ? [{ label: 'Create Task from Linear', hint: 'Import an assigned issue', icon: 'linear', run: () => openLinearModal() }]
        : []),
      ...(pluginInstalled('repo-specs')
        ? [{ label: 'Import from Specs', hint: 'Pick spec files to import as tasks', icon: 'folder', run: () => openSpecsModal() }]
        : []),
      { label: 'Repositories', hint: 'Add or manage repos', icon: 'folder', run: () => openReposModal() },
      { label: 'Super View', hint: 'Back to the all-workspaces home screen', icon: 'arrow-left', run: () => exitWorkspace() },
      { label: 'Settings', hint: 'Notifications, sounds, Linear key', icon: 'settings', kbd: `${MOD},`, run: () => openSettingsModal() },
      { label: 'Toggle Theme', hint: `Currently ${THEME_LABEL[currentTheme()]}`, icon: 'sun-moon', run: () => $('#btn-theme').click() },
      { label: 'Filter Tasks', hint: 'Jump to the filter box', icon: 'search', kbd: '/', run: () => $('#filter-search').focus() },
      { label: 'Keyboard Shortcuts', hint: 'See all shortcuts', icon: 'keyboard', kbd: '?', run: () => openShortcutsModal() },
    ];
  }

  function paletteRow(index, opts) {
    return `<div class="palette-option" data-index="${index}">
      ${opts.dot ? `<span class="palette-status-dot" style="background:${opts.dot}"></span>`
        : `<span class="palette-option-icon">${icon(opts.icon)}</span>`}
      <span class="palette-option-body">
        <span class="palette-option-label">${esc(opts.label)}</span>
        <span class="palette-option-hint">${esc(opts.hint)}</span>
      </span>
      ${opts.kbd ? `<span class="kbd">${esc(opts.kbd)}</span>` : ''}
    </div>`;
  }

  function renderPalette(query) {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (text) => tokens.every((t) => text.includes(t));

    const cmds = paletteCommands().filter((c) => matches(`${c.label} ${c.hint}`.toLowerCase()));
    // Workspaces to switch into — the current one is omitted (switching to it is a no-op).
    const repos = state.repos
      .filter((r) => currentWorkspaceRepoId() !== r.id)
      .filter((r) => matches(`${r.name} ${r.path}`.toLowerCase()));
    const allTasks = [...state.tasks.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const tasks = (tokens.length ? allTasks.filter((t) => matches(`${t.title} ${t.repoName}`.toLowerCase())) : allTasks.slice(0, 6))
      .slice(0, 8);

    paletteResults = [
      ...cmds.map((item) => ({ type: 'command', item })),
      ...repos.map((item) => ({ type: 'workspace', item })),
      ...tasks.map((item) => ({ type: 'task', item })),
    ];
    paletteActive = 0;

    const results = $('#palette-results');
    if (!paletteResults.length) {
      results.innerHTML = '<div class="palette-empty">No matches</div>';
      return;
    }
    let html = '';
    if (cmds.length) {
      html += '<div class="palette-group">Commands</div>';
      html += cmds.map((c, i) => paletteRow(i, c)).join('');
    }
    if (repos.length) {
      html += '<div class="palette-group">Workspaces</div>';
      html += repos.map((r, i) => {
        const live = tasksForRepo(r.id).filter(isLive).length;
        return paletteRow(cmds.length + i, {
          label: r.name, icon: 'folder', hint: live ? `Switch workspace · ${live} live` : 'Switch workspace',
        });
      }).join('');
    }
    if (tasks.length) {
      html += `<div class="palette-group">${tokens.length ? 'Tasks' : 'Recent tasks'}</div>`;
      html += tasks.map((t, i) => paletteRow(cmds.length + repos.length + i, {
        label: t.title, hint: `${t.repoName} · ${t.status}`, dot: COLUMNS.find((c) => c.key === COLUMN_OF_STATUS[t.status]).dot,
      })).join('');
    }
    results.innerHTML = html;
    updatePaletteActive();
  }

  function updatePaletteActive() {
    const results = $('#palette-results');
    results.querySelectorAll('.palette-option').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === paletteActive);
    });
    const activeEl = results.querySelector('.palette-option.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  function movePaletteActive(delta) {
    if (!paletteResults.length) return;
    paletteActive = (paletteActive + delta + paletteResults.length) % paletteResults.length;
    updatePaletteActive();
  }

  function activatePalette(index) {
    const entry = paletteResults[index];
    if (!entry) return;
    closePalette();
    if (entry.type === 'command') entry.item.run();
    else if (entry.type === 'workspace') enterWorkspace(entry.item.id);
    else openDrawer(entry.item.id);
  }

  function openPalette() {
    $('#palette-input').value = '';
    renderPalette('');
    $('#modal-palette').classList.remove('hidden');
    $('#palette-input').focus();
  }
  function closePalette() { $('#modal-palette').classList.add('hidden'); }

  $('#btn-palette').addEventListener('click', openPalette);
  $('#modal-palette').addEventListener('click', (e) => { if (e.target.id === 'modal-palette') closePalette(); });
  $('#palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  $('#palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteActive(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteActive(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); activatePalette(paletteActive); }
  });
  $('#palette-results').addEventListener('click', (e) => {
    const row = e.target.closest('.palette-option');
    if (row) activatePalette(Number(row.dataset.index));
  });
  $('#palette-results').addEventListener('mousemove', (e) => {
    const row = e.target.closest('.palette-option');
    if (row && Number(row.dataset.index) !== paletteActive) {
      paletteActive = Number(row.dataset.index);
      updatePaletteActive();
    }
  });

  // ---------- keyboard shortcuts help ----------
  const SHORTCUTS = [
    { label: 'Search & commands', keys: [MOD, 'K'] },
    { label: 'New task', keys: [MOD, 'N'] },
    { label: 'Settings', keys: [MOD, ','] },
    { label: 'Filter tasks', keys: ['/'] },
    { label: 'Submit the open form', keys: [MOD, '↵'] },
    { label: 'Close dialog / drawer', keys: ['esc'] },
    { label: 'This help', keys: ['?'] },
  ];
  $('#shortcuts-list').innerHTML = SHORTCUTS.map((s) => `
    <li><span class="shortcut-label">${esc(s.label)}</span>
      <span class="kbd-group">${s.keys.map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span>
    </li>`).join('');

  function openShortcutsModal() { $('#modal-shortcuts').classList.remove('hidden'); }
  $('#shortcuts-close').addEventListener('click', () => $('#modal-shortcuts').classList.add('hidden'));

  // A blocking modal already covers the screen — don't stack a second one on top.
  const modalOpen = () => !!document.querySelector('.modal:not(.hidden)');

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!modalOpen()) openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (!modalOpen()) openTaskModal();
      return;
    }
    if (e.key === '?' && !mod && !e.altKey) {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      e.preventDefault();
      if (!modalOpen()) openShortcutsModal();
      return;
    }
    // Cmd/Ctrl+, opens Settings — the platform-standard shortcut (⌘, on macOS).
    if (e.key === ',' && mod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if ($('#modal-settings').classList.contains('hidden')) openSettingsModal();
    }
  });

  // ---------- native menu bar (Electron) ----------
  // The main process owns no UI — it just forwards menu clicks here so every
  // action reuses the same modal/open functions as the on-screen buttons.
  if (isElectron && window.srpopo.onMenuAction) {
    window.srpopo.onMenuAction((action) => {
      switch (action) {
        case 'new-task': if (!modalOpen()) openTaskModal(); break;
        case 'brief-idea':
          if (modalOpen()) break;
          if (pluginInstalled('grooming')) openBriefModal();
          else toast('Install the Idea Grooming plugin (Settings → Plugins) first', 'info');
          break;
        case 'repos': if (!modalOpen()) openReposModal(); break;
        case 'settings': if ($('#modal-settings').classList.contains('hidden')) openSettingsModal(); break;
        case 'palette': if (!modalOpen()) openPalette(); break;
        case 'shortcuts': if (!modalOpen()) openShortcutsModal(); break;
        case 'find': $('#filter-search').focus(); break;
        case 'toggle-theme': $('#btn-theme').click(); break;
      }
    });
  }

  // ---------- auto-update (Electron) ----------
  // The main process downloads updates in the background (electron-updater)
  // and tells us here once one is ready — never auto-restart without the user
  // clicking Relaunch.
  if (isElectron && window.srpopo.onUpdateReady) {
    window.srpopo.onUpdateReady((version) => showUpdateBanner(version));
  }

  // ---------- drawer close ----------
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeContextMenu();
      closeWorkspacePicker();
      document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
    }
  });

  // ---------- live updates ----------
  function connectSSE() {
    const es = new EventSource('/api/events');
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
          $('#setting-auto-resolve-conflicts').checked = !!state.settings.autoResolveConflicts;
          $('#setting-assign-pr-to-self').checked = !!state.settings.assignPrToSelf;
          updateNotifNote();
          renderPlugins();
          renderCustomModels();
          renderRemoteAccess();
        }
        syncCustomModelOptions();
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
      } else if (msg.type === 'repos') {
        state.repos = msg.repos;
        renderRepoList();
        refreshRepoSelect();
        refreshBriefRepoSelect();
        refreshLinearRepoSelect();
        // Fall back to the Super View if the workspace's own repo was just removed.
        if (state.view.mode === 'workspace' && !state.repos.some((r) => r.id === state.view.repoId)) exitWorkspace();
        else renderView();
      } else if (msg.type === 'log' && (msg.taskId === state.openTaskId || msg.taskId === state.openGroomingId)) {
        appendEvent(msg.event);
      } else if (msg.type === 'permission') {
        applyPermissionEvent(msg);
      } else if (msg.type === 'autonomous') {
        state.autonomous = msg.status || null;
        renderAutonomous();
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
  }

  // ---------- deep links (#task/<id>) ----------
  // Lets the native tray menu open a specific task in the drawer.
  function handleHashDeeplink() {
    const m = location.hash.match(/^#task\/([a-z0-9]+)$/i);
    if (m && state.tasks.has(m[1])) openDrawer(m[1]);
  }
  window.addEventListener('hashchange', handleHashDeeplink);

  // ---------- theme ----------
  // System → Light → Dark, persisted like the other lightweight prefs. The
  // saved value is also read by an inline <head> script so the first paint
  // already matches; here we keep the toggle button in sync and cycle it.
  const THEME_KEY = 'srpopo.theme';
  const THEME_CYCLE = ['system', 'light', 'dark'];
  const THEME_ICON = { system: 'sun-moon', light: 'sun', dark: 'moon' };
  const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };

  function currentTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : 'system';
    } catch { return 'system'; }
  }
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') {
      document.documentElement.setAttribute('data-theme', mode);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    try {
      if (mode === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch { /* storage unavailable — non-fatal */ }
    const btn = $('#btn-theme');
    if (btn) {
      btn.innerHTML = icon(THEME_ICON[mode]);
      btn.title = `Theme: ${THEME_LABEL[mode]} (click to change)`;
    }
  }
  function initTheme() {
    applyTheme(currentTheme());
    $('#btn-theme').addEventListener('click', () => {
      const next = THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme()) + 1) % THEME_CYCLE.length];
      applyTheme(next);
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const { repos, tasks, groomings, settings, autonomous } = await api('GET', '/api/state');
      state.repos = repos;
      state.tasks = new Map(tasks.map((t) => [t.id, t]));
      state.groomings = new Map((groomings || []).map((g) => [g.id, g]));
      state.autonomous = autonomous || null;
      // Seed live tool-approval prompts, then drop the transient field off the task.
      state.permissions = new Map();
      state.autoApprove = new Set();
      for (const t of tasks) {
        if (t.pendingPermissions && t.pendingPermissions.length) state.permissions.set(t.id, t.pendingPermissions);
        if (t.autoApprovePermissions) state.autoApprove.add(t.id);
        delete t.pendingPermissions;
        delete t.autoApprovePermissions;
      }
      if (settings) state.settings = settings;
      syncCustomModelOptions();
      loadFilters();
      $('#filter-search').value = state.filters.search;
      state.view = loadView();
      renderView();
      handleHashDeeplink();
    } catch (e) { toast(`Failed to load state: ${e.message}`); }

    try {
      state.addons = await api('GET', '/api/addons');
    } catch { state.addons = []; }

    try {
      state.personas = await api('GET', '/api/personas');
    } catch { state.personas = []; }

    try {
      state.plugins = (await api('GET', '/api/plugins')).plugins || [];
    } catch { state.plugins = []; }
    renderPluginState();

    try {
      const h = await api('GET', '/api/health');
      const chip = $('#health');
      chip.textContent = h.ok ? `● ${h.claude}` : '● claude CLI not found';
      chip.classList.add(h.ok ? 'ok' : 'bad');
      const about = $('#setting-about-version');
      if (about && h.version) {
        about.textContent = `Sr. Popo v${h.version} · Node ${h.node}` +
          (h.ok ? ` · ${h.claude}` : '');
      }
    } catch { /* server down; toast already shown */ }

    connectSSE();
  }

  // Reflect the platform's modifier key in the top-bar shortcut hints.
  $('#btn-palette').title = `Search & commands (${MOD}K)`;
  $('#btn-new-task').title = `New task (${MOD}N)`;
  $('#btn-settings').title = `Settings (${MOD},)`;

  initTheme();
  boot();
})();
