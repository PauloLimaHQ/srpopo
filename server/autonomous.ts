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
 *
 * Review mode (opt-in per session): when enabled, the engine does more than merge
 * a green PR. It also drives tasks that sit in `review` — the ones it dispatched
 * *and* any already parked there — through an active review loop: it resumes the
 * task's session with a review prompt (bouncing it back to `running`), and when
 * that pass finishes it checks whether HEAD advanced. If the pass committed fixes
 * it reviews again (up to MAX_REVIEW_ROUNDS); once a pass makes no change the work
 * is considered clean and the normal green-only merge → done → drop-worktree flow
 * runs. Without review mode the engine keeps its original behavior: it only merges
 * an already-green PR and never resumes a task on its own.
 */
import { db, save, now, getTask, getRepo } from './store';
import { broadcast, subscribe } from './bus';
import * as runner from './runner';
import * as github from './github';
import * as git from './git';
import * as addons from './addons';
import * as framing from './framing';
import type { AutonomousStatus, AutonomousTaskView, PrCheck, Task } from './types';

// Add-ons every autonomously dispatched task must carry so its single run tests,
// self-reviews, and opens a PR the engine can then merge (see the task spec).
const REQUIRED_ADDONS = ['pull_request', 'code_review'];

// How many review passes the engine will run for a single task before it stops
// looping and falls through to the merge decision — a backstop against a model
// that keeps making trivial edits and never converges on "clean".
const MAX_REVIEW_ROUNDS = 3;

