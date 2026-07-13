const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKTREES_DIR = path.join(os.homedir(), '.srpopo', 'worktrees');

function git(repoPath, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoPath, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function isGitRepo(dir) {
  try {
    return (await git(dir, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function currentBranch(repoPath) {
  try {
    return await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

// Creates a worktree with a new branch off the repo's current HEAD.
async function addWorktree(repoPath, taskId, slug) {
  fs.mkdirSync(WORKTREES_DIR, { recursive: true });
  const repoName = path.basename(repoPath);
  const wtPath = path.join(WORKTREES_DIR, `${repoName}--${slug}-${taskId}`);
  const branch = `srpopo/${slug}-${taskId}`;
  await git(repoPath, ['worktree', 'add', wtPath, '-b', branch]);
  return { wtPath, branch };
}

async function removeWorktree(repoPath, wtPath) {
  await git(repoPath, ['worktree', 'remove', '--force', wtPath]);
}

async function worktreeStatus(wtPath) {
  try {
    const status = await git(wtPath, ['status', '--porcelain']);
    return { dirty: status.length > 0, files: status ? status.split('\n').length : 0 };
  } catch {
    return null;
  }
}

module.exports = { isGitRepo, currentBranch, addWorktree, removeWorktree, worktreeStatus, WORKTREES_DIR };
