import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import readline from 'readline';

import { db, save, now, appendLog } from './store';
import { broadcast } from './bus';
import * as groomer from './groomer';
import * as memory from './memory';
import * as permissions from './permissions';
import * as usage from './usage';
import * as claude from './agents/claude';
import * as codex from './agents/codex';
import { ClaudeAdapter } from './agents/claude';
import { CodexAdapter } from './agents/codex';
import type { AgentAdapter, NormalizedResult } from './agents/types';
import type { GroomSpec } from './groomer';
import type { Grooming, LogEvent, Task, TaskAgent } from './types';

// The registered agent backends, keyed by Task.agent. Claude is the default and
// the historical behavior; codex drives the OpenAI Codex CLI. Grooming always
// runs against Claude (a Grooming has no agent field) — see groom().
const ADAPTERS: Record<TaskAgent, AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
};

function adapterFor(agent: TaskAgent | undefined): AgentAdapter {
  return ADAPTERS[agent as TaskAgent] || ClaudeAdapter;
}

// A live child, tagged so the exit handler can tell a user-requested stop
// (SIGTERM we sent) from a natural exit.
type RunningChild = ChildProcess & { wasStopped?: boolean };

// taskId / groomingId -> child process (tasks and groomings share the pool, so
// runningCount measures every live agent child against the parallel cap).
const running = new Map<string, RunningChild>();

