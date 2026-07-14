import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import readline from 'readline';
import path from 'path';

import { save, now, appendLog } from './store';
import { broadcast } from './bus';
import * as groomer from './groomer';
import * as addons from './addons';
import * as permissions from './permissions';
import * as usage from './usage';
import type { GroomSpec } from './groomer';
import type { Grooming, LogEvent, Task } from './types';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// Tools every dispatched task gets auto-approved. The common package managers are
// safe, near-universal build steps (install, lint, test, build); allowing them by
// default means a run doesn't silently finish without doing the work just because
// `acceptEdits` would have blocked the Bash call. Add-ons layer their own tools on
// top of these (see addons.allowedToolsFor).
const DEFAULT_ALLOWED_TOOLS = ['Bash(npm:*)', 'Bash(pnpm:*)', 'Bash(yarn:*)'];

// Interactive permission prompting (see permissions.ts + permission-mcp.js). When
// a task opts in, we register our MCP bridge and tell the CLI to route any tool it
// would otherwise auto-deny through it, so the user can approve from the board.
const MCP_SERVER_NAME = 'srpopo';
const PERMISSION_TOOL = `mcp__${MCP_SERVER_NAME}__approve`;
// The bridge stays plain JavaScript so it runs without a TS loader when the CLI
// spawns it as a standalone Node process (in dev under tsx and in the packaged
// app). It sits beside this file in both source (server/) and compiled (dist/
// server/) layouts, so a __dirname-relative path resolves in both.
const PERMISSION_MCP_SCRIPT = path.join(__dirname, 'permission-mcp.js');

// The server's own base URL, set once the port is known (see index.start). The
// permission bridge POSTs approval requests back here.
let baseUrl: string | null = null;
function setBaseUrl(url: string): void { baseUrl = url; }
function resolvedBaseUrl(): string {
  return baseUrl || `http://127.0.0.1:${process.env.PORT || 7777}`;
}

