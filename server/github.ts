/*
 * GitHub integration — surface the pull request that exists for a task's branch.
 *
 * This is a small, self-contained integration module (not a general plugin
 * framework): it mirrors the single-source-of-truth pattern of addons.ts /
 * personas.ts so a future plugin system could grow around it. All GitHub access
 * goes through the `gh` CLI (`execFile`, no shell), reusing the user's existing
 * `gh auth` — no tokens are stored and nothing leaves the machine beyond what
 * `gh` already does. Every lookup is read-only and non-throwing.
 */
import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';

import type { PrCheck, PrCheckStatus, PrInfo, Task } from './types';

const GH_TIMEOUT_MS = 30000;

// Fields we ask `gh pr list` to emit; parsePrList expects exactly these.
const PR_JSON_FIELDS = 'number,url,state,title,isDraft,updatedAt';

// Fields for the merge-safety lookup (`gh pr view <n> --json ...`); classifyPrCheck
// expects exactly these. statusCheckRollup is the flattened list of CI check runs.
const PR_CHECK_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,statusCheckRollup';

interface GhResult {
  err: ExecFileException | null;
  stdout: string;
  stderr: string;
}

// Run `gh` with an argument array (never a shell string) in the given cwd.
// Resolves — never rejects — with the raw outcome so callers can classify it.
function gh(cwd: string | undefined, args: string[]): Promise<GhResult> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: GH_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Best-effort mapping of a failed `gh` invocation to a typed reason.
function classifyError({ err, stderr }: Pick<GhResult, 'err' | 'stderr'>): string {
  if (err && err.code === 'ENOENT') return 'gh-missing';
  const msg = String(stderr || '').toLowerCase();
  if (/auth|logged in|log in|login/.test(msg)) return 'not-authed';
  if (/no git remotes|none of the git remotes|not a git repository|could not determine|no github/.test(msg)) {
    return 'not-github';
  }
  return 'error';
}

// Pure helper: normalize a raw `gh pr list --json ...` payload into our small PR
// shape, or return null for an empty/unparsable list. State is lower-cased
// (open/closed/merged); draftness is kept separately on `isDraft`.
function parsePrList(stdout: string): PrInfo | null {
  let arr: unknown;
  try {
    arr = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || !arr.length) return null;
  const pr = arr[0];
  if (!pr || typeof pr.number !== 'number') return null;
  return {
    number: pr.number,
    url: typeof pr.url === 'string' ? pr.url : '',
    title: typeof pr.title === 'string' ? pr.title : '',
    state: String(pr.state || '').toLowerCase(),
    isDraft: !!pr.isDraft,
    updatedAt: pr.updatedAt || null,
  };
}

// Merge the PR associated with a task's head branch via `gh pr merge`. Looks the
// PR up first (reusing prForTask) so the caller doesn't have to pass a number and
// an already-merged PR is a no-op. Returns a typed, non-throwing result mirroring
// prForTask; a failed merge carries the reason plus `gh`'s stderr for the UI.
async function mergePrForTask(
  task: Partial<Task>,
): Promise<{ ok: boolean; alreadyMerged?: boolean; reason?: string; message?: string }> {
  const found = await prForTask(task);
  if (!found.pr) return { ok: false, reason: found.reason || 'no-pr' };
  if (found.pr.state === 'merged') return { ok: true, alreadyMerged: true };

  const cwd = (task && (task.worktreePath || task.repoPath)) || undefined;
  const res = await gh(cwd, ['pr', 'merge', String(found.pr.number), '--merge']);
  if (res.err) return { ok: false, reason: classifyError(res), message: res.stderr.trim() || undefined };
  return { ok: true };
}

// Resolve the PR (if any) associated with a task's head branch. Returns a typed,
// non-throwing result: { pr: {...} } on success, otherwise { pr: null, reason }.
async function prForTask(task: Partial<Task>): Promise<{ pr: PrInfo | null; reason?: string }> {
  const branch = task && task.branch;
  if (!branch) return { pr: null, reason: 'no-branch' };

  const cwd = (task && (task.worktreePath || task.repoPath)) || undefined;
  const res = await gh(cwd, [
    'pr', 'list',
    '--head', branch,
    '--state', 'all',
    '--json', PR_JSON_FIELDS,
    '--limit', '1',
  ]);

  if (res.err) return { pr: null, reason: classifyError(res) };
  const pr = parsePrList(res.stdout);
  if (!pr) return { pr: null, reason: 'no-pr' };
  return { pr };
}