// The session-tracking fields Task and Grooming share — everything launch()
// needs to stream an agent child into the log + SSE bus. `status` is the
// wider string here because the two lifecycles use different unions; each
// caller's resolveExit assigns only its own statuses.
interface SessionRecord {
  id: string;
  status: string;
  // The selected model — a built-in alias, 'default', or a custom model id. Both
  // Task and Grooming carry it; launch() uses it to layer any custom-model env.
  model: string;
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

// Count of live agent child processes across both dispatched runs and grooming
// sessions (they share the `running` map) — what the max-parallel-sessions cap
// in index.ts measures against.
function runningCount(): number {
  return running.size;
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

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stopped: boolean;
  // The terminal result of the run, normalized across backends (null if the run
  // exited without ever emitting one — e.g. a crash or a launch failure).
  sawResult: NormalizedResult | null;
  stderrTail: string;
}

interface LaunchOpts {
  adapter: AgentAdapter;
  args: string[];
  workDir: string;
  prompt: string;
  promptEvent: LogEvent;
  // How to persist + broadcast the record after a field change (emitTask for
  // tasks, emitGrooming for grooming cards). Typed loosely so both fit; launch
  // narrows it to its own record type.
  emit: (rec: any) => void;
  resolveExit: (info: ExitInfo) => void;
  // Called after the shared cost/turns/duration bookkeeping on every result
  // event, so each lifecycle can extend the usage ledger with its own record
  // shape (dispatch -> usage.applyResult, groom -> usage.applyGroomResult)
  // without launch() itself needing to know which one it's driving. The event is
  // the adapter's normalized usage payload (see NormalizedResult.usageEvent).
  onResult?: (event: Record<string, unknown>) => void;
}

/**
 * Spawn an agent CLI for a task or grooming card and stream its NDJSON output
 * into the session log + SSE bus. Shared by dispatch (running tasks) and groom
 * (grooming cards): the caller picks the adapter, sets the record's starting
 * fields, and provides `resolveExit`, which decides the final status once the
 * process exits. The runner reacts only to the adapter's NormalizedEvents, so it
 * stays provider-agnostic; the process error/cleanup path is handled here.
 */
function launch<T extends SessionRecord>(rec: T, { adapter, args, workDir, prompt, promptEvent, emit, resolveExit, onResult }: LaunchOpts): T {
  if (running.has(rec.id)) throw new Error('Task is already running');

  record(rec, promptEvent);

  const child: RunningChild = spawn(adapter.bin, args, {
    cwd: workDir,
    env: adapter.childEnv(rec.model),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.set(rec.id, child);

  child.stdin?.on('error', () => {}); // the child may exit before reading stdin
  child.stdin?.write(prompt);
  child.stdin?.end();

  let sawResult: NormalizedResult | null = null;
  let stderrTail = '';
  const openSubagents = new Set<string>();

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const norm = adapter.parseLine(line);
    if (!norm) return;

    // Keep hot record fields in sync with the session stream.
    if (norm.session) {
      rec.sessionId = norm.session.sessionId || rec.sessionId;
      rec.resolvedModel = norm.session.model || rec.resolvedModel;
      emit(rec);
    }
    if (norm.subagentsOpened) {
      for (const id of norm.subagentsOpened) {
        openSubagents.add(id);
        rec.activeSubagents = openSubagents.size;
        emit(rec);
      }
    }
    if (norm.subagentsClosed) {
      for (const id of norm.subagentsClosed) {
        if (openSubagents.delete(id)) {
          rec.activeSubagents = openSubagents.size;
          emit(rec);
        }
      }
    }
    if (norm.result) {
      sawResult = norm.result;
      rec.costUsd = (rec.costUsd || 0) + (norm.result.costUsd || 0);
      rec.numTurns = norm.result.numTurns;
      rec.durationMs = norm.result.durationMs;
      if (onResult) onResult(norm.result.usageEvent);
      emit(rec);
    }

    record(rec, norm.log);
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
    rec.lastError = `Failed to launch ${adapter.label}: ${err.message}`;
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
 * Best-effort background memory distillation, kicked off after a task lands in
 * `review` (see dispatch's resolveExit). A short, read-only Claude session
 * (see server/memory.ts) reviews what the task changed and folds any durable,
 * project-level learning into the repo's memory document. Everything here is
 * fire-and-forget: any guard below failing just means memory catches up on the
 * next task, never a queued retry.
 */
function maybeDistill(task: Task): void {
  if (!db.settings.memory) return;
  // `running` is already keyed by session id, and the distiller's id is scoped
  // to the repo (memory-<repoId>), so checking it here doubles as the "no
  // distill session already in flight for this repo" guard — with no separate
  // bookkeeping to leak if a spawn fails before ever reaching launch()'s own
  // exit handler.
  if (running.has(`memory-${task.repoId}`)) return;
  if (runningCount() >= db.settings.maxParallelSessions) return;
  try {
    distillMemory(task);
  } catch (e) {
    console.warn('[memory] failed to start distill session:', (e as Error).message);
  }
}

// Ephemeral: unlike dispatch/groom this session is never persisted to
// db.json — `emit` only broadcasts, it never save()s a task or grooming — and
// it always runs read-only in the task's own working directory so git diff/show
// can see what the task actually changed.
function distillMemory(task: Task): void {
  const rec: SessionRecord = {
    id: `memory-${task.repoId}`,
    status: 'running',
    model: memory.MEMORY_MODEL,
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    updatedAt: now(),
    finishedAt: null,
  };
  const prompt = memory.distillPrompt(memory.readMemory(task.repoId), task);

  launch(rec, {
    adapter: ClaudeAdapter,
    args: ClaudeAdapter.groomArgs({ model: memory.MEMORY_MODEL, sessionId: null }),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, memory: true },
    emit: () => {},
    onResult: (event) => usage.applyMemoryResult({
      id: rec.id,
      title: `Memory: ${task.title}`,
      repoId: task.repoId,
      repoName: task.repoName,
      model: rec.model,
      resolvedModel: rec.resolvedModel,
    }, event),
    resolveExit: ({ sawResult }) => {
      const updated = sawResult && !sawResult.isError ? memory.parseDistillResult(sawResult.text) : null;
      if (updated !== null) {
        memory.writeMemory(task.repoId, updated);
        broadcast({ type: 'memory', repoId: task.repoId, updatedAt: now() });
      }
    },
  });
}

/**
 * Dispatch a task: spawn its agent CLI in the task's working directory and
 * stream the NDJSON output into the task log + SSE bus. `prompt` is the text sent
 * on stdin; `resume` continues an existing session.
 */
function dispatch(task: Task, prompt: string, { resume = false }: { resume?: boolean } = {}): Task {
  if (running.has(task.id)) throw new Error('Task is already running');

  const adapter = adapterFor(task.agent);
  task.status = 'running';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  return launch(task, {
    adapter,
    args: adapter.buildArgs(task, resume),
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
      } else if (sawResult && !sawResult.isError) {
        task.status = 'review';
        task.lastOutcome = 'success';
        record(task, { type: 'proc', text: `Run finished (exit ${code})` });
        maybeDistill(task);
      } else {
        task.status = 'failed';
        task.lastOutcome = 'error';
        task.lastError =
          (sawResult && sawResult.errorReason) ||
          stderrTail.trim().split('\n').pop() ||
          `${adapter.label} exited with code ${code}`;
        record(task, { type: 'proc', text: `Run failed (exit ${code}): ${task.lastError}` });
      }
    },
  });
}

/**
 * Run a grooming card: a short, read-only agent session in the repo that thinks
 * the rough idea through and proposes one or more task specs. The card never
 * becomes a task itself — on success `onSpawn` creates the tasks and the card
 * lands in `finished` with links to them. The `running` status (like a task's)
 * is entered only here, never via the API. Grooming always runs against Claude.
 *
 * The session may instead ask the developer to clarify something (see groomer):
 * when it does, the card lands in `awaiting` with the questions kept on it and
 * its session id retained, so answering resumes the same session. Pass
 * `resumePrompt` to feed those answers back in and continue where it paused.
 */
function groom(
  grooming: Grooming,
  { onSpawn, resumePrompt }: { onSpawn: (specs: GroomSpec[]) => string[]; resumePrompt?: string },
): Grooming {
  if (running.has(grooming.id)) throw new Error('Grooming is already running');

  const adapter = ClaudeAdapter;
  const resume = typeof resumePrompt === 'string';
  grooming.status = 'running';
  grooming.startedAt = now();
  grooming.finishedAt = null;
  grooming.lastOutcome = null;
  grooming.lastError = null;
  // A fresh (non-resume) run starts the idea over — drop any stale questions/
  // session from a previous awaiting/failed pass.
  if (!resume) {
    grooming.questions = [];
    grooming.sessionId = null;
  }
  grooming.runCount = (grooming.runCount || 0) + 1;
  grooming.activeSubagents = 0;
  emitGrooming(grooming);

  const prompt = resume ? resumePrompt! : groomer.metaPrompt(grooming.idea, memory.readMemory(grooming.repoId));

  return launch(grooming, {
    adapter,
    args: adapter.groomArgs(grooming, resume),
    workDir: grooming.repoPath, // grooming is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, groom: true, resume, run: grooming.runCount },
    emit: emitGrooming,
    onResult: (event) => usage.applyGroomResult(grooming, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      if (signal || stopped) {
        // Park a stopped grooming back in draft with the rough idea intact. Drop
        // the session — a fresh run starts over.
        grooming.sessionId = null;
        grooming.questions = [];
        grooming.status = 'draft';
        grooming.lastOutcome = 'stopped';
        grooming.lastError = 'Grooming stopped by user';
        record(grooming, { type: 'proc', text: 'Grooming stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.isError;
      const resultText = succeeded ? sawResult.text : '';

      // First check whether the session paused to ask the developer to clarify.
      const questions = succeeded ? groomer.parseQuestions(resultText) : null;
      if (questions) {
        // Keep the session id (set from the init event) so answering resumes it.
        grooming.questions = questions;
        grooming.status = 'awaiting';
        grooming.lastOutcome = 'awaiting';
        grooming.lastError = null;
        grooming.finishedAt = null; // paused, not finished (launch set it on exit)
        record(grooming, {
          type: 'proc',
          text: `Grooming needs input — asked ${questions.length} question${questions.length === 1 ? '' : 's'}`,
        });
        return;
      }

      // Otherwise the turn is terminal — it either produced a spec or failed.
      // Drop the session id so nothing on a finished/failed card points at it.
      grooming.sessionId = null;
      grooming.questions = [];

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
          (sawResult && sawResult.errorReason) ||
          stderrTail.trim().split('\n').pop() ||
          `${adapter.label} exited with code ${code}`;
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

// Set the server base URL for the Claude permission bridge (the only backend
// that POSTs approvals back). Called once the port is known (see index.start).
function setBaseUrl(url: string): void {
  claude.setBaseUrl(url);
}

export {
  dispatch,
  groom,
  stop,
  stopAll,
  isRunning,
  runningCount,
  adapterFor,
  setBaseUrl,
};

// Claude-specific helpers re-exported for the REST/MCP layers and the smoke
// suite, which expect them on `runner` (their behavior is unchanged; the
// implementation now lives in server/agents/claude.ts).
export const {
  buildArgs,
  buildTaskEnv,
  childEnv,
  normalizeAllowedTools,
  mergeAllowedTools,
  effectiveAllowedTools,
  PERMISSION_TOOL,
  DEFAULT_ALLOWED_TOOLS,
  CLAUDE_BIN,
} = claude;

// The Codex binary, for the health probe (GET /api/health checks every backend).
export const { CODEX_BIN } = codex;
