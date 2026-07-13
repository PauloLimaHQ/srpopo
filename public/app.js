/* Sr. Popo — frontend. No build step, no dependencies. */
(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    repos: [],
    tasks: new Map(), // id -> task
    openTaskId: null, // task shown in drawer
    addons: [],       // catalog of optional task behaviors (from /api/addons)
    personas: [],     // catalog of expert personas (from /api/personas)
    settings: { notifications: true, sounds: true }, // user preferences (from /api/settings)
    filters: { search: '', repoIds: new Set() }, // board filters (project + text)
    prByTask: new Map(), // taskId -> 'loading' | { pr, reason } from /api/tasks/:id/pr
    repoBranchByTask: new Map(), // taskId -> 'loading' | repo's live current branch (non-worktree tasks only)
    permissions: new Map(), // taskId -> [ pending tool-approval requests ]
  };

  // Pending permission-prompt helpers — a task's live tool-approval requests.
  function pendingPermissions(taskId) {
    return state.permissions.get(taskId) || [];
  }
  function setPendingPermissions(taskId, list) {
    if (list && list.length) state.permissions.set(taskId, list);
    else state.permissions.delete(taskId);
  }

  // In the desktop app native notifications are fired by the Electron shell; in a
  // plain browser we fall back to the Web Notifications API from here.
  const isElectron = !!(window.srpopo && window.srpopo.isElectron);

  // Dot colors are mid-tones chosen to read on both the light "paper" and dark
  // surfaces; running uses Claude's terracotta accent to match the theme.
  const COLUMNS = [
    { key: 'backlog', label: 'Backlog', dot: '#94897a' },
    { key: 'grooming', label: 'Grooming', dot: '#c06fce' },
    { key: 'ready', label: 'Ready', dot: '#5b8cbe' },
    { key: 'running', label: 'Running', dot: '#d97757' },
    { key: 'review', label: 'Review', dot: '#8a78d6' },
    { key: 'done', label: 'Done', dot: '#5aa873' },
  ];
  // failed tasks are surfaced in the Review column with a FAILED badge
  const COLUMN_OF_STATUS = {
    backlog: 'backlog', grooming: 'grooming', ready: 'ready', running: 'running',
    review: 'review', failed: 'review', done: 'done',
  };
  // Live states run a claude child process — cards can't be dragged/edited and
  // show a spinner + stop button instead.
  const isLive = (t) => t.status === 'running' || t.status === 'grooming';

  const $ = (sel) => document.querySelector(sel);

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

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  // A task is shown when it matches every active filter: an optional set of
  // repos (project) and a free-text query over its title / repo / prompt.
  function taskMatchesFilters(t) {
    const f = state.filters;
    if (f.repoIds.size && !f.repoIds.has(t.repoId)) return false;
    if (f.search) {
      const hay = `${t.title} ${t.repoName} ${t.prompt || ''}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  }

  const filtersActive = () => state.filters.repoIds.size > 0 || !!state.filters.search;

  // A stable per-repo accent so each project reads as the same color everywhere.
  function repoHue(id) {
    let h = 0;
    for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
    return h;
  }

  const FILTER_KEY = 'srpopo.filters';
  function saveFilters() {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({
        search: state.filters.search,
        repoIds: [...state.filters.repoIds],
      }));
    } catch { /* storage unavailable — non-fatal */ }
  }
  function loadFilters() {
    try {
      const f = JSON.parse(localStorage.getItem(FILTER_KEY)) || {};
      state.filters.search = (f.search || '').toLowerCase();
      state.filters.repoIds = new Set(f.repoIds || []);
    } catch { /* ignore malformed storage */ }
  }

  function onFiltersChanged() {
    saveFilters();
    renderFilters();
    renderBoard();
  }

  function renderFilters() {
    // Drop any selected repos that no longer exist so the state can't get stuck.
    const known = new Set(state.repos.map((r) => r.id));
    for (const id of [...state.filters.repoIds]) if (!known.has(id)) state.filters.repoIds.delete(id);

    const counts = new Map();
    for (const t of state.tasks.values()) counts.set(t.repoId, (counts.get(t.repoId) || 0) + 1);

    $('#filter-repos').innerHTML = state.repos.map((r) => {
      const active = state.filters.repoIds.has(r.id);
      const n = counts.get(r.id) || 0;
      return `<button class="filter-pill ${active ? 'active' : ''}" data-repo="${esc(r.id)}" title="${esc(r.path)}">
          <span class="filter-pill-dot" style="background:hsl(${repoHue(r.id)} 60% 60%)"></span>
          <span class="filter-pill-name">${esc(r.name)}</span>
          <span class="filter-pill-count">${n}</span>
        </button>`;
    }).join('');

    updateFilterMeta();
  }

  function updateFilterMeta() {
    const all = [...state.tasks.values()];
    const shown = all.filter(taskMatchesFilters).length;
    $('#filter-count').textContent = filtersActive() ? `${shown} of ${all.length}` : `${all.length} tasks`;
    $('#filter-clear').classList.toggle('hidden', !filtersActive());
  }

  // ---------- board ----------
  function renderBoard() {
    updateFilterMeta();
    const board = $('#board');
    board.innerHTML = '';
    for (const col of COLUMNS) {
      const tasks = [...state.tasks.values()]
        .filter((t) => COLUMN_OF_STATUS[t.status] === col.key)
        .filter(taskMatchesFilters)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

      const colEl = document.createElement('div');
      colEl.className = 'column';
      colEl.dataset.col = col.key;
      colEl.innerHTML = `
        <div class="column-head">
          <span class="dot" style="background:${col.dot}"></span>
          ${col.label}
          <span class="count">${tasks.length}</span>
        </div>
        <div class="column-body"></div>`;
      const body = colEl.querySelector('.column-body');

      if (!tasks.length) {
        const hint = filtersActive() ? 'no matches'
          : col.key === 'running' ? 'drag a card here to dispatch'
          : col.key === 'grooming' ? 'brief an idea to fill this' : 'empty';
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

  function renderCard(t) {
    const el = document.createElement('div');
    el.className = `card ${t.status === 'running' ? 'running' : ''} ${t.status === 'grooming' ? 'grooming' : ''} ${t.status === 'failed' ? 'failed' : ''}`;
    el.draggable = !isLive(t);
    el.dataset.id = t.id;

    const chips = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model">${esc(t.model === 'default' ? (t.resolvedModel || 'default') : t.model)}</span>`,
    ];
    if (t.status === 'grooming') chips.push(`<span class="chip grooming-chip" title="Grooming a rough idea into a task prompt">${icon('lightbulb')} grooming</span>`);
    if (t.useWorktree) chips.push(`<span class="chip worktree" title="${esc(t.worktreePath || 'worktree on dispatch')}">${icon('git-branch')} ${esc(t.branch || t.branchName || 'worktree')}</span>`);
    if (t.addons && t.addons.includes('pull_request')) chips.push(`<span class="chip addon-chip" title="Opens a pull request when finished">${icon('git-pull-request')} PR</span>`);
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

    let statusRow = '';
    if (isLive(t)) {
      statusRow = `
        <div class="card-status">
          <span class="spinner"></span>
          ${t.status === 'grooming' ? '<span class="live-label">grooming</span>' : ''}
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
    return el;
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
    // Grooming is entered only via "Brief an Idea", never by dragging a card in.
    if (colKey === 'grooming') return;
    try {
      if (colKey === 'running') {
        if (t.status === 'backlog' || t.status === 'ready') {
          await api('POST', `/api/tasks/${t.id}/dispatch`);
        } else if (t.sessionId) {
          openFollowupModal(t); // finished tasks continue their session
        }
      } else if (t.status !== 'running') {
        await api('PATCH', `/api/tasks/${t.id}`, { status: colKey });
      }
    } catch (e) { toast(e.message); }
  }

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

  function closeDrawer() {
    state.openTaskId = null;
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
    const list = taskId ? pendingPermissions(taskId) : [];
    if (!list.length) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = list.map((r) => {
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

  // One delegated handler for every Allow/Deny button in the prompts box.
  $('#permission-prompts').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-perm]');
    if (!btn || !state.openTaskId) return;
    decidePermission(state.openTaskId, btn.dataset.req, btn.dataset.perm);
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

  function renderDrawerHead(t) {
    $('#drawer-title').textContent = t.title;
    const meta = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model">${esc(t.resolvedModel || t.model)}</span>`,
      `<span class="chip">${esc(t.permissionMode)}</span>`,
    ];
    if (t.promptPermissions) meta.push(`<span class="chip" title="Asks you to approve otherwise-denied tools">${icon('shield')} asks</span>`);
    if (t.linearIssue && t.linearIssue.identifier) {
      meta.push(`<a class="chip linear-chip" href="${esc(t.linearIssue.url)}" target="_blank" rel="noopener" title="Open in Linear">${icon('linear')} ${esc(t.linearIssue.identifier)}</a>`);
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

    // The prompt block — always visible, even for a task that never ran. Briefed
    // tasks show the original idea and, once groomed, the resulting prompt too.
    const promptEl = $('#drawer-prompt');
    const blocks = [];
    if (t.brief) {
      const ideaTag = t.status === 'grooming' ? 'IDEA — GROOMING…' : 'IDEA';
      blocks.push(`<div class="tag">${ideaTag}</div><div class="drawer-prompt-body">${esc(t.brief)}</div>`);
      if (t.prompt && t.prompt !== t.brief) {
        blocks.push(`<div class="tag">GROOMED PROMPT</div><div class="drawer-prompt-body">${esc(t.prompt)}</div>`);
      }
    } else if (t.prompt) {
      blocks.push(`<div class="tag">ORIGINAL PROMPT</div><div class="drawer-prompt-body">${esc(t.prompt)}</div>`);
    }
    if (blocks.length) {
      promptEl.classList.remove('hidden');
      promptEl.innerHTML = blocks.join('');
    } else {
      promptEl.classList.add('hidden');
      promptEl.innerHTML = '';
    }

    const actions = [];
    if (isLive(t)) {
      actions.push(`<button class="btn danger" data-act="stop">${icon('square')} Stop</button>`);
    } else {
      if (t.status === 'backlog' || t.status === 'ready') actions.push(`<button class="btn primary" data-act="dispatch">${icon('play')} Run</button>`);
      actions.push(`<button class="btn ghost" data-act="edit">${icon('pencil')} Edit</button>`);
      actions.push(`<button class="btn ghost" data-act="archive">Archive</button>`);
    }
    if (t.worktreePath) {
      actions.push(`<button class="btn ghost" data-act="copy-wt" title="${esc(t.worktreePath)}">Copy worktree path</button>`);
      if (!isLive(t)) actions.push(`<button class="btn ghost danger" data-act="rm-wt">Remove worktree</button>`);
    }
    const box = $('#drawer-actions');
    box.innerHTML = actions.join('');
    box.onclick = async (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      try {
        if (act === 'stop') await api('POST', `/api/tasks/${t.id}/stop`);
        if (act === 'edit') { openTaskModal(t); return; }
        if (act === 'dispatch') await api('POST', `/api/tasks/${t.id}/dispatch`);
        if (act === 'archive') { await api('POST', `/api/tasks/${t.id}/archive`); closeDrawer(); }
        if (act === 'copy-wt') { await navigator.clipboard.writeText(t.worktreePath); toast('Worktree path copied', 'info'); }
        if (act === 'rm-wt') { await api('POST', `/api/tasks/${t.id}/worktree/remove`); toast('Worktree removed', 'info'); }
      } catch (err) { toast(err.message); }
    };

    const canFollowup = !isLive(t) && !!t.sessionId;
    $('#followup-input').disabled = !canFollowup;
    $('#followup-send').disabled = !canFollowup;
    $('#followup-input').placeholder = isLive(t)
      ? (t.status === 'grooming' ? 'Grooming the idea…' : 'Task is running…')
      : t.sessionId ? 'Send a follow-up to this session…' : 'Run the task first to start a session';
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
      const verb = allowed ? 'Allowed' : 'Denied';
      const why = !allowed && ev.decision && ev.decision.message ? ` — ${ev.decision.message}` : '';
      addHtml($('#timeline'), `<div class="ev-meta perm-log ${allowed ? 'ok' : 'no'}">${icon('shield')} ${verb} ${esc(ev.toolName || 'tool')}${esc(why)}</div>`);
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

  // Optional task behaviors — checkboxes derived from the /api/addons catalog.
  // These render below the worktree toggle inside the "Extra behavior" section.
  function renderAddonOptions(selected = []) {
    const chosen = new Set(selected);
    $('#task-addon-list').innerHTML = state.addons.map((a) => `
      <label class="check addon">
        <input type="checkbox" data-addon="${esc(a.id)}" ${chosen.has(a.id) ? 'checked' : ''} />
        <span class="addon-text">
          <span class="addon-label">${esc(a.label)}</span>
          ${a.hint ? `<span class="addon-hint">${esc(a.hint)}</span>` : ''}
        </span>
      </label>`).join('');
  }

  function selectedAddons() {
    return [...document.querySelectorAll('#task-addons input[data-addon]:checked')]
      .map((el) => el.dataset.addon);
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
    renderAddonOptions(task ? (task.addons || []) : (last.addons || []));
    initPersonaPicker(task ? (task.personas || []) : (last.personas || []));
    $('#task-repo-field').classList.toggle('hidden', !!task);
    if (task) $('#task-repo').value = task.repoId;
    // Restore the last-used repo if it still exists in the current list.
    else if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#task-repo').value = last.repoId;
    refreshRepoBranchHint($('#task-repo').value, $('#task-repo-branch'));

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
      addons: selectedAddons(),
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
  $('#task-add-repo').addEventListener('click', () => {
    $('#modal-task').classList.add('hidden');
    openReposModal();
  });
  $('#task-repo').addEventListener('change', () => {
    refreshRepoBranchHint($('#task-repo').value, $('#task-repo-branch'));
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

  function openBriefModal() {
    refreshBriefRepoSelect();
    const last = loadLastUsed();
    $('#brief-text').value = '';
    $('#brief-branch').value = '';
    $('#brief-model').value = last.model || 'default';
    if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#brief-repo').value = last.repoId;
    refreshRepoBranchHint($('#brief-repo').value, $('#brief-repo-branch'));
    $('#modal-brief').classList.remove('hidden');
    $('#brief-text').focus();
  }

  async function submitBrief() {
    const brief = $('#brief-text').value.trim();
    const repoId = $('#brief-repo').value;
    if (!brief) { toast('Describe your idea first'); return; }
    if (!repoId) { toast('Add a repository first'); return; }
    try {
      const task = await api('POST', '/api/briefs', {
        brief, repoId, model: $('#brief-model').value, branchName: $('#brief-branch').value.trim(),
      });
      $('#modal-brief').classList.add('hidden');
      toast('Grooming your idea into a task…', 'info');
      openDrawer(task.id);
    } catch (e) { toast(e.message); }
  }

  $('#btn-brief').addEventListener('click', openBriefModal);
  $('#brief-cancel').addEventListener('click', () => $('#modal-brief').classList.add('hidden'));
  $('#brief-submit').addEventListener('click', submitBrief);
  $('#brief-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitBrief();
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
    if (last.repoId && state.repos.some((r) => r.id === last.repoId)) $('#linear-repo').value = last.repoId;
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
      const task = await api('POST', '/api/linear/briefs', {
        issueId, repoId, model: $('#linear-model').value, branchName: $('#linear-branch').value.trim(),
      });
      $('#modal-linear').classList.add('hidden');
      toast('Importing the Linear issue…', 'info');
      openDrawer(task.id);
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
    openSettingsModal();
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

  const LIVE_STATUSES = new Set(['running', 'grooming']);
  // Browser fallback: notify when a task leaves a live state (finished/failed/
  // groomed). Under Electron the shell handles this natively, so skip it here.
  function maybeNotifyBrowser(prev, task) {
    if (isElectron || !notificationsOn()) return;
    if (!prev || !LIVE_STATUSES.has(prev.status) || LIVE_STATUSES.has(task.status)) return;
    if (task.lastOutcome === 'stopped') return;
    let title, body;
    if (task.status === 'failed') {
      title = `Task failed — ${task.title}`;
      body = task.lastError ? String(task.lastError).slice(0, 140) : task.repoName;
    } else if (task.lastOutcome === 'groomed') {
      title = `Idea groomed — ${task.title}`;
      body = `${task.repoName} · ready to run`;
    } else {
      title = `Task finished — ${task.title}`;
      body = task.repoName;
    }
    showBrowserNotification(title, { body, tag: `srpopo-${task.id}` });
  }

  // Play a cue when a task leaves a live state — in both browser and Electron
  // (unlike notifications, the tray shell doesn't sound these itself).
  function maybePlayTaskSound(prev, task) {
    if (!prev || !LIVE_STATUSES.has(prev.status) || LIVE_STATUSES.has(task.status)) return;
    if (task.lastOutcome === 'stopped' || task.lastOutcome === 'groomed') return;
    playSound(task.status === 'failed' ? 'failed' : 'finish');
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

  // Reflect the redacted `linearConfigured` flag — we never render the raw token
  // back into the DOM. The password field always starts empty; typing a value
  // and saving replaces the stored key.
  function updateLinearSettingNote() {
    const note = $('#setting-linear-note');
    note.textContent = linearConfigured()
      ? 'A Linear API key is saved. Enter a new one to replace it, or clear it.'
      : 'Create a personal API key in Linear (Settings → Security & access → Personal API keys).';
    $('#setting-linear-clear').classList.toggle('hidden', !linearConfigured());
  }

  function openSettingsModal() {
    $('#setting-notifications').checked = notificationsOn();
    $('#setting-sounds').checked = soundsOn();
    updateNotifNote();
    $('#setting-linear-token').value = '';
    updateLinearSettingNote();
    $('#modal-settings').classList.remove('hidden');
  }

  async function saveSettings(patch) {
    try {
      state.settings = await api('PATCH', '/api/settings', patch);
    } catch (e) { toast(e.message); }
  }

  $('#btn-settings').addEventListener('click', openSettingsModal);
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
  $('#setting-linear-save').addEventListener('click', async () => {
    const token = $('#setting-linear-token').value.trim();
    if (!token) { toast('Paste your Linear API key first'); return; }
    await saveSettings({ linearApiToken: token });
    $('#setting-linear-token').value = '';
    updateLinearSettingNote();
    toast('Linear API key saved', 'info');
  });
  $('#setting-linear-clear').addEventListener('click', async () => {
    await saveSettings({ linearApiToken: '' });
    $('#setting-linear-token').value = '';
    updateLinearSettingNote();
    toast('Linear API key cleared', 'info');
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
  $('#filter-repos').addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    const id = pill.dataset.repo;
    if (state.filters.repoIds.has(id)) state.filters.repoIds.delete(id);
    else state.filters.repoIds.add(id);
    onFiltersChanged();
  });
  $('#filter-search').addEventListener('input', (e) => {
    state.filters.search = e.target.value.trim().toLowerCase();
    saveFilters();
    renderBoard();
  });
  $('#filter-clear').addEventListener('click', () => {
    state.filters.search = '';
    state.filters.repoIds.clear();
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

  // ---------- drawer close ----------
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#drawer-overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
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
        if (state.openTaskId === msg.task.id) renderDrawerHead(msg.task);
        maybeNotifyBrowser(prev, msg.task);
        maybePlayTaskSound(prev, msg.task);
      } else if (msg.type === 'settings') {
        state.settings = msg.settings;
        if (!$('#modal-settings').classList.contains('hidden')) {
          $('#setting-notifications').checked = notificationsOn();
          $('#setting-sounds').checked = soundsOn();
          updateNotifNote();
          updateLinearSettingNote();
        }
        if (!$('#modal-linear').classList.contains('hidden')) renderLinearConfigState();
      } else if (msg.type === 'task-removed') {
        state.tasks.delete(msg.taskId);
        renderBoard();
      } else if (msg.type === 'repos') {
        state.repos = msg.repos;
        renderRepoList();
        refreshRepoSelect();
        refreshBriefRepoSelect();
        refreshLinearRepoSelect();
        renderFilters();
      } else if (msg.type === 'log' && msg.taskId === state.openTaskId) {
        appendEvent(msg.event);
      } else if (msg.type === 'permission') {
        applyPermissionEvent(msg);
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
      const { repos, tasks, settings } = await api('GET', '/api/state');
      state.repos = repos;
      state.tasks = new Map(tasks.map((t) => [t.id, t]));
      // Seed live tool-approval prompts, then drop the transient field off the task.
      state.permissions = new Map();
      for (const t of tasks) {
        if (t.pendingPermissions && t.pendingPermissions.length) state.permissions.set(t.id, t.pendingPermissions);
        delete t.pendingPermissions;
      }
      if (settings) state.settings = settings;
      loadFilters();
      $('#filter-search').value = state.filters.search;
      renderFilters();
      renderBoard();
      handleHashDeeplink();
    } catch (e) { toast(`Failed to load state: ${e.message}`); }

    try {
      state.addons = await api('GET', '/api/addons');
    } catch { state.addons = []; }

    try {
      state.personas = await api('GET', '/api/personas');
    } catch { state.personas = []; }

    try {
      const h = await api('GET', '/api/health');
      const chip = $('#health');
      chip.textContent = h.ok ? `● ${h.claude}` : '● claude CLI not found';
      chip.classList.add(h.ok ? 'ok' : 'bad');
    } catch { /* server down; toast already shown */ }

    connectSSE();
  }

  initTheme();
  boot();
})();
