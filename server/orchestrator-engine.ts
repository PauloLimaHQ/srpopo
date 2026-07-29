/*
 * Goal Orchestration engine — the loop that keeps an orchestrator session moving.
 *
 * An orchestrator (server/orchestrator.ts, launched by runner.orchestrate) plans one
 * high-level goal for one repo, spawns worker tasks onto the board over Sr. Popo's
 * own MCP server, then ends its turn as `waiting` with the ids of the workers whose
 * results it needs. This module is what wakes it back up: it watches the SSE bus
 * and, once a watched worker lands in a terminal state (`validation` / `done` /
 * `failed` — the last one covering Autonomous Mode's merge → done transitions),
 * resumes the very same claude session with a status digest of everything it was
 * watching.
 *
 * Design mirrors server/autonomous.ts: a small in-memory engine over the bus,
 * with the heavy boundaries (spawning claude, the capacity check) behind an
 * injectable `deps` object so the decision logic is unit-testable without
 * spawning a single process. Unlike autonomous mode, the orchestrations
 * themselves ARE persisted (db.orchestrations) — only the watchers are
 * process-local, and start() re-arms them from the store on boot.
 *
 * Three backstops keep an unattended orchestrator honest:
 *   - a hard turn cap (MAX_TURNS) that fails the card rather than looping forever,
 *   - a debounce, so a burst of workers landing together produces ONE resume, and
 *   - the "never resume a session that is already running" rule (an orchestrator
 *     turn is a single claude child; a second one would be a different session).
 */
import { db, save, now, getTask, getOrchestration } from './store';
import { broadcast, subscribe } from './bus';
import * as runner from './runner';
import * as orchestrator from './orchestrator';
import type { Orchestration, Task, TaskStatus } from './types';

// Worker states that mean "this task landed and the orchestrator should look at it".
// `validation` is where a manual-mode worker parks; `done` is where Autonomous
// Mode leaves one after merging its PR; `failed` needs the orchestrator's judgment
// either way. `code_review` is deliberately NOT terminal — a worker being graded
// by the Code Review stage is still in flight, and lands in `validation` next.
const TERMINAL: TaskStatus[] = ['validation', 'done', 'failed'];

// How many turns one orchestrator session may run before the engine calls it off.
// The same philosophy as autonomous.MAX_REVIEW_ROUNDS: a model that keeps finding
// "one more thing" must not burn a subscription forever.
const MAX_TURNS = 25;

// Wait this long after a watched worker lands before resuming, so a batch that
// finishes within seconds of each other produces one status update, not five.
let debounceMs = 4000;
// Retry delay when we can't resume right now (the parallel-session cap is full,
// or the session is somehow still running).
let retryMs = 30000;

// The boundaries the engine touches. Defaults wire to the real modules; tests
// swap them for stubs so no `claude` process is ever spawned.
interface Deps {
  // Resume the orchestrator's session with a prompt. Sets status = 'running'.
  resume(orchestration: Orchestration, prompt: string): void;
  // Is this orchestration's own session live right now?
  isRunning(id: string): boolean;
  // Global concurrency cap (dispatched runs + grooming + orchestrators share the pool).
  atCapacity(): boolean;
}

const defaultDeps: Deps = {
  resume: (orchestration, prompt) => { runner.orchestrate(orchestration, { resumePrompt: prompt }); },
  isRunning: (id) => runner.isRunning(id),
  atCapacity: () => runner.runningCount() >= (db.settings.maxParallelSessions || 1),
};
let deps: Deps = defaultDeps;

// orchestrationId -> the worker task ids it is currently waiting on.
const watchers = new Map<string, Set<string>>();
// orchestrationId -> pending resume timer (also the "one queued update" guard:
// a second worker landing while one is scheduled joins that same wake-up).
const timers = new Map<string, NodeJS.Timeout>();
// orchestrationId -> landings already folded into a status update we sent, so a
// re-broadcast of the same state (or a re-arm after the turn) can't re-trigger.
// Keyed by run so a worker that is dispatched again and lands afresh does.
const reported = new Map<string, Set<string>>();

let unsubscribe: (() => void) | null = null;

function reportKey(task: Task): string {
  return `${task.id}:${task.runCount || 0}:${task.status}`;
}

function isTerminal(task: Task): boolean {
  return TERMINAL.includes(task.status);
}

// ---------- arming ----------

/**
 * Watch (or stop watching) one orchestration, from its current state. Only a
 * `waiting` card is armed; every other status means there is nothing to wake up.
 * Called on boot, on every orchestration bus event, and by the routes.
 */
function arm(orchestration: Orchestration): void {
  if (orchestration.archived || orchestration.status !== 'waiting') {
    disarm(orchestration.id);
    return;
  }
  watchers.set(orchestration.id, new Set(orchestration.watch || []));
  // A worker may have landed while the previous turn was still running (the card
  // wasn't armed then), and a `waiting` turn with an empty watch list has nothing
  // that could ever wake it — both need a wake-up scheduled right now.
  if (!orchestration.watch || !orchestration.watch.length) {
    schedule(orchestration.id, 0);
    return;
  }
  const seen = reported.get(orchestration.id);
  const missed = orchestration.watch.some((id) => {
    const task = getTask(id);
    return !!task && isTerminal(task) && !(seen && seen.has(reportKey(task)));
  });
  if (missed) schedule(orchestration.id, 0);
}

