/* Sr. Popo — frontend. No build step, no dependencies. */
(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    repos: [],
    tasks: new Map(), // id -> task
    openTaskId: null, // task shown in drawer
  };

  const COLUMNS = [
    { key: 'backlog', label: 'Backlog', dot: '#8b93a8' },
    { key: 'ready', label: 'Ready', dot: '#60a5fa' },
    { key: 'running', label: 'Running', dot: '#e0a93e' },
    { key: 'review', label: 'Review', dot: '#8b7cf6' },
    { key: 'done', label: 'Done', dot: '#4ade80' },
  ];
  // failed tasks are surfaced in the Review column with a FAILED badge
  const COLUMN_OF_STATUS = {
    backlog: 'backlog', ready: 'ready', running: 'running',
    review: 'review', failed: 'review', done: 'done',
  };

  const $ = (sel) => document.querySelector(sel);

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

  function fmtDuration(ms) {
    if (ms == null) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  function elapsedSince(iso) {
    return fmtDuration(Date.now() - new Date(iso).getTime());
  }

  // ---------- board ----------
  function renderBoard() {
    const board = $('#board');
    board.innerHTML = '';
    for (const col of COLUMNS) {
      const tasks = [...state.tasks.values()]
        .filter((t) => COLUMN_OF_STATUS[t.status] === col.key)
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
        const hint = col.key === 'running' ? 'drag a card here to dispatch' : 'empty';
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
    el.className = `card ${t.status === 'running' ? 'running' : ''} ${t.status === 'failed' ? 'failed' : ''}`;
    el.draggable = t.status !== 'running';
    el.dataset.id = t.id;

    const chips = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model">${esc(t.model === 'default' ? (t.resolvedModel || 'default') : t.model)}</span>`,
    ];
    if (t.useWorktree) chips.push(`<span class="chip worktree" title="${esc(t.worktreePath || 'worktree on dispatch')}">🌿 ${esc(t.branch || 'worktree')}</span>`);
    if (t.costUsd > 0) chips.push(`<span class="chip cost">$${t.costUsd.toFixed(2)}</span>`);
    if (t.status === 'failed') chips.push(`<span class="chip badge-failed">FAILED</span>`);
    if (t.lastOutcome === 'stopped') chips.push(`<span class="chip badge-stopped">stopped</span>`);
    if (t.status === 'running' && t.activeSubagents > 0) {
      chips.push(`<span class="chip subagents">🤖 ${t.activeSubagents} subagent${t.activeSubagents > 1 ? 's' : ''}</span>`);
    }

    let statusRow = '';
    if (t.status === 'running') {
      statusRow = `
        <div class="card-status">
          <span class="spinner"></span>
          <span class="elapsed" data-start="${esc(t.startedAt)}">${elapsedSince(t.startedAt)}</span>
          <button class="btn icon danger card-stop" data-action="stop" title="Stop run">■</button>
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
      if (e.target.dataset.action === 'stop') { stopTask(t.id); return; }
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
      $('#timeline').innerHTML = '';
      for (const ev of events) appendEvent(ev);
      scrollTimeline();
    } catch (e) { toast(e.message); }
  }

  function closeDrawer() {
    state.openTaskId = null;
    $('#drawer').classList.add('hidden');
    $('#drawer-overlay').classList.add('hidden');
  }

  function renderDrawerHead(t) {
    $('#drawer-title').textContent = t.title;
    const meta = [
      `<span class="chip repo">${esc(t.repoName)}</span>`,
      `<span class="chip model">${esc(t.resolvedModel || t.model)}</span>`,
      `<span class="chip">${esc(t.permissionMode)}</span>`,
    ];
    if (t.worktreePath) meta.push(`<span class="chip worktree" title="${esc(t.worktreePath)}">🌿 ${esc(t.branch)}</span>`);
    if (t.sessionId) meta.push(`<span class="chip" title="session id">${esc(t.sessionId.slice(0, 8))}…</span>`);
    if (t.costUsd > 0) meta.push(`<span class="chip cost">$${t.costUsd.toFixed(2)} total</span>`);
    if (t.numTurns != null) meta.push(`<span class="chip">${t.numTurns} turns</span>`);
    $('#drawer-meta').innerHTML = meta.join('');

    const actions = [];
    if (t.status === 'running') {
      actions.push(`<button class="btn danger" data-act="stop">■ Stop</button>`);
    } else {
      if (t.status === 'backlog' || t.status === 'ready') actions.push(`<button class="btn primary" data-act="dispatch">▶ Run</button>`);
      actions.push(`<button class="btn ghost" data-act="archive">Archive</button>`);
    }
    if (t.worktreePath) {
      actions.push(`<button class="btn ghost" data-act="copy-wt" title="${esc(t.worktreePath)}">Copy worktree path</button>`);
      if (t.status !== 'running') actions.push(`<button class="btn ghost danger" data-act="rm-wt">Remove worktree</button>`);
    }
    const box = $('#drawer-actions');
    box.innerHTML = actions.join('');
    box.onclick = async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      try {
        if (act === 'stop') await api('POST', `/api/tasks/${t.id}/stop`);
        if (act === 'dispatch') await api('POST', `/api/tasks/${t.id}/dispatch`);
        if (act === 'archive') { await api('POST', `/api/tasks/${t.id}/archive`); closeDrawer(); }
        if (act === 'copy-wt') { await navigator.clipboard.writeText(t.worktreePath); toast('Worktree path copied', 'info'); }
        if (act === 'rm-wt') { await api('POST', `/api/tasks/${t.id}/worktree/remove`); toast('Worktree removed', 'info'); }
      } catch (err) { toast(err.message); }
    };

    const canFollowup = t.status !== 'running' && !!t.sessionId;
    $('#followup-input').disabled = !canFollowup;
    $('#followup-send').disabled = !canFollowup;
    $('#followup-input').placeholder = t.status === 'running'
      ? 'Task is running…'
      : t.sessionId ? 'Send a follow-up to this session…' : 'Run the task first to start a session';
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
      addHtml(containerFor(ev), `
        <div class="ev-prompt">
          <span class="tag">${ev.resume ? 'FOLLOW-UP' : 'PROMPT'} · run ${ev.run || 1}</span>${esc(ev.text)}
        </div>`);
    } else if (type === 'system' && ev.subtype === 'init') {
      addHtml(containerFor(ev), `<div class="ev-meta">⚡ session started · ${esc(ev.model || '')} · ${esc((ev.session_id || '').slice(0, 8))}</div>`);
    } else if (type === 'assistant') {
      const blocks = (ev.message && ev.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text && b.text.trim()) {
          addHtml(containerFor(ev), `<div class="ev-text">${esc(b.text)}</div>`);
        } else if (b.type === 'thinking' && b.thinking) {
          addHtml(containerFor(ev), `
            <details class="ev-thinking"><summary>💭 thinking</summary><pre>${esc(b.thinking)}</pre></details>`);
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
      const icon = ev.is_error ? '✖' : '✔';
      const text = typeof ev.result === 'string' ? ev.result : (ev.subtype || '');
      addHtml($('#timeline'), `
        <div class="ev-result ${cls}">
          ${icon} ${esc(String(text).slice(0, 600))}
          <div class="stats">${fmtDuration(ev.duration_ms)} · ${ev.num_turns ?? '?'} turns · $${(ev.total_cost_usd || 0).toFixed(2)}</div>
        </div>`);
    } else if (type === 'stderr') {
      addHtml($('#timeline'), `<div class="ev-stderr">${esc(ev.text)}</div>`);
    } else if (type === 'proc') {
      addHtml($('#timeline'), `<div class="ev-meta">⏹ ${esc(ev.text)}</div>`);
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
        <div class="subagent-head">🤖 ${esc(block.input?.description || 'subagent')}
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
        <span class="tool-state">⏳</span>
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
      sa.head.textContent = block.is_error ? 'failed' : 'done ✔';
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
    row.querySelector('.tool-state').textContent = block.is_error ? '✖' : '✔';
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

  function openTaskModal() {
    refreshRepoSelect();
    $('#task-title').value = '';
    $('#task-prompt').value = '';
    $('#modal-task').classList.remove('hidden');
    $('#task-title').focus();
  }

  async function createTask(run) {
    const repoId = $('#task-repo').value;
    if (!repoId) { toast('Add a repository first'); return; }
    const payload = {
      repoId,
      title: $('#task-title').value.trim(),
      prompt: $('#task-prompt').value.trim(),
      model: $('#task-model').value,
      permissionMode: $('#task-perm').value,
      useWorktree: $('#task-worktree').checked,
      status: run ? 'ready' : 'backlog',
    };
    if (!payload.title || !payload.prompt) { toast('Title and prompt are required'); return; }
    try {
      const task = await api('POST', '/api/tasks', payload);
      $('#modal-task').classList.add('hidden');
      if (run) await api('POST', `/api/tasks/${task.id}/dispatch`);
    } catch (e) { toast(e.message); }
  }

  $('#btn-new-task').addEventListener('click', openTaskModal);
  $('#task-cancel').addEventListener('click', () => $('#modal-task').classList.add('hidden'));
  $('#task-create').addEventListener('click', () => createTask(false));
  $('#task-create-run').addEventListener('click', () => createTask(true));
  $('#task-add-repo').addEventListener('click', () => {
    $('#modal-task').classList.add('hidden');
    openReposModal();
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
        <button class="btn icon danger" title="Remove">✕</button>`;
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
        state.tasks.set(msg.task.id, msg.task);
        renderBoard();
        if (state.openTaskId === msg.task.id) renderDrawerHead(msg.task);
      } else if (msg.type === 'task-removed') {
        state.tasks.delete(msg.taskId);
        renderBoard();
      } else if (msg.type === 'repos') {
        state.repos = msg.repos;
        renderRepoList();
        refreshRepoSelect();
      } else if (msg.type === 'log' && msg.taskId === state.openTaskId) {
        appendEvent(msg.event);
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do.
    };
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const { repos, tasks } = await api('GET', '/api/state');
      state.repos = repos;
      state.tasks = new Map(tasks.map((t) => [t.id, t]));
      renderBoard();
    } catch (e) { toast(`Failed to load state: ${e.message}`); }

    try {
      const h = await api('GET', '/api/health');
      const chip = $('#health');
      chip.textContent = h.ok ? `● ${h.claude}` : '● claude CLI not found';
      chip.classList.add(h.ok ? 'ok' : 'bad');
    } catch { /* server down; toast already shown */ }

    connectSSE();
  }

  boot();
})();
