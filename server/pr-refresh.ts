/*
 * Background PR-status refresh — keeps each review-column task's GitHub PR
 * status current without requiring a human to open that task's drawer first.
 * Today `GET /api/tasks/:id/pr` (server/github.ts) is only ever called lazily
 * from the client (drawer open, the manual refresh chip, or the move-to-done
 * check) — a PR merged or closed outside Sr. Popo stays looking "open" on the
 * board until someone happens to look. This runs unconditionally (unlike the
 * opt-in autoResolveConflicts sweep in conflicts.ts, which it otherwise
 * mirrors): staying honest about merge state isn't an opt-in behavior.
 *
 * A periodic, unref'd sweep checks every review-column task with a resolved
 * branch and broadcasts a `pr` bus event when the result changes, so every
 * connected board updates its cached PR chip/merge decision live — see
 * public/app.js's SSE handler and state.prByTask.
 */
import { db } from './store';
import { broadcast } from './bus';
import * as runner from './runner';
import * as github from './github';
import type { PrInfo, Task } from './types';

const SWEEP_INTERVAL_MS = 60_000;

// Last broadcast fingerprint per task, so an unchanged PR doesn't re-broadcast
// (and the board doesn't re-render) every single sweep — only real changes do.
const lastSeen = new Map<string, string>();

function fingerprint(pr: PrInfo | null, reason?: string): string {
  if (!pr) return `none:${reason || ''}`;
  return `${pr.number}:${pr.state}:${pr.isDraft}:${pr.updatedAt}`;
}

// The review-column tasks worth polling: have a branch to look up and aren't
// mid-run (a live run's own completion already refreshes the board).
function candidates(): Task[] {
  return db.tasks.filter((t) => !t.archived && t.status === 'review' && t.branch && !runner.isRunning(t.id));
}

async function sweep(): Promise<void> {
  const tasks = candidates();
  for (const task of tasks) {
    const { pr, reason } = await github.prForTask(task);
    const fp = fingerprint(pr, reason);
    if (lastSeen.get(task.id) === fp) continue;
    lastSeen.set(task.id, fp);
    broadcast({ type: 'pr', taskId: task.id, result: { pr, reason } });
  }
  // Drop bookkeeping for tasks that left `review` (moved on, archived, or
  // deleted) so this map doesn't grow unbounded over a long-running app.
  const stillEligible = new Set(tasks.map((t) => t.id));
  for (const id of lastSeen.keys()) if (!stillEligible.has(id)) lastSeen.delete(id);
}

function start(): void {
  // unref() so this background sweep never keeps the process (or a test's
  // server instance) alive on its own, mirroring conflicts.ts's sweep.
  setInterval(() => { void sweep(); }, SWEEP_INTERVAL_MS).unref();
}

export { start, sweep };
