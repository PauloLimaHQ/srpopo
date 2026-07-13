const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');

const { db, save, now, appendLog } = require('./store');
const { broadcast } = require('./bus');
const groomer = require('./groomer');
const addons = require('./addons');
const permissions = require('./permissions');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Tools every dispatched task gets auto-approved. The common package managers are
// safe, near-universal build steps (install, lint, test, build); allowing them by
// default means a run doesn't silently finish without doing the work just because
// `acceptEdits` would have blocked the Bash call. Add-ons layer their own tools on
// top of these (see addons.allowedToolsFor).
const DEFAULT_ALLOWED_TOOLS = ['Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)'];

// Interactive permission prompting (see permissions.js + permission-mcp.js). When
// a task opts in, we register our MCP bridge and tell the CLI to route any tool it
// would otherwise auto-deny through it, so the user can approve from the board.
const MCP_SERVER_NAME = 'srpopo';
const PERMISSION_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
const PERMISSION_MCP_SCRIPT = path.join(__dirname, 'permission-mcp.js');

// The server's own base URL, set once the port is known (see index.start). The
// permission bridge POSTs approval requests back here.
let baseUrl = null;
function setBaseUrl(url) { baseUrl = url; }
function resolvedBaseUrl() {
  return baseUrl || `http://127.0.0.1:${process.env.PORT || 7777}`;
}

// The `--mcp-config` JSON that registers the permission bridge for a task. The
// bridge runs as plain Node even inside the packaged Electron binary via
// ELECTRON_RUN_AS_NODE, and learns where to POST via SRPOPO_APPROVAL_URL.
function permissionMcpConfig(task) {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: process.execPath,
        args: [PERMISSION_MCP_SCRIPT],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          SRPOPO_APPROVAL_URL: `${resolvedBaseUrl()}/api/tasks/${task.id}/permission`,
        },
      },
    },
  });
}

// taskId -> child process
const running = new Map();

function isRunning(taskId) {
  return running.has(taskId);
}

function childEnv() {
  const env = { ...process.env };
  // Force subscription auth: never let an API key leak into task runs.
  delete env.ANTHROPIC_API_KEY;
  // Avoid nested-session detection when Sr. Popo itself is launched from Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function emitTask(task) {
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
}

function record(task, event) {
  event.ts = event.ts || now();
  appendLog(task.id, event);
  broadcast({ type: 'log', taskId: task.id, event });
}

// Normalize a free-text allow-list into a clean comma-joined string for
// `--allowedTools`. Patterns may contain spaces (e.g. `Bash(npm run lint:*)`),
// so we split only on commas and newlines — never spaces.
function normalizeAllowedTools(value) {
  if (typeof value !== 'string') return '';
  const list = value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.join(',').slice(0, 2000);
}

// Merge any number of allow-list sources (comma/newline strings or arrays of
// patterns) into one deduped, comma-joined `--allowedTools` value. Order is
// preserved and the total is capped like normalizeAllowedTools.
function mergeAllowedTools(...sources) {
  const seen = new Set();
  const out = [];
  for (const src of sources) {
    const list = Array.isArray(src) ? src : String(src || '').split(/[,\n]/);
    for (const raw of list) {
      const tool = String(raw).trim();
      if (tool && !seen.has(tool)) {
        seen.add(tool);
        out.push(tool);
      }
    }
  }
  return out.join(',').slice(0, 2000);
}

// The full set of tools auto-approved for a dispatched task: the user's own
// allow-list, the safe package-manager defaults, and whatever the selected
// add-ons need to run (e.g. `gh` + git for "open a PR").
function effectiveAllowedTools(task) {
  return mergeAllowedTools(
    task.allowedTools,
    DEFAULT_ALLOWED_TOOLS,
    addons.allowedToolsFor(task.addons),
  );
}