// The boundaries the loop touches. Defaults wire to the real modules; tests swap
// them for stubs so no `claude`/`gh`/git process is ever spawned.
interface Deps {
  // Prepare (worktree + framing) and spawn a fresh run. Sets status = 'running'.
  dispatch(task: Task): Promise<void>;
  // Resume a finished task's session with the review prompt. Sets status = 'running'.
  reviewDispatch(task: Task): Promise<void>;
  // Current HEAD sha in the task's working dir — how a review pass's change is detected.
  headSha(task: Task): Promise<string | null>;
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

// Default review dispatch: resume the task's existing session with the review
// prompt so the pass keeps the same worktree and context it built the change in.
async function realReviewDispatch(task: Task): Promise<void> {
  runner.dispatch(task, framing.frameReviewPrompt(task), { resume: true });
}

const defaultDeps: Deps = {
  dispatch: realDispatch,
  reviewDispatch: realReviewDispatch,
  headSha: (task) => git.headSha(task.worktreePath || task.repoPath),
  checkPr: (task) => github.prCheckForTask(task),
  merge: (task) => github.mergePrForTask(task),
  removeWorktree: (repoPath, wtPath) => git.removeWorktree(repoPath, wtPath),
  runningCount: () => runner.runningCount(),
};
let deps: Deps = defaultDeps;

interface Session {
  repoId: string;
  budgetUsd: number;
  // Opt-in: actively review + finish tasks sitting in `review` (see the header).
  reviewMode: boolean;
  startedAt: string;
  // Task ids the engine has dispatched this session (budget is summed over these).
  owned: Set<string>;
  // Subset still live (a dispatched run that hasn't reached review/done/failed).
  running: Set<string>;
  // Subset of `running` whose live run is a review pass (a resume), not a build run.
  reviewing: Set<string>;
  // Review passes run so far, per task — capped at MAX_REVIEW_ROUNDS.
  reviewRounds: Map<string, number>;
  // HEAD sha captured at the start of the in-flight review pass, per task. Compared
  // against HEAD when the pass finishes to tell "committed a fix" from "left clean".
  reviewBase: Map<string, string | null>;
  // Review tasks graded clean (or round-capped) and awaiting a merge on the next pump.
  toMerge: Set<string>;
  // Review tasks the engine is done with (merged, or handed back to the human) so
  // they're never picked up for another review pass.
  settled: Set<string>;
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

// The `review`, non-archived tasks in the session's repo that still want a review
// pass (review mode only): resumable (they have a session to continue), not already
// running, not yet settled or queued to merge, and under the per-task round cap.
// Covers both tasks the engine dispatched and ones a human already parked in review.
function eligibleReviews(): Task[] {
  if (!session || !session.reviewMode) return [];
  return db.tasks.filter(
    (t) =>
      !t.archived &&
      t.repoId === session!.repoId &&
      t.status === 'review' &&
      !!t.sessionId &&
      !session!.running.has(t.id) &&
      !session!.settled.has(t.id) &&
      !session!.toMerge.has(t.id) &&
      (session!.reviewRounds.get(t.id) || 0) < MAX_REVIEW_ROUNDS,
  );
}

// The global concurrency cap (dispatched runs + grooming) — never exceed it.
function atCapacity(): boolean {
  return deps.runningCount() >= (db.settings.maxParallelSessions || 1);
}

// Is there any run (a fresh dispatch or a review pass) the engine could start now?
function hasWork(): boolean {
  return eligible().length > 0 || eligibleReviews().length > 0;
}

// The next run to start, preferring review passes so in-flight tasks finish before
// new ones begin. Returns null when there's nothing to start.
function nextWork(): { kind: 'review' | 'dispatch'; task: Task } | null {
  const r = eligibleReviews()[0];
  if (r) return { kind: 'review', task: r };
  const d = eligible()[0];
  if (d) return { kind: 'dispatch', task: d };
  return null;
}

// True while there is more work the engine could and would start right now.
function canPumpMore(): boolean {
  return !!session && !session.stopping && spent() < session.budgetUsd && hasWork();
}

// ---------- status snapshot ----------

function taskViews(): AutonomousTaskView[] {
  if (!session) return [];
  const views: AutonomousTaskView[] = [];
  for (const id of session.owned) {
    const t = getTask(id);
    if (!t) continue;
    views.push({ id: t.id, title: t.title, status: t.status, costUsd: t.costUsd || 0, running: session.running.has(id) });
  }
  return views;
}

// The safe, UI-facing snapshot. Inactive when no session is running.
function status(): AutonomousStatus {
  if (!session) {
    return { active: false, repoId: null, repoName: null, budgetUsd: null, spentUsd: 0, reviewMode: false, startedAt: null, stopping: false, reason: lastReason, tasks: [] };
  }
  return {
    active: true,
    repoId: session.repoId,
    repoName: getRepo(session.repoId)?.name || null,
    budgetUsd: session.budgetUsd,
    spentUsd: spent(),
    reviewMode: session.reviewMode,
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

// Prepare and start one review pass: resume the task's session with the review
// prompt, bouncing it back to `running`. Ownership + the pre-pass HEAD sha are
// recorded first so budget/concurrency count it and the completion can tell a
// committed fix from a clean pass; all of it is rolled back if the resume throws.
async function startReviewPass(task: Task): Promise<void> {
  if (!session) return;
  // Unattended, and make sure the allow-list covers the fixes' edit/commit/push.
  task.promptPermissions = false;
  task.addons = addons.sanitize([...(task.addons || []), ...REQUIRED_ADDONS]);

  const before = await deps.headSha(task);
  if (!session) return; // the session may have ended while we awaited git
  session.reviewBase.set(task.id, before);
  session.reviewRounds.set(task.id, (session.reviewRounds.get(task.id) || 0) + 1);
  session.owned.add(task.id);
  session.running.add(task.id);
  session.reviewing.add(task.id);
  try {
    await deps.reviewDispatch(task);
    emit('reviewing');
  } catch (e) {
    // Couldn't resume it — hand it back to the human, still parked in review.
    session.running.delete(task.id);
    session.reviewing.delete(task.id);
    session.reviewBase.delete(task.id);
    session.settled.add(task.id);
    task.lastError = (e as Error).message;
    task.updatedAt = now();
    save();
    emit('review-error');
  }
}

// Dispatch as much work — fresh runs and review passes — as budget + concurrency
// allow, merging any approved reviews first (a merge needs no concurrency slot),
// then settle. The re-entrancy guard collapses overlapping calls (e.g. two
// completions at once) into one draining loop so we never start past the cap.
async function pump(): Promise<void> {
  if (!session) return;
  if (pumping) { pumpQueued = true; return; }
  pumping = true;
  try {
    do {
      pumpQueued = false;
      // Merge everything graded clean first — this frees the task without a slot,
      // and still runs while stopping so a green PR is merged before the session ends.
      for (const id of [...session.toMerge]) {
        session.toMerge.delete(id);
        const t = getTask(id);
        if (t && t.status === 'review' && !session.settled.has(id)) await mergeFlow(t);
        if (!session) return;
      }
      // Then start new runs up to budget + concurrency.
      while (canPumpMore() && !atCapacity()) {
        const next = nextWork();
        if (!next) break;
        if (next.kind === 'review') await startReviewPass(next.task);
        else await dispatchOne(next.task);
      }
    } while (pumpQueued && session);
  } finally {
    pumping = false;
  }
  maybeEnd();
}

// Grade a review pass that just finished: if it advanced HEAD it committed a fix,
// so review it again (until the round cap); once a pass leaves HEAD untouched the
// work is clean, so queue it to merge. Round-capped tasks fall through to merge too.
async function resolveReviewPass(task: Task): Promise<void> {
  if (!session) return;
  const before = session.reviewBase.get(task.id) ?? null;
  session.reviewBase.delete(task.id);
  const after = await deps.headSha(task);
  if (!session) return;
  const changed = !!(before && after && before !== after);
  const rounds = session.reviewRounds.get(task.id) || 0;
  if (!changed || rounds >= MAX_REVIEW_ROUNDS) {
    // Clean, or out of rounds — grade it ready to merge on the next pump.
    session.toMerge.add(task.id);
  }
  // Otherwise leave it eligible; the pump will start the next review pass.
  await pump();
}

// A task is ready for its merge decision: only if the PR is green, merge it and
// move to `done` (dropping the worktree, mirroring the existing move-to-done flow).
// Anything short of green is left in review for the human with a recorded reason.
// Either way the task is settled so the engine won't pick it up again this session.
async function mergeFlow(task: Task): Promise<void> {
  if (!session) return;
  const check = await deps.checkPr(task);
  if (!session) return;
  if (check.status === 'green') {
    const merged = await deps.merge(task);
    if (!session) return;
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
      session.settled.add(task.id);
      emit('task-merged');
    } else {
      session.settled.add(task.id);
      emit(`merge-failed:${merged.reason || 'error'}`);
    }
  } else {
    // Not safe to merge — leave it in review for the human. It stays owned so the
    // engine won't redispatch it, and its cost still counts toward the budget.
    session.settled.add(task.id);
    emit(`left-in-review:${check.status}`);
  }
}

// A dispatched (non-review-mode) run reached `review`: grade its merge and pump.
// The legacy path — a single green-only merge, no active review loop.
async function handleReview(task: Task): Promise<void> {
  await mergeFlow(task);
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
  const wasReviewPass = session.reviewing.delete(task.id);

  if (task.status === 'review') {
    if (!session.reviewMode) {
      // Legacy: grade the merge once, no active review loop.
      void handleReview(task);
    } else if (wasReviewPass) {
      // A review pass finished — decide clean-vs-changed and merge or re-review.
      void resolveReviewPass(task);
    } else {
      // A build run reached review — a pump will pick it up for its first pass.
      emit('review-queued');
      void pump();
    }
  } else if (task.status === 'failed') {
    // A failed run stays failed for the human; the engine just moves on.
    session.settled.add(task.id);
    emit('task-failed');
    void pump();
  } else {
    // Any other exit (e.g. a user stopped this task, bouncing it to ready): drop
    // ownership so budget/concurrency stay honest and it can be re-queued by hand.
    session.owned.delete(task.id);
    session.reviewRounds.delete(task.id);
    session.reviewBase.delete(task.id);
    emit('task-released');
    void pump();
  }
}

// End the session when nothing is in flight and there is nothing more to start:
// drained (no eligible tasks), budget-reached (cap hit with tasks left), or a
// user stop whose in-flight runs have now finished. Pending merges keep it alive
// (a pump clears them without a slot, so they never leave a run in flight).
function maybeEnd(): void {
  if (!session || session.running.size > 0) return;
  if (session.toMerge.size > 0) return;
  if (session.stopping) return end('stopped');
  if (!hasWork()) return end('drained');
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
async function start(
  { repoId, budgetUsd, reviewMode = false }: { repoId: string; budgetUsd: number; reviewMode?: boolean },
): Promise<AutonomousStatus> {
  if (session) throw new Error('Autonomous mode is already running');
  session = {
    repoId,
    budgetUsd,
    reviewMode: !!reviewMode,
    startedAt: now(),
    owned: new Set(),
    running: new Set(),
    reviewing: new Set(),
    reviewRounds: new Map(),
    reviewBase: new Map(),
    toMerge: new Set(),
    settled: new Set(),
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

export { start, stop, status, isActive, _setDeps, _reset, REQUIRED_ADDONS, MAX_REVIEW_ROUNDS };