// Summarize a `statusCheckRollup` array into 'passing' | 'pending' | 'failing'.
// The rollup mixes two GitHub shapes: check runs ({ status, conclusion }) and the
// older commit statuses ({ state }). A repo with no CI at all yields an empty
// array, which we treat as passing ("no failing checks" counts as green).
function summarizeChecks(rollup: unknown): 'passing' | 'pending' | 'failing' {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'passing';
  let pending = false;
  for (const c of rollup) {
    const state = String((c && c.state) || '').toUpperCase();
    const status = String((c && c.status) || '').toUpperCase();
    const conclusion = String((c && c.conclusion) || '').toUpperCase();
    // Any hard failure fails the whole rollup outright.
    if (
      ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(state)
    ) {
      return 'failing';
    }
    // A check that hasn't completed (or a commit status still pending) blocks green.
    if (status && status !== 'COMPLETED') pending = true;
    else if (status === 'COMPLETED' && !conclusion) pending = true;
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(state)) pending = true;
  }
  return pending ? 'pending' : 'passing';
}

// Pure classifier: given the parsed `gh pr view --json PR_CHECK_FIELDS` object,
// decide whether the PR is safe for the autonomous engine to merge. Green means
// open, not a draft, mergeable, and no failing/pending checks; anything else is
// pending / failing / conflicts / blocked so the engine leaves the task for the
// human (or, for 'conflicts', server/conflicts.ts auto-resumes it).
function classifyPrCheck(pr: unknown): PrCheckStatus {
  if (!pr || typeof pr !== 'object') return 'no-pr';
  const p = pr as Record<string, unknown>;
  if (String(p.state || '').toUpperCase() !== 'OPEN') return 'blocked'; // merged/closed
  if (p.isDraft) return 'blocked';

  // Never merge over failing or still-running checks, regardless of mergeability.
  const checks = summarizeChecks(p.statusCheckRollup);
  if (checks === 'failing') return 'failing';
  if (checks === 'pending') return 'pending';

  const mergeable = String(p.mergeable || '').toUpperCase();
  const mergeState = String(p.mergeStateStatus || '').toUpperCase();
  // A real merge conflict with the base branch — distinct from the other blocked
  // reasons below so callers (e.g. server/conflicts.ts) can auto-resume the
  // session to resolve it, which would be pointless for a draft/closed/protected PR.
  if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') return 'conflicts';
  // Branch protection (required reviews, etc.) leaves checks green but blocks the
  // merge — hand those to the human rather than trying to force them.
  if (mergeState === 'BLOCKED' || mergeState === 'BEHIND') return 'blocked';
  // GitHub hasn't finished computing mergeability yet — treat as pending, not green.
  if (mergeable === 'UNKNOWN') return 'pending';
  if (mergeable && mergeable !== 'MERGEABLE') return 'blocked';
  return 'green';
}

// Read-only merge-safety check for a task's PR. Resolves the PR (reusing
// prForTask), then queries its state + checks via `gh pr view` and classifies it.
// Non-throwing, mirroring prForTask: a missing branch/PR is 'no-pr'; a failed `gh`
// call is 'blocked' (so the engine never merges on an inconclusive lookup).
async function prCheckForTask(task: Partial<Task>): Promise<PrCheck> {
  const found = await prForTask(task);
  if (!found.pr) return { status: 'no-pr', reason: found.reason || 'no-pr', pr: null };

  const cwd = (task && (task.worktreePath || task.repoPath)) || undefined;
  const res = await gh(cwd, ['pr', 'view', String(found.pr.number), '--json', PR_CHECK_FIELDS]);
  if (res.err) return { status: 'blocked', reason: classifyError(res), pr: found.pr };

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { status: 'blocked', reason: 'parse-error', pr: found.pr };
  }
  return { status: classifyPrCheck(parsed), pr: found.pr };
}

export {
  prForTask,
  mergePrForTask,
  prCheckForTask,
  parsePrList,
  classifyPrCheck,
  summarizeChecks,
  PR_JSON_FIELDS,
  PR_CHECK_FIELDS,
};