// The `--mcp-config` JSON that registers the permission bridge for a task. The
// bridge runs as plain Node even inside the packaged Electron binary via
// ELECTRON_RUN_AS_NODE, and learns where to POST via SRPOPO_APPROVAL_URL.
function permissionMcpConfig(task: Partial<Task>): string {
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

// A live claude child, tagged so the exit handler can tell a user-requested stop
// (SIGTERM we sent) from a natural exit.
type RunningChild = ChildProcess & { wasStopped?: boolean };

// taskId / groomingId -> child process (tasks and groomings share the pool, so
// runningCount measures every live `claude` child against the parallel cap).
const running = new Map<string, RunningChild>();

// The session-tracking fields Task and Grooming share — everything launch()
// needs to stream a `claude -p` child into the log + SSE bus. `status` is the
// wider string here because the two lifecycles use different unions; each
// caller's resolveExit assigns only its own statuses.
interface SessionRecord {
  id: string;
  status: string;
  sessionId: string | null;
  resolvedModel: string | null;
  costUsd: number;
  numTurns: number | null;
  durationMs: number | null;
  activeSubagents: number;
  lastOutcome: string | null;
  lastError: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

function isRunning(taskId: string): boolean {
  return running.has(taskId);
}

// Count of live `claude` child processes across both dispatched runs and
// grooming sessions (they share the `running` map) — what the max-parallel-
// sessions cap in index.ts measures against.
function runningCount(): number {
  return running.size;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Force subscription auth: never let an API key leak into task runs.
  delete env.ANTHROPIC_API_KEY;
  // Avoid nested-session detection when Sr. Popo itself is launched from Claude Code.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

function emitTask(task: Task): void {
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
}

function emitGrooming(grooming: Grooming): void {
  grooming.updatedAt = now();
  save();
  broadcast({ type: 'grooming', grooming });
}

function record(rec: SessionRecord, event: LogEvent): void {
  event.ts = event.ts || now();
  appendLog(rec.id, event);
  broadcast({ type: 'log', taskId: rec.id, event });
}

// Normalize a free-text allow-list into a clean comma-joined string for
// `--allowedTools`. Patterns may contain spaces (e.g. `Bash(npm run lint:*)`),
// so we split only on commas and newlines — never spaces.
function normalizeAllowedTools(value: unknown): string {
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
function mergeAllowedTools(...sources: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
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
function effectiveAllowedTools(task: Partial<Task>): string {
  return mergeAllowedTools(
    task.allowedTools,
    DEFAULT_ALLOWED_TOOLS,
    addons.allowedToolsFor(task.addons),
  );
}

function buildArgs(task: Partial<Task>, resume: boolean): string[] {
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

// Read-only args for a grooming session: it explores the repo to write better
// prompts but must never modify it. Only the safe research tools are auto-
// approved in this headless run, so any write tool is denied.
function groomArgs(grooming: Pick<Grooming, 'model'>): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (grooming.model && grooming.model !== 'default') args.push('--model', grooming.model);
  args.push('--allowedTools', 'Read,Grep,Glob,Bash(git log:*),Bash(git diff:*),Bash(git show:*)');
  return args;
}

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: boolean;
  sawResult: any;
  stderrTail: string;
}

interface LaunchOpts {
  args: string[];
  workDir: string;
  prompt: string;
  promptEvent: LogEvent;
  // How to persist + broadcast the record after a field change (emitTask for
  // tasks, emitGrooming for grooming cards). Typed loosely so both fit; launch
  // narrows it to its own record type.
  emit: (rec: any) => void;
  resolveExit: (info: ExitInfo) => void;
  // Called after the shared cost/turns/duration bookkeeping on every `result`
  // event, so each lifecycle can extend the usage ledger with its own record
  // shape (dispatch -> usage.applyResult, groom -> usage.applyGroomResult)
  // without launch() itself needing to know which one it's driving.
  onResult?: (event: any) => void;
}

/**
 * Spawn `claude -p` for a task or grooming card and stream its NDJSON output
 * into the session log + SSE bus. Shared by dispatch (running tasks) and groom
 * (grooming cards): the caller sets the record's starting fields and provides
 * `resolveExit`, which decides the final status once the process exits (the
 * process error/cleanup path is handled here).
 */
function launch<T extends SessionRecord>(rec: T, { args, workDir, prompt, promptEvent, emit, resolveExit, onResult }: LaunchOpts): T {
  if (running.has(rec.id)) throw new Error('Task is already running');

  record(rec, promptEvent);

  const child: RunningChild = spawn(CLAUDE_BIN, args, {
    cwd: workDir,
    env: childEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.set(rec.id, child);

  child.stdin?.on('error', () => {}); // claude may exit before reading stdin
  child.stdin?.write(prompt);
  child.stdin?.end();

  let sawResult: any = null;
  let stderrTail = '';
  const openSubagents = new Set<string>();

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      record(rec, { type: 'raw', text: line });
      return;
    }

    // Keep hot record fields in sync with the session stream.
    if (event.type === 'system' && event.subtype === 'init') {
      rec.sessionId = event.session_id || rec.sessionId;
      rec.resolvedModel = event.model || rec.resolvedModel;
      emit(rec);
    } else if (event.type === 'assistant') {
      const blocks = (event.message && event.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name === 'Task' && !event.parent_tool_use_id) {
          openSubagents.add(b.id);
          rec.activeSubagents = openSubagents.size;
          emit(rec);
        }
      }
    } else if (event.type === 'user') {
      const blocks = (event.message && event.message.content) || [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_result' && openSubagents.delete(b.tool_use_id)) {
            rec.activeSubagents = openSubagents.size;
            emit(rec);
          }
        }
      }
    } else if (event.type === 'result') {
      sawResult = event;
      rec.costUsd = (rec.costUsd || 0) + (event.total_cost_usd || 0);
      rec.numTurns = event.num_turns;
      rec.durationMs = event.duration_ms;
      if (onResult) onResult(event);
      emit(rec);
    }

    record(rec, event);
  });

  const rlErr = readline.createInterface({ input: child.stderr! });
  rlErr.on('line', (line) => {
    stderrTail = (stderrTail + '\n' + line).slice(-4000);
    record(rec, { type: 'stderr', text: line });
  });

  child.on('error', (err) => {
    running.delete(rec.id);
    rec.status = 'failed';
    rec.lastOutcome = 'error';
    rec.lastError = `Failed to launch claude: ${err.message}`;
    rec.finishedAt = now();
    rec.activeSubagents = 0;
    record(rec, { type: 'proc', text: rec.lastError });
    emit(rec);
  });

  child.on('exit', (code, signal) => {
    running.delete(rec.id);
    // Deny any prompts still waiting — the child that asked is gone.
    permissions.rejectForTask(rec.id, 'Run ended');
    rec.finishedAt = now();
    rec.activeSubagents = 0;
    resolveExit({ code, signal, stopped: !!child.wasStopped, sawResult, stderrTail });
    emit(rec);
  });

  return rec;
}