// Stop watching an orchestration, cancelling any scheduled resume. Keeps the
// `reported` set: the card may be armed again later in the same session and
// must not re-report landings the orchestrator already saw.
function disarm(id: string): void {
  watchers.delete(id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
}

// Drop every trace of an orchestration (archived or deleted) so the maps don't
// grow forever — mirrors permissions.forgetTask.
function forget(id: string): void {
  disarm(id);
  reported.delete(id);
}

function schedule(id: string, delay = debounceMs): void {
  if (timers.has(id)) return; // one queued update per orchestration
  const timer = setTimeout(() => { void fire(id); }, delay);
  // Never hold the process open just to wake an orchestrator up.
  if (typeof timer.unref === 'function') timer.unref();
  timers.set(id, timer);
}

// ---------- the resume ----------

// The turn cap tripped: end the card rather than letting it loop. Terminal, so
// the session is dropped and the watchers go with it.
function failTurnCap(orchestration: Orchestration): void {
  orchestration.status = 'failed';
  orchestration.lastOutcome = 'error';
  orchestration.lastError =
    `Stopped after ${MAX_TURNS} orchestrator turns without reaching the goal. ` +
    'Review the worker tasks it created, then start a new orchestration with a narrower goal.';
  orchestration.sessionId = null;
  orchestration.watch = [];
  orchestration.finishedAt = now();
  orchestration.updatedAt = now();
  forget(orchestration.id);
  save();
  broadcast({ type: 'orchestration', orchestration });
}

/**
 * Resume one waiting orchestration with a status digest of the workers it is
 * watching. Every guard that says "not now" reschedules rather than dropping the
 * wake-up, so a full session pool only ever delays a turn.
 */
async function fire(id: string): Promise<void> {
  timers.delete(id);
  const orchestration = getOrchestration(id);
  if (!orchestration || orchestration.archived) { forget(id); return; }
  // Only a waiting card resumes. Anything else (it started running, the user
  // stopped it, it finished) is handled by its own bus event.
  if (orchestration.status !== 'waiting') return;
  if (!watchers.has(id)) return; // disarmed while we were queued
  if (deps.isRunning(id)) { schedule(id, retryMs); return; }
  if ((orchestration.turnCount || 0) >= MAX_TURNS) { failTurnCap(orchestration); return; }
  if (deps.atCapacity()) { schedule(id, retryMs); return; }

  const watched = (orchestration.watch || [])
    .map((taskId) => getTask(taskId))
    .filter((t): t is Task => !!t);
  // Everything terminal we're about to tell the orchestrator about counts as
  // reported, so re-arming after this turn doesn't wake it up for the same
  // landing again.
  const seen = reported.get(id) || new Set<string>();
  reported.set(id, seen);
  for (const task of watched) {
    if (isTerminal(task)) seen.add(reportKey(task));
  }

  const prompt = (orchestration.watch || []).length
    ? orchestrator.statusPrompt(orchestration, watched)
    : orchestrator.nudgePrompt(orchestration.mode);

  try {
    deps.resume(orchestration, prompt);
  } catch (e) {
    // Couldn't spawn the turn (e.g. the session is mid-exit). Leave the card
    // waiting and try again shortly — never lose the wake-up.
    console.warn('[orchestrator] could not resume orchestration:', (e as Error).message);
    schedule(id, retryMs);
  }
}

// ---------- the bus ----------

// React to bus traffic. Two jobs, both cheap:
//  - an orchestration changing state (re)arms or disarms its watchers, which is
//    also how a turn ending in `waiting` starts the next watch cycle, and
//  - a watched worker reaching a terminal state schedules the resume.
function onBus(msg: unknown): void {
  const m = msg as { type?: string; task?: Task; orchestration?: Orchestration; orchestrationId?: string };
  if (m.type === 'orchestration' && m.orchestration) {
    arm(m.orchestration);
    return;
  }
  if (m.type === 'orchestration-removed' && m.orchestrationId) {
    forget(m.orchestrationId);
    return;
  }
  if (m.type !== 'task' || !m.task) return;
  const task = m.task;
  if (!isTerminal(task)) return;
  const key = reportKey(task);
  for (const [id, watched] of watchers) {
    if (!watched.has(task.id)) continue;
    const seen = reported.get(id);
    if (seen && seen.has(key)) continue; // already folded into a status update
    schedule(id);
  }
}

/**
 * Start the engine: subscribe to the bus and re-arm every `waiting`
 * orchestration from the store. Called once on server boot — orchestrations
 * persist across restarts, so a card left waiting keeps its resumable session
 * and simply picks its watchers back up here.
 */
function start(): void {
  // Subscribe once (a second call must not double-handle every event), but
  // always re-arm: start() is also how the store's current state is picked up.
  if (!unsubscribe) unsubscribe = subscribe(onBus);
  for (const orchestration of db.orchestrations) {
    if (!orchestration.archived && orchestration.status === 'waiting') arm(orchestration);
  }
}

function stop(): void {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  for (const id of [...timers.keys()]) disarm(id);
  watchers.clear();
}

// True while this orchestration's watchers are armed (used by the tests and the
// stop route to tell "the engine holds it" from "nothing is watching").
function isWatching(id: string): boolean {
  return watchers.has(id);
}

// Test seams, mirroring autonomous._setDeps/_reset.
function _setDeps(overrides: Partial<Deps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

function _reset(): void {
  stop();
  reported.clear();
  deps = defaultDeps;
  debounceMs = 4000;
  retryMs = 30000;
}

// Test seam: collapse the debounce/retry delays so a case doesn't wait seconds.
function _setTiming(next: { debounceMs?: number; retryMs?: number }): void {
  if (typeof next.debounceMs === 'number') debounceMs = next.debounceMs;
  if (typeof next.retryMs === 'number') retryMs = next.retryMs;
}

export { start, stop, arm, disarm, forget, isWatching, MAX_TURNS, _setDeps, _reset, _setTiming };