function buildArgs(task, resume) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (task.model && task.model !== 'default') args.push('--model', task.model);
  if (task.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (task.permissionMode && task.permissionMode !== 'default') args.push('--permission-mode', task.permissionMode);
  const allow = effectiveAllowedTools(task);
  if (allow) args.push('--allowedTools', allow);
  // Opt-in: route otherwise-denied tools to an interactive approval prompt rather
  // than auto-denying them. Skipped under bypassPermissions (nothing to prompt).
  if (task.promptPermissions && task.permissionMode !== 'bypassPermissions') {
    args.push('--permission-prompt-tool', PERMISSION_TOOL);
    args.push('--mcp-config', permissionMcpConfig(task));
  }
  if (resume && task.sessionId) args.push('--resume', task.sessionId);
  return args;
}

// Read-only args for a grooming session: it explores the repo to write a better
// prompt but must never modify it. Only the safe research tools are auto-approved
// in this headless run, so any write tool is denied.
function groomArgs(task) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (task.model && task.model !== 'default') args.push('--model', task.model);
  args.push('--allowedTools', 'Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*)');
  return args;
}

/**
 * Spawn `claude -p` for a task and stream its NDJSON output into the task log +
 * SSE bus. Shared by dispatch (running) and groom (grooming): the caller sets
 * the task's starting fields and provides `resolveExit`, which decides the final
 * status once the process exits (the process error/cleanup path is handled here).
 */
function launch(task, { args, workDir, prompt, promptEvent, resolveExit }) {
  if (running.has(task.id)) throw new Error('Task is already running');

  record(task, promptEvent);

  const child = spawn(CLAUDE_BIN, args, {
    cwd: workDir,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.set(task.id, child);

  child.stdin.on('error', () => {}); // claude may exit before reading stdin
  child.stdin.write(prompt);
  child.stdin.end();

  let sawResult = null;
  let stderrTail = '';
  const openSubagents = new Set();

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      record(task, { type: 'raw', text: line });
      return;
    }

    // Keep hot task fields in sync with the session stream.
    if (event.type === 'system' && event.subtype === 'init') {
      task.sessionId = event.session_id || task.sessionId;
      task.resolvedModel = event.model || task.resolvedModel;
      emitTask(task);
    } else if (event.type === 'assistant') {
      const blocks = (event.message && event.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name === 'Task' && !event.parent_tool_use_id) {
          openSubagents.add(b.id);
          task.activeSubagents = openSubagents.size;
          emitTask(task);
        }
      }
    } else if (event.type === 'user') {
      const blocks = (event.message && event.message.content) || [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_result' && openSubagents.delete(b.tool_use_id)) {
            task.activeSubagents = openSubagents.size;
            emitTask(task);
          }
        }
      }
    } else if (event.type === 'result') {
      sawResult = event;
      task.costUsd = (task.costUsd || 0) + (event.total_cost_usd || 0);
      task.numTurns = event.num_turns;
      task.durationMs = event.duration_ms;
      emitTask(task);
    }

    record(task, event);
  });

  const rlErr = readline.createInterface({ input: child.stderr });
  rlErr.on('line', (line) => {
    stderrTail = (stderrTail + '\n' + line).slice(-4000);
    record(task, { type: 'stderr', text: line });
  });

  child.on('error', (err) => {
    running.delete(task.id);
    task.status = 'failed';
    task.lastOutcome = 'error';
    task.lastError = `Failed to launch claude: ${err.message}`;
    task.finishedAt = now();
    task.activeSubagents = 0;
    record(task, { type: 'proc', text: task.lastError });
    emitTask(task);
  });

  child.on('exit', (code, signal) => {
    running.delete(task.id);
    // Deny any prompts still waiting — the child that asked is gone.
    permissions.rejectForTask(task.id, 'Run ended');
    task.finishedAt = now();
    task.activeSubagents = 0;
    resolveExit({ code, signal, stopped: !!child.wasStopped, sawResult, stderrTail });
    emitTask(task);
  });

  return task;
}

/**
 * Dispatch a task: spawn `claude -p` in the task's working directory and
 * stream its NDJSON output into the task log + SSE bus.
 * `prompt` is the text sent on stdin; `resume` continues an existing session.
 */
