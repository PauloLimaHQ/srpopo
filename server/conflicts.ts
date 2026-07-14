/*
 * Auto-resolve conflicts — an opt-in behavior (Settings > autoResolveConflicts)
 * that watches tasks sitting in `review` and, when their PR has a merge conflict
 * with main, resumes the task's own session with an instruction to fix it.
 *
 * Mirrors autonomous.ts's shape at a much smaller scale: a periodic sweep drives
 * plain review-column tasks (no live board tab required, and independent of
 * Autonomous Mode), while a bus subscription clears the "Resolving Conflicts"
 * label once the resumed run lands back in review/failed/ready — the normal
 * runner lifecycle already does the state transition, this just tracks the label.
 * Autonomous Mode calls `resolveConflicts` directly from its own PR-check step
 * (see autonomous.ts's handleReview) so a conflicting PR doesn't just get parked
 * in review for a human when the engine could fix it itself.
 */
import { db, save, now } from './store';
import { broadcast, subscribe } from './bus';
import * as runner from './runner';
import * as github from './github';
import type { Task } from './types';

// Sent as a follow-up on the task's existing session — the same mechanism the
// board's own "Follow up" modal uses (POST /api/tasks/:id/dispatch with resume).
const CONFLICT_PROMPT =
  'GitHub reports this branch has merge conflicts with main. Resolve the conflicts: ' +
  'fetch the latest main, merge (or rebase onto) it, resolve every conflicted file, ' +
  'verify the project still builds and the test suite passes, and commit the result.';

const SWEEP_INTERVAL_MS = 60_000;

// Task ids currently on a conflict-resolution resume run, so the bus handler
// below only clears the label for runs this module itself kicked off.
const watching = new Set<string>();

function atCapacity(): boolean {
  return runner.runningCount() >= (db.settings.maxParallelSessions || 1);
}

// Once a watched task leaves `running` the resume run is over (success, failure,
// or a user stop) — the runner already moved it to review/failed/ready, so all
// that's left is dropping the "Resolving Conflicts" label.
function onBus(msg: unknown): void {
  const m = msg as { type?: string; task?: Task };
  if (m.type !== 'task' || !m.task) return;
  const task = m.task;
  if (!watching.has(task.id)) return;
  if (task.status === 'running') return; // still in flight

  watching.delete(task.id);
  if (task.resolvingConflicts) {
    task.resolvingConflicts = false;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
  }
}

subscribe(onBus);

// Resume a task's session to resolve merge conflicts with main, marking it with
// the "Resolving Conflicts" label until the run finishes. Returns false (a no-op)
// if the task is already running or has no session yet to resume.
function resolveConflicts(task: Task): boolean {
  if (runner.isRunning(task.id) || !task.sessionId) return false;

  task.resolvingConflicts = true;
  task.updatedAt = now();
  save();
  broadcast({ type: 'task', task });
  watching.add(task.id);

  try {
    runner.dispatch(task, CONFLICT_PROMPT, { resume: true });
    return true;
  } catch (e) {
    watching.delete(task.id);
    task.resolvingConflicts = false;
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    broadcast({ type: 'task', task });
    return false;
  }
}

// Periodic sweep for plain (non-autonomous) tasks: every review-column task with
// a branch gets a merge-safety check, and a conflicting one is auto-resumed.
// Runs server-side so it works whether or not a board tab is open. Guards on the
// same concurrency cap dispatch already respects, and skips anything already
// running or mid-resolve so it never double-dispatches.
async function sweep(): Promise<void> {
  if (!db.settings.autoResolveConflicts) return;
  const candidates = db.tasks.filter(
    (t) => !t.archived && t.status === 'review' && !t.resolvingConflicts && t.branch && !runner.isRunning(t.id),
  );
  for (const task of candidates) {
    if (atCapacity()) break;
    const check = await github.prCheckForTask(task);
    if (check.status === 'conflicts') resolveConflicts(task);
  }
}

function start(): void {
  // unref() so this background sweep never keeps the process (or a test's
  // server instance) alive on its own — the real app has plenty else keeping
  // it running, and tests that start/stop a server need a clean exit.
  setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS).unref();
}

export { start, sweep, resolveConflicts, CONFLICT_PROMPT };
