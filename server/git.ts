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

// Creates a worktree with a new branch off the repo's current HEAD. `branchOverride`,
// when given, is used verbatim as the branch name (e.g. a repo's own naming
// convention, or a Linear issue identifier) instead of the auto-generated one;
// the worktree directory name is still derived from the task's slug/id so it
// stays filesystem-safe regardless of what the branch name looks like.
async function addWorktree(
  repoPath: string,
  taskId: string,
  slug: string,
  branchOverride?: string | null,
): Promise<{ wtPath: string; branch: string }> {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const repoName = path.basename(repoPath);
  const wtPath = path.join(WORKTREES_DIR, `${repoName}--${slug}-${taskId}`);
  const branch = branchOverride?.trim() || `srpopo/${slug}-${taskId}`;
  await git(repoPath, ['worktree', 'add', wtPath, '-b', branch]);
  return { wtPath, branch };
}

async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
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
  displayName,
  addWorktree,
  removeWorktree,
  worktreeStatus,
  listWorktrees,
  WORKTREES_DIR,
};
