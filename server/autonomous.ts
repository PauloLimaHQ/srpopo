/*
 * Autonomous Mode — an opt-in engine that drives a repo's `ready` tasks through
 * their full lifecycle without a human babysitting each run.
 *
 * The user queues tasks in `ready`, turns the mode on for a workspace with a
 * dollar budget, and the engine takes over: it dispatches each task (a single
 * `claude -p` run that already plans → builds → tests → self-reviews → opens a
 * PR), then when that PR is green it merges it and moves the task to `done`.
 *
 * Design mirrors permissions.ts: a single, process-local, in-memory session with
 * NO persistence. If the server restarts the session is gone — the normal task
 * state it changed along the way is persisted through store.save() as usual, but
 * the orchestration itself is transient. Only one session runs at a time, scoped
 * to one repo (a second start is rejected by the API with a 409).
 *
 * Unattended tradeoff: the engine turns interactive permission prompting OFF for
 * the tasks it dispatches (a blocked prompt would hang forever with no human to
 * answer). It does NOT elevate to bypassPermissions — it relies only on each
 * task's own allow-list, the add-on allow-lists, and the package-manager
 * defaults. A task that can't finish unattended simply lands in review/failed for
 * the human; the engine never grants extra privileges.
 *
 * The heavy boundaries (spawning claude, calling `gh`, git worktrees) are behind
 * an injectable `deps` object so the loop's pure logic — selection, budget, and
 * concurrency — is unit-testable without spawning any real process.
 */
import { db, save, now, getTask, getRepo } from './store';
import { broadcast, subscribe } from './bus';
import * as runner from './runner';
import * as github from './github';
import * as git from './git';
import * as addons from './addons';
import * as framing from './framing';
import * as conflicts from './conflicts';
import type { AutonomousStatus, AutonomousTaskView, PrCheck, Task } from './types';

// Add-ons every autonomously dispatched task must carry so its single run tests,
// self-reviews, and opens a PR the engine can then merge (see the task spec).
const REQUIRED_ADDONS = ['pull_request', 'code_review'];

// The boundaries the loop touches. Defaults wire to the real modules; tests swap
// them for stubs so no `claude`/`gh`/git process is ever spawned.
interface Deps {
  // Prepare (worktree + framing) and spawn a fresh run. Sets status = 'running'.
  dispatch(task: Task): Promise<void>;
  // Merge-safety check for the task's PR.
  checkPr(task: Task): Promise<PrCheck>;
  // Merge the task's PR.
  merge(task: Task): Promise<{ ok: boolean; message?: string; reason?: string }>;
  // Drop a task's worktree once it's merged (best-effort, mirrors move-to-done).
  removeWorktree(repoPath: string, wtPath: string): Promise<void>;
  // Count of live `claude` children across the whole app (the concurrency cap
  // measures against this — the same notion index.ts's atCapacity uses).
  runningCount(): number;
}

// Default dispatch: force the unattended lifecycle config, materialize a worktree
// if needed, then spawn the run through the exact same framing the API route uses.
async function realDispatch(task: Task): Promise<void> {
  if (task.useWorktree && !task.worktreePath) {
    const { wtPath, branch } = await git.addWorktree(task.repoPath, task.id, framing.slugify(task.title), task.branchName);
    task.worktreePath = wtPath;
    task.branch = branch;
    save();
  }
  runner.dispatch(task, framing.framePrompt(task), { resume: false });
}

const defaultDeps: Deps = {
  dispatch: realDispatch,
  checkPr: (task) => github.prCheckForTask(task),
  merge: (task) => github.mergePrForTask(task),
  removeWorktree: (repoPath, wtPath) => git.removeWorktree(repoPath, wtPath),
  runningCount: () => runner.runningCount(),
};
let deps: Deps = defaultDeps;

interface Session {
  repoId: string;
  budgetUsd: number;
  startedAt: string;
  // Task ids the engine has dispatched this session (budget is summed over these).
  owned: Set<string>;
  // Subset still live (a dispatched run that hasn't reached review/done/failed).
  running: Set<string>;
  // A user stop was requested: stop pumping new work, let in-flight runs finish.
  stopping: boolean;
  unsubscribe: (() => void) | null;
}

let session: Session | null = null;
// Why the session last changed state, kept after it ends so status() can report it.
let lastReason: string | null = null;
// Simple re-entrancy guard so overlapping completions can't over-dispatch.
let pumping = false;
let pumpQueued = false;

// ---------- pure helpers ----------