/**
 * Dispatch a task: spawn `claude -p` in the task's working directory and
 * stream its NDJSON output into the task log + SSE bus.
 * `prompt` is the text sent on stdin; `resume` continues an existing session.
 */
function dispatch(task: Task, prompt: string, { resume = false }: { resume?: boolean } = {}): Task {
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
    emit: emitTask,
    onResult: (event) => usage.applyResult(task, event),
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
 * Run a grooming card: a short, read-only `claude -p` session in the repo that
 * thinks the rough idea through and proposes one or more task specs. The card
 * never becomes a task itself — on success `onSpawn` creates the tasks and the
 * card lands in `finished` with links to them. The `running` status (like a
 * task's) is entered only here, never via the API.
 */
function groom(grooming: Grooming, { onSpawn }: { onSpawn: (specs: GroomSpec[]) => string[] }): Grooming {
  if (running.has(grooming.id)) throw new Error('Grooming is already running');

  grooming.status = 'running';
  grooming.startedAt = now();
  grooming.finishedAt = null;
  grooming.lastOutcome = null;
  grooming.lastError = null;
  grooming.runCount = (grooming.runCount || 0) + 1;
  grooming.activeSubagents = 0;
  emitGrooming(grooming);

  const prompt = groomer.metaPrompt(grooming.idea);

  return launch(grooming, {
    args: groomArgs(grooming),
    workDir: grooming.repoPath, // grooming is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, groom: true, run: grooming.runCount },
    emit: emitGrooming,
    onResult: (event) => usage.applyGroomResult(grooming, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      // The grooming session is an internal, read-only planning session and is
      // never resumed. Drop its session id so nothing on the card points at it.
      grooming.sessionId = null;

      if (signal || stopped) {
        // Park a stopped grooming back in draft with the rough idea intact.
        grooming.status = 'draft';
        grooming.lastOutcome = 'stopped';
        grooming.lastError = 'Grooming stopped by user';
        record(grooming, { type: 'proc', text: 'Grooming stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.is_error;
      const resultText = succeeded && typeof sawResult.result === 'string' ? sawResult.result : '';
      let specs = succeeded ? groomer.parseResult(resultText) : null;
      if (!specs && succeeded && resultText.trim()) {
        // Session finished but we couldn't parse a structured spec — keep the
        // full text as one task prompt so nothing is lost (never auto-ready).
        specs = [{ title: grooming.title, prompt: resultText.trim(), ready: false }];
        record(grooming, { type: 'proc', text: 'Kept unstructured output as a single task prompt' });
      }
      if (specs) {
        grooming.taskIds = onSpawn(specs);
        grooming.status = 'finished';
        grooming.lastOutcome = 'groomed';
        record(grooming, {
          type: 'proc',
          text: `Groomed the idea into ${grooming.taskIds.length} task${grooming.taskIds.length === 1 ? '' : 's'}`,
        });
      } else {
        grooming.status = 'failed';
        grooming.lastOutcome = 'error';
        grooming.lastError =
          (sawResult && (sawResult.result || sawResult.subtype)) ||
          stderrTail.trim().split('\n').pop() ||
          `claude exited with code ${code}`;
        record(grooming, { type: 'proc', text: `Grooming failed (exit ${code}): ${grooming.lastError}` });
      }
    },
  });
}

function stop(taskId: string): boolean {
  const child = running.get(taskId);
  if (!child) return false;
  child.wasStopped = true;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (running.has(taskId)) child.kill('SIGKILL');
  }, 5000);
  return true;
}

function stopAll(): void {
  for (const [taskId] of running) stop(taskId);
}

export {
  dispatch,
  groom,
  stop,
  stopAll,
  isRunning,
  runningCount,
  buildArgs,
  normalizeAllowedTools,
  mergeAllowedTools,
  effectiveAllowedTools,
  setBaseUrl,
  childEnv,
  PERMISSION_TOOL,
  DEFAULT_ALLOWED_TOOLS,
  CLAUDE_BIN,
};
