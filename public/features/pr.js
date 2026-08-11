/* Sr. Popo — pr. No build step: native ES module. */
import { api, esc, fmtDuration, mdToHtml } from '../core/api.js';
import { $, icon, state } from '../core/state.js';
import { renderBoard } from './board.js';
import { renderDrawerHead } from './context-menu.js';
import { timeline } from './drawer.js';


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
  renderBoard(); // keep the card's PR chip color in sync too
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

// Grok streams its answer as `text` / `thought` DELTAS — a few words per event —
// rather than whole messages (see server/agents/grok.ts). Rendering one div per
// delta would shred the timeline, so consecutive chunks of the same kind fold
// into a single growing block, and any other event closes it (see closeGrokDelta)
// so everything stays in stream order. Replaying a stored log rebuilds the same
// blocks, because the events arrive in the same order they did live.
function appendGrokDelta(kind, chunk) {
  if (!chunk) return;
  const open = timeline.stream;
  if (!open || open.kind !== kind) {
    const html = kind === 'thought'
      ? `<details class="ev-thinking" open><summary>${icon('brain')} thinking</summary><pre></pre></details>`
      : '<div class="ev-text md"></div>';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const el = tpl.content.firstElementChild;
    $('#timeline').appendChild(el);
    // `body` is what the text goes into; for a thought that's the inner <pre>.
    timeline.stream = { kind, text: '', body: kind === 'thought' ? el.querySelector('pre') : el };
  }
  const block = timeline.stream;
  block.text += chunk;
  // Re-render the whole accumulated block: markdown can't be parsed one delta at
  // a time (a fence or a list only makes sense whole), and a response is small
  // enough that reformatting it per chunk costs nothing.
  if (block.kind === 'thought') block.body.textContent = block.text;
  else block.body.innerHTML = mdToHtml(block.text);
  scrollTimeline();
}

// Stop folding into the current delta block, so the next event renders after it.
function closeGrokDelta() {
  timeline.stream = null;
}

function appendEvent(ev) {
  const type = ev.type;
  if (type !== 'text' && type !== 'thought') closeGrokDelta();
  if (type === 'prompt') {
    const tag = ev.groom ? 'GROOMING' : ev.codeReview ? 'CODE REVIEW' : ev.resume ? 'FOLLOW-UP' : 'PROMPT';
    // The framed prompt is markdown (persona preamble, add-on instructions,
    // the user's own text) — render it, don't dump the source.
    addHtml(containerFor(ev), `
        <div class="ev-prompt md">
          <span class="tag">${tag} · run ${ev.run || 1}</span>${mdToHtml(ev.text)}
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
  } else if (type === 'text' || type === 'thought') {
    // Grok response / reasoning deltas.
    appendGrokDelta(type, ev.data);
  } else if (type === 'end') {
    // Grok's terminal event: the session id and the whole spend report. It has
    // no duration, and a subscription run usually has no dollar cost — show the
    // tokens, and only add the cost when Grok actually stamped one.
    const u = ev.usage || {};
    const cost = ev.total_cost_usd > 0 ? ` · $${ev.total_cost_usd.toFixed(2)}` : '';
    addHtml($('#timeline'), `
        <div class="ev-result">
          ${icon('circle-check')} <span class="md">${esc(ev.stopReason || 'done')}</span>
          <div class="stats">${u.input_tokens || 0} in · ${u.output_tokens || 0} out · ${u.cache_read_input_tokens || 0} cached · ${ev.num_turns ?? '?'} turns${cost}</div>
        </div>`);
  } else if (type === 'max_turns_reached') {
    addHtml($('#timeline'), `<div class="ev-meta">${icon('square')} Stopped: maximum turns reached</div>`);
  } else if (typeof type === 'string' && type.startsWith('auto_compact_')) {
    // Grok compacted its own context mid-run — worth a line, drives nothing.
    addHtml($('#timeline'), `<div class="ev-meta">${icon('square')} context ${esc(type.replace('auto_compact_', 'compact '))}</div>`);
  } else if (type === 'thread.started') {
    // Codex session start (see server/agents/codex.ts for the JSONL schema).
    addHtml(containerFor(ev), `<div class="ev-meta">${icon('zap')} codex session · ${esc((ev.thread_id || '').slice(0, 8))}</div>`);
  } else if (type === 'item.completed') {
    appendCodexItem(ev.item);
  } else if (type === 'turn.completed') {
    const u = ev.usage || {};
    addHtml($('#timeline'), `
        <div class="ev-result">
          ${icon('circle-check')} <span class="md">Turn complete</span>
          <div class="stats">${u.input_tokens || 0} in · ${u.output_tokens || 0} out · ${u.cached_input_tokens || 0} cached</div>
        </div>`);
  } else if (type === 'turn.failed' || type === 'error') {
    const msg = (ev.error && ev.error.message) || ev.message || 'error';
    addHtml($('#timeline'), `
        <div class="ev-result error">${icon('circle-x')} <span class="md">${esc(String(msg).slice(0, 600))}</span></div>`);
  }
}

// Render one Codex `item.completed` payload. Codex reports discrete items
// (assistant message, shell command, reasoning, a non-fatal error note) rather
// than Claude's block stream; we surface the ones worth showing in the timeline.
function appendCodexItem(item) {
  if (!item) return;
  if (item.type === 'agent_message') {
    if (item.text) addHtml($('#timeline'), `<div class="ev-text md">${mdToHtml(item.text)}</div>`);
  } else if (item.type === 'reasoning') {
    if (item.text) addHtml($('#timeline'), `<details class="ev-thinking"><summary>${icon('brain')} thinking</summary><pre>${esc(item.text)}</pre></details>`);
  } else if (item.type === 'command_execution') {
    const ok = item.exit_code === 0;
    addHtml($('#timeline'), `
        <details class="ev-tool"><summary>
          <span class="tool-name">exec</span>
          <span class="tool-summary">${esc(String(item.command || '').slice(0, 120))}</span>
          <span class="tool-state">${ok ? icon('circle-check') : icon('circle-x')}</span>
        </summary>
        <div class="tool-detail"><pre>${esc(String(item.aggregated_output || '').slice(0, 4000))}</pre></div></details>`);
  } else if (item.type === 'error') {
    addHtml($('#timeline'), `<div class="ev-stderr">${esc(item.message || '')}</div>`);
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

export { appendEvent, prChipHtml, refreshPr, refreshRepoBranchForTask, repoBranchChipHtml, scrollTimeline, toolInputSummary };
