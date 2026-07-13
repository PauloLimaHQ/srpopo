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

// Creates a worktree with a new branch off the repo's current HEAD.
async function addWorktree(
  repoPath: string,
  taskId: string,
  slug: string,
): Promise<{ wtPath: string; branch: string }> {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const repoName = path.basename(repoPath);
  const wtPath = path.join(WORKTREES_DIR, `${repoName}--${slug}-${taskId}`);
  const branch = `srpopo/${slug}-${taskId}`;
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

export {
  isGitRepo,
  currentBranch,
  displayName,
  addWorktree,
  removeWorktree,
  worktreeStatus,
  WORKTREES_DIR,
};