// Cumulative cost of everything the session dispatched — its live "spentUsd".
// Read straight off the tasks' costUsd so it always reflects the real spend.
function spent(): number {
  if (!session) return 0;
  let total = 0;
  for (const id of session.owned) total += getTask(id)?.costUsd || 0;
  return total;
}

// The `ready`, non-archived tasks in the session's repo the engine hasn't taken
// yet — the pool it pumps from, in board order.
function eligible(): Task[] {
  if (!session) return [];
  return db.tasks.filter(
    (t) => !t.archived && t.repoId === session!.repoId && t.status === 'ready' && !session!.owned.has(t.id),
  );
}

// The global concurrency cap (dispatched runs + grooming) — never exceed it.
function atCapacity(): boolean {
  return deps.runningCount() >= (db.settings.maxParallelSessions || 1);
}

// True while there is more work the engine could and would start right now.
function canPumpMore(): boolean {
  return !!session && !session.stopping && spent() < session.budgetUsd && eligible().length > 0;
}

// ---------- status snapshot ----------

function taskViews(): AutonomousTaskView[] {
  if (!session) return [];
  const views: AutonomousTaskView[] = [];
  for (const id of session.owned) {
    const t = getTask(id);
    if (!t) continue;
    views.push({
      id: t.id,
      title: t.title,
      status: t.status,
      costUsd: t.costUsd || 0,
      running: session.running.has(id),
      resolvingConflicts: !!t.resolvingConflicts,
    });
  }
  return views;
}

// The safe, UI-facing snapshot. Inactive when no session is running.
function status(): AutonomousStatus {
  if (!session) {
    return { active: false, repoId: null, repoName: null, budgetUsd: null, spentUsd: 0, startedAt: null, stopping: false, reason: lastReason, tasks: [] };
  }
  return {
    active: true,
    repoId: session.repoId,
    repoName: getRepo(session.repoId)?.name || null,
    budgetUsd: session.budgetUsd,
    spentUsd: spent(),
    startedAt: session.startedAt,
    stopping: session.stopping,
    reason: lastReason,
    tasks: taskViews(),
  };
}

function isActive(): boolean {
  return session !== null;
}

// Broadcast the current snapshot so every board updates live. `reason` records
// what just happened (start, task-picked, merged, budget-reached, stopped, …).
function emit(reason: string): void {
  lastReason = reason;
  broadcast({ type: 'autonomous', status: status() });
}

// ---------- the loop ----------

// Prepare and dispatch one task: force the unattended lifecycle config, take
// ownership, then spawn it. Ownership is recorded before dispatch so budget and
// concurrency count it immediately; it's released again if the spawn throws.
async function dispatchOne(task: Task): Promise<void> {
  task.useWorktree = true;
  // Unattended: a blocked permission prompt would hang forever with no human.
  task.promptPermissions = false;
  // Ensure the lifecycle add-ons are present (sanitize keeps catalog order/dedupes).
  task.addons = addons.sanitize([...(task.addons || []), ...REQUIRED_ADDONS]);

  session!.owned.add(task.id);
  session!.running.add(task.id);
  try {
    await deps.dispatch(task);
    emit('task-picked');
  } catch (e) {
    // Couldn't even start it — drop ownership so budget/concurrency stay honest.
    session!.running.delete(task.id);
    session!.owned.delete(task.id);
    task.status = 'failed';
    task.lastOutcome = 'error';
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
  }
}

// Dispatch as many eligible tasks as budget + concurrency allow, then settle. The
// re-entrancy guard collapses overlapping calls (e.g. two completions at once)
// into one draining loop so we never dispatch past the cap.
async function pump(): Promise<void> {
  if (!session) return;
  if (pumping) { pumpQueued = true; return; }
  pumping = true;
  try {
    do {
      pumpQueued = false;
      while (canPumpMore() && !atCapacity()) {
        const next = eligible()[0];
        if (!next) break;
        await dispatchOne(next);
      }
    } while (pumpQueued);
  } finally {
    pumping = false;
  }
  maybeEnd();
}

