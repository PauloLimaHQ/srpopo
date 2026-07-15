import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const WORKTREES_DIR = path.join(os.homedir(), '.srpopo', 'worktrees');

function git(repoPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function currentBranch(repoPath: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

// The full commit SHA at HEAD in a working directory (a repo or a worktree), or
// null if it can't be read. The autonomous review loop uses it to tell whether a
// review pass actually committed a change (HEAD advanced) or left the branch as-is.
async function headSha(repoPath: string): Promise<string | null> {
  try {
    return await git(repoPath, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

// Extracts the "org/repo" slug from a git remote URL, e.g.
// "git@github.com:anplabs/platform.git" or "https://github.com/anplabs/platform"
// both become "anplabs/platform". Returns null for URLs that don't fit the
// host/org/repo shape (e.g. a bare local path used as a remote).
function parseRemoteSlug(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scpMatch = trimmed.match(/^[\w.-]+@[\w.-]+:(.+)$/);
  const pathname = scpMatch
    ? scpMatch[1]
    : (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return null;
        }
      })();
  if (!pathname) return null;
  const slug = pathname.replace(/^\/+/, '');
  return /^[^/]+\/[^/]+$/.test(slug) ? slug : null;
}

// Best-effort "org/repo" label for a repo, read from its `origin` remote so the
// board can tell same-named repos from different orgs apart. Falls back to the
// directory name when there's no remote or it isn't a recognizable host URL.
async function displayName(repoPath: string): Promise<string> {
  try {
    const url = await git(repoPath, ['remote', 'get-url', 'origin']);
    return parseRemoteSlug(url) || path.basename(repoPath);
  } catch {
    return path.basename(repoPath);
  }
}

// Lists the repo's local branches (sorted most-recently-committed first) plus
// whichever one is currently checked out, so the UI can offer a base-branch
// picker. Returns empty/null on any git failure rather than throwing.
async function listBranches(repoPath: string): Promise<{ current: string | null; branches: string[] }> {
  let branches: string[] = [];
  try {
    const out = await git(repoPath, [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      'refs/heads',
    ]);
    branches = out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    branches = [];
  }
  return { current: await currentBranch(repoPath), branches };
}

// Creates a new branch off `from` (defaulting to the repo's current HEAD) and
// checks it out in the repo, so the user can spin up a fresh branch from the
// board. `git checkout -b` fails loudly if the name already exists or the tree
// can't be switched, and the caller surfaces that message verbatim. Returns the
// resulting current branch so the caller can refresh its snapshot.
async function createBranch(repoPath: string, name: string, from?: string | null): Promise<string | null> {
  const branch = name.trim();
  if (!branch) throw new Error('Branch name is required');
  const args = ['checkout', '-b', branch];
  if (from?.trim()) args.push(from.trim());
  await git(repoPath, args);
  return currentBranch(repoPath);
}

// Checks out an existing branch in the repo itself (used for non-worktree tasks
// that should run against a specific branch). Fails loudly if the working tree
// is dirty in a way git won't carry over, or the branch is already checked out
// in another worktree — the caller surfaces the message.
async function checkoutBranch(repoPath: string, name: string): Promise<string | null> {
  const branch = name.trim();
  if (!branch) throw new Error('Branch name is required');
  await git(repoPath, ['checkout', branch]);
  return currentBranch(repoPath);
}

// Creates a worktree with a new branch. Without `baseBranch` the branch is cut
// from the repo's current HEAD (historical behavior); with it, from that branch
// instead — so a task can be based on a branch other than whatever the repo
// happens to have checked out. `branchOverride`, when given, is used verbatim as
// the branch name (e.g. a repo's own naming convention, or a Linear issue
// identifier) instead of the auto-generated one; the worktree directory name is
// still derived from the task's slug/id so it stays filesystem-safe regardless
// of what the branch name looks like.
async function addWorktree(
  repoPath: string,
  taskId: string,
  slug: string,
  branchOverride?: string | null,
  baseBranch?: string | null,
): Promise<{ wtPath: string; branch: string }> {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const repoName = path.basename(repoPath);
  const wtPath = path.join(WORKTREES_DIR, `${repoName}--${slug}-${taskId}`);
  const branch = branchOverride?.trim() || `srpopo/${slug}-${taskId}`;
  const args = ['worktree', 'add', wtPath, '-b', branch];
  if (baseBranch?.trim()) args.push(baseBranch.trim());
  await git(repoPath, args);
  return { wtPath, branch };
}

async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
}

// Merges `branch` straight into `baseBranch` inside `repoPath` with a plain
// `git merge` — no PR, no `gh`. Always runs in `repoPath` (the repo's primary
// clone), never a worktree: `branch` is checked out live in its own worktree,
// and `baseBranch` is normally what's left checked out in `repoPath` (the
// state `git worktree add` leaves behind), so `repoPath` is the only working
// directory that can actually check out `baseBranch` and receive the merge —
// same convention as the direct-run branch switch in `tasks.dispatchTask`.
// Throws loudly on a dirty tree, like `checkoutBranch`/`createBranch`. On a
// real merge conflict, aborts the half-finished merge before rethrowing so
// `repoPath` is left clean on `baseBranch` rather than stuck mid-merge.
async function mergeBranch(repoPath: string, baseBranch: string, branch: string): Promise<void> {
  const current = await currentBranch(repoPath);
  if (current !== baseBranch) await git(repoPath, ['checkout', baseBranch]);
  try {
    await git(repoPath, ['merge', '--no-edit', branch]);
  } catch (e) {
    await git(repoPath, ['merge', '--abort']).catch(() => {});
    throw e;
  }
}

async function worktreeStatus(wtPath: string): Promise<{ dirty: boolean; files: number } | null> {
  try {
    const status = await git(wtPath, ['status', '--porcelain']);
    return { dirty: status.length > 0, files: status ? status.split('\n').length : 0 };
  } catch {
    return null;
  }
}

// Lists every worktree `git worktree list` knows about for a repo, except the
// main one (whose path is the repo itself) — ground truth for what's actually
// checked out on disk, since a task's own `worktreePath` can go stale (removed
// externally, etc.). Each entry is annotated with its dirty/file-count status.
async function listWorktrees(repoPath: string): Promise<{ path: string; branch: string | null; dirty: boolean; files: number }[]> {
  let out: string;
  try {
    out = await git(repoPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }

  const entries: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }

  const others = entries.filter((e) => e.path !== repoPath);
  const results = [];
  for (const e of others) {
    const status = await worktreeStatus(e.path);
    results.push({ path: e.path, branch: e.branch, dirty: status?.dirty ?? false, files: status?.files ?? 0 });
  }
  return results;
}

export {
  isGitRepo,
  currentBranch,
  listBranches,
  createBranch,
  checkoutBranch,
  headSha,
  displayName,
  addWorktree,
  removeWorktree,
  mergeBranch,
  worktreeStatus,
  listWorktrees,
  WORKTREES_DIR,
};