function dispatch(task, prompt, { resume = false } = {}) {
  if (running.has(task.id)) throw new Error('Task is already running');

  task.status = 'running';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  return launch(task, {
    args: buildArgs(task, resume),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, resume, run: task.runCount },
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      if (signal || stopped) {
        task.status = 'ready';
        task.lastOutcome = 'stopped';
        task.lastError = 'Stopped by user';
        record(task, { type: 'proc', text: 'Run stopped by user' });
      } else if (sawResult && !sawResult.is_error) {
        task.status = 'review';
        task.lastOutcome = 'success';
        record(task, { type: 'proc', text: `Run finished (exit ${code})` });
      } else {
        task.status = 'failed';
        task.lastOutcome = 'error';
        task.lastError =
          (sawResult && (sawResult.result || sawResult.subtype)) ||
          stderrTail.trim().split('\n').pop() ||
          `claude exited with code ${code}`;
        record(task, { type: 'proc', text: `Run failed (exit ${code}): ${task.lastError}` });
      }
    },
  });
}

/**
 * Groom a task: run a short, read-only `claude -p` session in the repo that
 * rewrites the rough `brief` into a well-structured prompt. On success the task
 * moves to `ready` with the groomed title/prompt; the `grooming` status (like
 * `running`) is entered only here, never via the API.
 */
function groom(task, brief) {
  if (running.has(task.id)) throw new Error('Task is already running');

  task.status = 'grooming';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  const prompt = groomer.metaPrompt(brief);

  return launch(task, {
    args: groomArgs(task),
    workDir: task.repoPath, // grooming is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, groom: true, run: task.runCount },
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      // The grooming session is an internal, read-only planning session; the task
      // must never resume it (a resume would run with edit perms in the main repo,
      // not a worktree). Drop its session id so dispatch always starts fresh.
      task.sessionId = null;

      if (signal || stopped) {
        // Park a stopped grooming session in backlog with the rough idea intact.
        task.status = 'backlog';
        task.lastOutcome = 'stopped';
        task.lastError = 'Grooming stopped by user';
        record(task, { type: 'proc', text: 'Grooming stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.is_error;
      const resultText = succeeded && typeof sawResult.result === 'string' ? sawResult.result : '';
      const spec = succeeded ? groomer.parseResult(resultText) : null;
      if (spec || (succeeded && resultText.trim())) {
        // Drop the grooming run metrics so a groomed task reads as "not yet run"
        // (the grooming cost stays on costUsd as a real spend).
        task.numTurns = null;
        task.durationMs = null;
        task.status = 'ready';
        task.lastOutcome = 'groomed';
      }
      if (spec) {
        task.title = spec.title || task.title;
        task.prompt = spec.prompt;
        record(task, { type: 'proc', text: 'Groomed the idea into a ready task' });
      } else if (succeeded && resultText.trim()) {
        // Session finished but we couldn't parse a structured spec — keep the
        // full text as the prompt so nothing is lost, and still move to Ready.
        task.prompt = resultText.trim();
        record(task, { type: 'proc', text: 'Grooming finished (kept unstructured output as the prompt)' });
      } else {
        task.status = 'failed';
        task.lastOutcome = 'error';
        task.lastError =
          (sawResult && (sawResult.result || sawResult.subtype)) ||
          stderrTail.trim().split('\n').pop() ||
          `claude exited with code ${code}`;
        record(task, { type: 'proc', text: `Grooming failed (exit ${code}): ${task.lastError}` });
      }
    },
  });
}

function stop(taskId) {
  const child = running.get(taskId);
  if (!child) return false;
  child.wasStopped = true;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running.has(taskId)) child.kill('SIGKILL');
  }, 5000);
  return true;
}

function stopAll() {
  for (const [taskId] of running) stop(taskId);
}

module.exports = {
  dispatch,
  groom,
  stop,
  stopAll,
  isRunning,
  buildArgs,
  normalizeAllowedTools,
  mergeAllowedTools,
  effectiveAllowedTools,
  setBaseUrl,
  PERMISSION_TOOL,
  DEFAULT_ALLOWED_TOOLS,
  CLAUDE_BIN,
};