// A dispatched run reached `review`: look up its PR and, only if it's green,
// merge it and move the task to `done` (dropping the worktree, mirroring the
// existing move-to-done flow). A conflicting PR is auto-resumed to fix itself
// when the user opted into that (Settings > autoResolveConflicts) — the task
// stays owned and back in `running`, and the next terminal event re-enters this
// same check. Anything else short of green is left in review for the human with
// a recorded reason. Pumps the next task(s) afterward.
async function handleReview(task: Task): Promise<void> {
  const check = await deps.checkPr(task);
  if (check.status === 'green') {
    const merged = await deps.merge(task);
    if (merged.ok) {
      task.status = 'done';
      task.lastOutcome = 'success';
      task.updatedAt = now();
      if (task.worktreePath) {
        try {
          await deps.removeWorktree(task.repoPath, task.worktreePath);
          task.worktreePath = null;
        } catch { /* leave the worktree; the human can clear it from the workspace */ }
      }
      save();
      broadcast({ type: 'task', task });
      emit('task-merged');
    } else {
      emit(`merge-failed:${merged.reason || 'error'}`);
    }
  } else if (check.status === 'conflicts' && db.settings.autoResolveConflicts && conflicts.resolveConflicts(task)) {
    // Still ours — track until this resume run lands, then handleReview runs again.
    session!.running.add(task.id);
    emit('resolving-conflicts');
  } else {
    // Not safe to merge — leave it in review for the human. It stays owned so the
    // engine won't redispatch it, and its cost still counts toward the budget.
    emit(`left-in-review:${check.status}`);
  }
  await pump();
}

// React to owned tasks reaching a terminal state on the SSE bus. Runs land as
// review (success), failed, or back to ready (a user stop) — we act once per task
// by keying on session.running, which we clear on the first terminal event.
function onBus(msg: unknown): void {
  if (!session) return;
  const m = msg as { type?: string; task?: Task };
  if (m.type !== 'task' || !m.task) return;
  const task = m.task;
  if (!session.running.has(task.id)) return; // not ours, or already handled

  if (task.status === 'running') return; // still in flight — many events fire mid-run
  session.running.delete(task.id);

  if (task.status === 'review') {
    void handleReview(task);
  } else if (task.status === 'failed') {
    // A failed run stays failed for the human; the engine just moves on.
    emit('task-failed');
    void pump();
  } else {
    // Any other exit (e.g. a user stopped this task, bouncing it to ready): drop
    // ownership so budget/concurrency stay honest and it can be re-queued by hand.
    session.owned.delete(task.id);
    emit('task-released');
    void pump();
  }
}

// End the session when nothing is in flight and there is nothing more to start:
// drained (no eligible tasks), budget-reached (cap hit with tasks left), or a
// user stop whose in-flight runs have now finished.
function maybeEnd(): void {
  if (!session || session.running.size > 0) return;
  if (session.stopping) return end('stopped');
  if (eligible().length === 0) return end('drained');
  if (spent() >= session.budgetUsd) return end('budget-reached');
}

// Tear the session down and announce it. In-flight runs (if any) are NOT killed —
// they finish on their own; only the orchestration stops.
function end(reason: string): void {
  const s = session;
  if (!s) return;
  if (s.unsubscribe) s.unsubscribe();
  session = null;
  emit(reason);
}

// ---------- public API ----------

/**
 * Start an autonomous session for a repo with a dollar budget. Assumes the caller
 * (the API route) already validated the plugin is installed, the repo exists, the
 * budget is a positive number, and no session is active. Kicks off the first pump
 * and resolves with the initial status snapshot.
 */
async function start({ repoId, budgetUsd }: { repoId: string; budgetUsd: number }): Promise<AutonomousStatus> {
  if (session) throw new Error('Autonomous mode is already running');
  session = {
    repoId,
    budgetUsd,
    startedAt: now(),
    owned: new Set(),
    running: new Set(),
    stopping: false,
    unsubscribe: null,
  };
  session.unsubscribe = subscribe(onBus);
  emit('started');
  await pump();
  return status();
}

/**
 * User-requested stop: cease starting new tasks but let any in-flight runs finish
 * (we do NOT force-kill them — they land in review, and a still-green one is still
 * merged before the session ends). If nothing is in flight, ends immediately.
 */
function stop(): AutonomousStatus {
  if (!session) return status();
  session.stopping = true;
  emit('stopping');
  if (session.running.size === 0) end('stopped');
  return status();
}

// Test seam: swap the heavy boundaries for stubs, or restore the real ones.
function _setDeps(overrides: Partial<Deps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

// Test seam: force the session back to idle between cases.
function _reset(): void {
  if (session?.unsubscribe) session.unsubscribe();
  session = null;
  lastReason = null;
  pumping = false;
  pumpQueued = false;
}

export { start, stop, status, isActive, _setDeps, _reset, REQUIRED_ADDONS };
