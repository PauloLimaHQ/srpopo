import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import readline from 'readline';

import { db, save, now, appendLog } from './store';
import { broadcast } from './bus';
import * as groomer from './groomer';
import * as orchestrator from './orchestrator';
import * as reviewer from './reviewer';
import * as github from './github';
import { askPrompt } from './ask';
import * as memory from './memory';
import * as permissions from './permissions';
import * as usage from './usage';
import * as claude from './agents/claude';
import * as codex from './agents/codex';
import * as grok from './agents/grok';
import { ClaudeAdapter } from './agents/claude';
import { CodexAdapter } from './agents/codex';
import { GrokAdapter } from './agents/grok';
import type { AgentAdapter, NormalizedResult } from './agents/types';
import type { GroomSpec } from './groomer';
import type { AskSession, Grooming, LogEvent, Orchestration, PrInfo, Task, TaskAgent } from './types';

// The registered agent backends, keyed by Task.agent. Claude is the default and
// the historical behavior; codex drives the OpenAI Codex CLI and grok the xAI
// Grok CLI. Grooming always runs against Claude (a Grooming has no agent field)
// — see groom().
const ADAPTERS: Record<TaskAgent, AgentAdapter> = {
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  grok: GrokAdapter,
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

function emitOrchestration(orchestration: Orchestration): void {
  orchestration.updatedAt = now();
  save();
  broadcast({ type: 'orchestration', orchestration });
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
  // Whether the session id from this run's init event is recorded on the record.
  // Defaults to true. A Code Review run (see codeReview) streams into the task's
  // own card but is a *different, throwaway* session, so it opts out — otherwise
  // it would clobber task.sessionId and break follow-ups and Autonomous Mode's
  // review pass, which both resume the implementing session.
  trackSession?: boolean;
}

/**
 * Spawn an agent CLI for a task or grooming card and stream its NDJSON output
 * into the session log + SSE bus. Shared by dispatch (running tasks) and groom
 * (grooming cards): the caller picks the adapter, sets the record's starting
 * fields, and provides `resolveExit`, which decides the final status once the
 * process exits. The runner reacts only to the adapter's NormalizedEvents, so it
 * stays provider-agnostic; the process error/cleanup path is handled here.
 */
function launch<T extends SessionRecord>(rec: T, { adapter, args, workDir, prompt, promptEvent, emit, resolveExit, onResult, trackSession = true }: LaunchOpts): T {
  if (running.has(rec.id)) throw new Error('Task is already running');

  record(rec, promptEvent);

  // Most backends read the prompt from stdin. One whose headless mode ignores it
  // (Grok) hands back extra args carrying the prompt instead, plus a cleanup for
  // whatever they point at — see AgentAdapter.promptArgs.
  const delivery = adapter.promptArgs ? adapter.promptArgs(prompt) : null;
  let cleanedUp = false;
  const cleanupPrompt = (): void => {
    if (cleanedUp || !delivery || !delivery.cleanup) return;
    cleanedUp = true;
    try {
      delivery.cleanup();
    } catch (e) {
      // Losing a temp file is not worth failing a finished run over.
      console.warn('[runner] prompt cleanup failed:', (e as Error).message);
    }
  };

  let child: RunningChild;
  try {
    child = spawn(adapter.bin, delivery ? [...args, ...delivery.args] : args, {
      cwd: workDir,
      env: adapter.childEnv(rec.model),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A synchronous spawn failure (bad workDir, bad options) never reaches the
    // 'error'/'exit' handlers below, so clean up here before rethrowing —
    // otherwise a prompt file would be left behind in the temp dir.
    cleanupPrompt();
    throw e;
  }
  running.set(rec.id, child);

  child.stdin?.on('error', () => {}); // the child may exit before reading stdin
  // Only write the prompt when stdin IS the delivery channel; either way close it
  // so a child that does read stdin sees EOF instead of waiting on us.
  if (!delivery) child.stdin?.write(prompt);
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
      if (trackSession) rec.sessionId = norm.session.sessionId || rec.sessionId;
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
    // The child never started, so nothing will read the prompt file. ('exit' may
    // or may not follow an 'error'; cleanupPrompt is idempotent either way.)
    cleanupPrompt();
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
    cleanupPrompt();
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
 * `validation` (see dispatch's resolveExit). A short, read-only Claude session
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
 * The Code Review stage: a FRESH, read-only reviewer session over the task's
 * branch (see server/reviewer.ts). It streams into the *same task card* as
 * another run of that task — same NDJSON log, same cost ledger, one more
 * `runCount` — but it is a different session with a different job, so:
 *   - `trackSession: false` keeps task.sessionId pointing at the implementing
 *     session (follow-ups and Autonomous Mode's review pass resume that one),
 *   - the args carry no `--resume`, no write tool and no permission bridge
 *     (see reviewArgs in server/agents/claude.ts), and
 *   - it always runs on Claude, like grooming and the queen do.
 *
 * However it ends, the card lands in `validation`: the implementation work
 * already succeeded and a human still has to validate it, so a failed, stopped
 * or unparsable review must never mark the task `failed`. On a parsed verdict the
 * grade is recorded on the task and stamped onto the PR as its `mergeable/<n>`
 * label (fire-and-forget — the label is a convenience, not the record).
 */
function codeReview(task: Task, pr: PrInfo): Task {
  if (running.has(task.id)) throw new Error('Task is already running');

  const adapter = ClaudeAdapter;
  // Restored in resolveExit: launch() must not leave the review's session id on
  // the task even though we let it stream through the same record.
  const implementationSessionId = task.sessionId;
  task.status = 'code_review';
  task.startedAt = now();
  task.finishedAt = null;
  task.lastOutcome = null;
  task.lastError = null;
  task.runCount = (task.runCount || 0) + 1;
  task.activeSubagents = 0;
  emitTask(task);

  const prompt = reviewer.metaPrompt(task, pr);

  return launch(task, {
    adapter,
    args: claude.reviewArgs(task),
    workDir: task.worktreePath || task.repoPath,
    prompt,
    promptEvent: { type: 'prompt', text: prompt, codeReview: true, run: task.runCount },
    emit: emitTask,
    trackSession: false,
    onResult: (event) => usage.applyResult(task, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      task.sessionId = implementationSessionId;
      // Whatever happened, the human validates from here — never `failed`.
      task.status = 'validation';
      if (signal || stopped) {
        task.lastOutcome = 'review-stopped';
        task.lastError = 'Code review stopped by user';
        record(task, { type: 'proc', text: 'Code review stopped by user — left in Validation' });
        return;
      }
      const succeeded = sawResult && !sawResult.isError;
      const verdict = succeeded ? reviewer.parseVerdict(sawResult.text) : null;
      if (verdict) {
        reviewer.applyVerdict(task, verdict);
        task.lastOutcome = 'reviewed';
        record(task, {
          type: 'proc',
          text: `Code review finished — mergeable ${verdict.grade}/5 (${reviewer.gradeMeaning(verdict.grade)})`,
        });
        // Best-effort: the grade lives on the task regardless of whether GitHub
        // accepted the label.
        github.setMergeableLabel(task, verdict.grade)
          .then((res) => {
            if (!res.ok) record(task, { type: 'proc', text: `Could not label the PR (${res.reason})` });
          })
          .catch((e) => console.warn('[reviewer] failed to label the PR:', (e as Error).message));
      } else if (succeeded) {
        task.lastOutcome = 'reviewed';
        record(task, { type: 'proc', text: 'Code review finished but produced no readable grade — left ungraded' });
      } else {
        task.lastOutcome = 'review-error';
        task.lastError =
          (sawResult && sawResult.errorReason) ||
          stderrTail.trim().split('\n').pop() ||
          `${adapter.label} exited with code ${code}`;
        record(task, { type: 'proc', text: `Code review failed (exit ${code}): ${task.lastError}` });
      }
    },
  });
}

/**
 * Best-effort auto-entry into the Code Review stage, kicked off right after a run
 * lands successfully (see dispatch's resolveExit, next to maybeDistill which it
 * is modeled on).
 *
 * This is OPT-IN per task (`task.autoCodeReview`, off by default): the stage costs
 * one extra short read-only session, so a task only flows into `code_review` when
 * it was configured to. Everything else — the flag off, no branch, no PR, a closed
 * PR, the parallel-session cap already reached, a `gh` lookup that failed — simply
 * leaves the task in `validation`, which is where it was already parked. Nothing
 * here is ever retried, and the manual `POST /api/tasks/:id/code-review` route
 * bypasses all of it (an explicit request always reviews).
 */
function maybeCodeReview(task: Task): void {
  if (!task.autoCodeReview) return; // not configured to be graded — validation it is
  if (!task.branch) return; // nothing to review against, and no PR to comment on
  if (running.has(task.id)) return;
  if (runningCount() >= db.settings.maxParallelSessions) {
    record(task, { type: 'proc', text: 'Skipped code review: max parallel sessions reached — left in Validation' });
    return;
  }
  github.prForTask(task)
    .then((found) => {
      if (!found.pr || found.pr.state !== 'open') {
        record(task, {
          type: 'proc',
          text: `Skipped code review: no open pull request for ${task.branch} (${found.pr ? found.pr.state : found.reason || 'no-pr'})`,
        });
        return;
      }
      // Re-check the gates: the lookup is async, so the world may have moved on.
      if (running.has(task.id) || task.status !== 'validation') return;
      if (runningCount() >= db.settings.maxParallelSessions) {
        record(task, { type: 'proc', text: 'Skipped code review: max parallel sessions reached — left in Validation' });
        return;
      }
      codeReview(task, found.pr);
    })
    .catch((e) => console.warn('[reviewer] failed to start the code review:', (e as Error).message));
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
  // Any implementation run invalidates the grade — a fresh one or a resume
  // (follow-up, review pass, conflict fix) can all change the branch, and the
  // verdict describes a diff that no longer exists. It comes back on the next
  // code review. (A code-review run doesn't go through dispatch, so its own
  // verdict is never cleared by this.)
  task.codeReview = null;
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
        // The work landed: park it in `validation` for the human, then — only when
        // the task opted into grading and has an open PR — flow on into the Code
        // Review stage, which emits the `code_review` flip itself once its (async)
        // PR lookup comes back.
        task.status = 'validation';
        task.lastOutcome = 'success';
        record(task, { type: 'proc', text: `Run finished (exit ${code})` });
        maybeDistill(task);
        maybeCodeReview(task);
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
        specs = [{ title: grooming.title, prompt: resultText.trim(), ready: false, complexity: 'standard' }];
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

/**
 * Run one turn of a goal orchestration's orchestrator session: a read-only Claude
 * session that plans the goal and drives the board through Sr. Popo's own MCP
 * server (see orchestrateArgs in server/agents/claude.ts — research tools plus
 * the board tools, never a write tool and never a worktree).
 *
 * Every turn must end with one status object between the ORCH sentinels (see
 * server/orchestrator.ts), which decides where the card lands:
 *   waiting  → `waiting`, with the watched task ids kept on the card so the
 *              orchestrator engine (server/orchestrator-engine.ts) can resume this
 *              same session when they land
 *   question → `awaiting`, paused on a question for the developer
 *   done     → `finished`
 *   blocked  → `failed`
 * `waiting` and `awaiting` keep the sessionId (they are resumable, and survive a
 * server restart); the terminal states drop it. Pass `resumePrompt` to continue
 * the session — the engine's status update, or the developer's answer.
 */
function orchestrate(
  orchestration: Orchestration,
  { resumePrompt }: { resumePrompt?: string } = {},
): Orchestration {
  if (running.has(orchestration.id)) throw new Error('Orchestration is already running');

  const adapter = ClaudeAdapter;
  const resume = typeof resumePrompt === 'string';
  orchestration.status = 'running';
  orchestration.startedAt = orchestration.startedAt && resume ? orchestration.startedAt : now();
  orchestration.finishedAt = null;
  orchestration.lastOutcome = null;
  orchestration.lastError = null;
  // A fresh (non-resume) run starts the goal over — drop the previous session and
  // whatever it was watching.
  if (!resume) {
    orchestration.sessionId = null;
    orchestration.watch = [];
    orchestration.note = null;
    // The turn cap (orchestratorEngine.MAX_TURNS) counts turns of ONE orchestrator
    // session, so a fresh run of the goal starts the count over.
    orchestration.turnCount = 0;
  }
  orchestration.runCount = (orchestration.runCount || 0) + 1;
  orchestration.turnCount = (orchestration.turnCount || 0) + 1;
  orchestration.activeSubagents = 0;
  emitOrchestration(orchestration);

  const prompt = resume
    ? resumePrompt!
    : orchestrator.metaPrompt(orchestration, memory.readMemory(orchestration.repoId));

  return launch(orchestration, {
    adapter,
    args: claude.orchestrateArgs(orchestration, resume),
    workDir: orchestration.repoPath, // planning is read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, orchestrate: true, resume, run: orchestration.runCount },
    emit: emitOrchestration,
    onResult: (event) => usage.applyOrchestrationResult(orchestration, event),
    resolveExit: ({ code, signal, stopped, sawResult, stderrTail }) => {
      if (signal || stopped) {
        // Park a stopped orchestration back in draft with the goal intact. The
        // session goes with it — a fresh run re-plans from scratch (mirrors how
        // a stopped grooming card is parked).
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'draft';
        orchestration.lastOutcome = 'stopped';
        orchestration.lastError = 'Orchestration stopped by user';
        record(orchestration, { type: 'proc', text: 'Orchestration stopped by user' });
        return;
      }
      const succeeded = sawResult && !sawResult.isError;
      const status = succeeded ? orchestrator.parseStatus(sawResult.text) : null;
      if (!status) {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'failed';
        orchestration.lastOutcome = 'error';
        orchestration.lastError = succeeded
          ? 'The orchestrator ended its turn without a valid status update'
          : (sawResult && sawResult.errorReason) ||
            stderrTail.trim().split('\n').pop() ||
            `${adapter.label} exited with code ${code}`;
        record(orchestration, { type: 'proc', text: `Orchestration failed (exit ${code}): ${orchestration.lastError}` });
        return;
      }

      orchestration.note = status.note || null;
      if (status.state === 'waiting') {
        // Still going: keep the session (the engine resumes it) and remember the
        // workers this turn asked for, both as the live watch set and on the
        // running roster of every task this orchestration has touched.
        orchestration.watch = status.watch;
        orchestration.taskIds = [...new Set([...(orchestration.taskIds || []), ...status.watch])];
        orchestration.status = 'waiting';
        orchestration.lastOutcome = 'waiting';
        orchestration.finishedAt = null; // paused between turns, not finished
        record(orchestration, {
          type: 'proc',
          text: `Waiting on ${status.watch.length} task${status.watch.length === 1 ? '' : 's'}${status.note ? `: ${status.note}` : ''}`,
        });
      } else if (status.state === 'question') {
        orchestration.watch = [];
        orchestration.status = 'awaiting';
        orchestration.lastOutcome = 'awaiting';
        orchestration.finishedAt = null;
        record(orchestration, { type: 'proc', text: `Orchestration needs input: ${status.note}` });
      } else if (status.state === 'done') {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'finished';
        orchestration.lastOutcome = 'orchestrated';
        record(orchestration, { type: 'proc', text: `Goal complete: ${status.note}` });
      } else {
        orchestration.sessionId = null;
        orchestration.watch = [];
        orchestration.status = 'failed';
        orchestration.lastOutcome = 'blocked';
        orchestration.lastError = status.note || 'The orchestrator reported it is blocked';
        record(orchestration, { type: 'proc', text: `Orchestration blocked: ${orchestration.lastError}` });
      }
    },
  });
}

/**
 * Run a short, read-only "Ask Sr. Popo" Q&A session in a repo. Unlike
 * dispatch/groom, the session is ephemeral: `session` is a plain in-memory
 * record (never a Task/Grooming, never persisted), so it drives the same
 * launch() plumbing but its `emit` only broadcasts — nothing is ever
 * store.save()'d. It still runs through the shared `running` map, so it
 * counts against maxParallelSessions and is stoppable via runner.stop like
 * any other session. Always Claude, read-only (same allow-list as grooming),
 * and never a worktree — see server/ask.ts for the prompt itself.
 */
function ask(session: AskSession, question: string, projectMemory: string | null): AskSession {
  if (running.has(session.id)) throw new Error('Ask session is already running');

  const adapter = ClaudeAdapter;
  session.status = 'running';

  const prompt = askPrompt(question, projectMemory);

  return launch(session, {
    adapter,
    args: adapter.groomArgs(session, false),
    workDir: session.repoPath, // read-only exploration; never a worktree
    prompt,
    promptEvent: { type: 'prompt', text: prompt, ask: true },
    emit: (rec: AskSession) => {
      rec.updatedAt = now();
      broadcast({ type: 'ask-update', askId: rec.id, repoId: rec.repoId, sessionId: rec.sessionId, activeSubagents: rec.activeSubagents, costUsd: rec.costUsd });
    },
    onResult: (event) => usage.applyAskResult({
      id: session.id,
      title: session.question,
      repoId: session.repoId,
      repoName: session.repoName,
      model: session.model,
      resolvedModel: session.resolvedModel,
    }, event),
    resolveExit: ({ signal, stopped, sawResult, stderrTail }) => {
      const ok = !!(sawResult && !sawResult.isError) && !signal && !stopped;
      let answer: string;
      if (stopped || signal) {
        answer = 'Stopped by user';
      } else if (ok) {
        answer = (sawResult && sawResult.text) || '';
      } else {
        answer = (sawResult && sawResult.errorReason) || stderrTail.trim().split('\n').pop() || `${adapter.label} failed`;
      }
      session.status = ok ? 'done' : 'failed';
      broadcast({ type: 'ask', askId: session.id, repoId: session.repoId, ok, answer, costUsd: session.costUsd });
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
  codeReview,
  maybeCodeReview,
  groom,
  orchestrate,
  ask,
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

// The non-Claude binaries, for the health probe (GET /api/health checks every backend).
export const { CODEX_BIN } = codex;
export const { GROK_BIN } = grok;
