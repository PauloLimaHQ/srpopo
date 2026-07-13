/*
 * GitHub integration — surface the pull request that exists for a task's branch.
 *
 * This is a small, self-contained integration module (not a general plugin
 * framework): it mirrors the single-source-of-truth pattern of addons.js /
 * personas.js so a future plugin system could grow around it. All GitHub access
 * goes through the `gh` CLI (`execFile`, no shell), reusing the user's existing
 * `gh auth` — no tokens are stored and nothing leaves the machine beyond what
 * `gh` already does. Every lookup is read-only and non-throwing.
 */
const { execFile } = require('child_process');

const GH_TIMEOUT_MS = 30000;

// Fields we ask `gh pr list` to emit; parsePrList expects exactly these.
const PR_JSON_FIELDS = 'number,url,state,title,isDraft,updatedAt';

// Run `gh` with an argument array (never a shell string) in the given cwd.
// Resolves — never rejects — with the raw outcome so callers can classify it.
function gh(cwd, args) {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, timeout: GH_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Best-effort mapping of a failed `gh` invocation to a typed reason.
function classifyError({ err, stderr }) {
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
function parsePrList(stdout) {
  let arr;
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

// Resolve the PR (if any) associated with a task's head branch. Returns a typed,
// non-throwing result: { pr: {...} } on success, otherwise { pr: null, reason }.
async function prForTask(task) {
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

module.exports = { prForTask, parsePrList, PR_JSON_FIELDS };
