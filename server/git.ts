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

// Whether `relPath` is tracked by git in `repoPath`. Decides whether a spec
// import can point a task at the file by path: `git worktree add` only checks out
// tracked files, so a git-ignored spec (a common pattern for scratch spec dirs)
// simply won't exist in the run's worktree. False on any error, which keeps the
// caller on the safe path (inline the content) rather than referencing a file
// that may not be there.
async function isTracked(repoPath: string, relPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['ls-files', '--error-unmatch', '--', relPath]);
    return true;
  } catch {
    return false;
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

// Converts a git remote URL into its https web URL, e.g. both
// "git@github.com:anplabs/platform.git" and "https://github.com/anplabs/platform.git"
// become "https://github.com/anplabs/platform". Returns null for a remote that
// doesn't fit the host/org/repo shape (e.g. a bare local path used as a remote).
function parseRemoteWebUrl(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, '');
  const scpMatch = trimmed.match(/^[\w.-]+@([\w.-]+):(.+)$/);
  if (scpMatch) {
    const [, host, slug] = scpMatch;
    return /^[^/]+\/[^/]+$/.test(slug) ? `https://${host}/${slug}` : null;
  }
  try {
    const u = new URL(trimmed);
    const slug = u.pathname.replace(/^\/+/, '');
    return /^[^/]+\/[^/]+$/.test(slug) ? `https://${u.host}/${slug}` : null;
  } catch {
    return null;
  }
}

// The repo's `origin` remote as a browsable web URL (e.g. its GitHub repo page),
// or null with no remote or one that isn't a recognizable hosted URL.
async function remoteWebUrl(repoPath: string): Promise<string | null> {
  try {
    const url = await git(repoPath, ['remote', 'get-url', 'origin']);
    return parseRemoteWebUrl(url);
  } catch {
    return null;
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

// Whether git still tracks `wtPath` as a worktree of `repoPath` — the only
// authority on "does this worktree still exist", since the directory can
// outlive the registration (and vice versa).
async function isWorktreeRegistered(repoPath: string, wtPath: string): Promise<boolean> {
  try {
    const out = await git(repoPath, ['worktree', 'list', '--porcelain']);
    const target = path.normalize(wtPath);
    return out
      .split('\n')
      .some((line) => line.startsWith('worktree ') && path.normalize(line.slice('worktree '.length).trim()) === target);
  } catch {
    return false;
  }
}

/**
 * Drop a worktree, and report whether files were left behind on disk.
 *
 * `git worktree remove` deletes the checkout and *then* deregisters it, and it
 * deregisters even when the delete only partly succeeded — a build daemon
 * writing into the directory while git walks it (an `.nx`/`node_modules` cache
 * is the classic one), a file git can't unlink — in which case it still exits
 * non-zero with "failed to delete '<path>'". Treating that exit code as a
 * failure was wrong twice over: the worktree really is gone from git, so the
 * caller kept a `worktreePath` pointing at nothing, and the *next* attempt
 * failed differently ("is not a working tree"), which is what made the
 * Move-to-Done flow look like it was merging and removing twice.
 *
 * So: an error only counts as a failure while git still has the worktree
 * registered (locked worktree, bad path, …). Otherwise the removal stands and
 * we report `leftover: true` when the directory survived, so the caller can say
 * so rather than pretend the disk is clean.
 */
async function removeWorktree(repoPath: string, wtPath: string): Promise<{ leftover: boolean }> {
  try {
    await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
  } catch (e) {
    // Belt and braces for git versions that leave the admin entry behind when
    // the checkout is already gone; harmless when there's nothing to prune.
    await git(repoPath, ['worktree', 'prune']).catch(() => { /* best effort */ });
    if (await isWorktreeRegistered(repoPath, wtPath)) throw e;
  }
  return { leftover: fs.existsSync(wtPath) };
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

  // git always prints worktree paths with forward slashes, even on Windows
  // (its internal path representation is POSIX-style) — normalize to the
  // native separator so these compare equal to the backslash paths `path.join`
  // produces elsewhere (task.worktreePath, repo.path), or every `===` against
  // this list silently fails to match on Windows.
  const entries: { path: string; branch: string | null }[] = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: path.normalize(line.slice('worktree '.length).trim()), branch: null };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }

  const others = entries.filter((e) => e.path !== path.normalize(repoPath));
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
  isTracked,
  displayName,
  remoteWebUrl,
  addWorktree,
  removeWorktree,
  isWorktreeRegistered,
  mergeBranch,
  worktreeStatus,
  listWorktrees,
  WORKTREES_DIR,
};
