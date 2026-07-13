const { spawn } = require('child_process');
const readline = require('readline');

const { db, save, now, appendLog } = require('./store');
const { broadcast } = require('./bus');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

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

function buildArgs(task, resume) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (task.model && task.model !== 'default') args.push('--model', task.model);
  if (task.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  else if (task.permissionMode && task.permissionMode !== 'default') args.push('--permission-mode', task.permissionMode);
  if (resume && task.sessionId) args.push('--resume', task.sessionId);
  return args;
}

/**
 * Dispatch a task: spawn `claude -p` in the task's working directory and
 * stream its NDJSON output into the task log + SSE bus.
 * `prompt` is the text sent on stdin; `resume` continues an existing session.
 */
function dispatch(task, prompt, { resume = false } = {}) {
  if (running.has(task.id)) throw new Error('Task is already running');

  const workDir = task.worktreePath || task.repoPath;
  const args = buildArgs(task, resume);

  task.status = 'running';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  record(task, { type: 'prompt', text: prompt, resume, run: task.runCount });

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
    task.finishedAt = now();
    task.activeSubagents = 0;

    if (signal || child.wasStopped) {
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
    emitTask(task);
  });

  return task;
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

module.exports = { dispatch, stop, stopAll, isRunning, CLAUDE_BIN };
