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

export { isGitRepo, currentBranch, addWorktree, removeWorktree, worktreeStatus, WORKTREES_DIR };
