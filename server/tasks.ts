/*
 * Task lifecycle service — the single source of truth for *creating* and
 * *dispatching* a task, shared by the REST API (server/index.ts) and the MCP
 * server (server/mcp.ts) so both entry points build tasks and spawn runs
 * identically. Keeping this here means a task queued over MCP is byte-for-byte
 * the same as one queued from the board.
 *
 * HTTP/protocol concerns (status codes, JSON-RPC shapes) stay with the callers;
 * this module only touches the store, git, and the runner.
 */
import { db, save, id, now, getRepo } from './store';
import { broadcast } from './bus';
import * as addons from './addons';
import * as personas from './personas';
import * as git from './git';
import * as runner from './runner';
import * as framing from './framing';
import type { Task } from './types';

// The user-supplied fields a new task is built from. Everything is validated /
// sanitized here, so callers can pass a raw request body straight through.
export interface CreateTaskInput {
  title?: unknown;
  prompt?: unknown;
  repoId?: unknown;
  model?: unknown;
  useWorktree?: unknown;
  permissionMode?: unknown;
  status?: unknown;
  addons?: unknown;
  personas?: unknown;
  allowedTools?: unknown;
  branchName?: unknown;
  baseBranch?: unknown;
  promptPermissions?: unknown;
}

// True once dispatched runs + grooming sessions together hit the configured cap
// — checked right before spawning a new `claude` child so a dispatch fails fast
// with a clear message instead of silently piling up and starving each run of
// CPU / hitting subscription rate limits.
export function atCapacity(): boolean {
  return runner.runningCount() >= (db.settings.maxParallelSessions || 1);
}

export function capacityError(): string {
  return `Max parallel sessions reached (${runner.runningCount()}/${db.settings.maxParallelSessions} running). ` +
    'Stop a running task or raise the limit in Settings.';
}

// Create a task in `backlog` (or `ready`), persist it, and broadcast it to every
// connected board. Throws a plain Error on invalid input; the caller maps that
// to a 4xx (REST) or a tool error (MCP).
export function createTask(input: CreateTaskInput): Task {
  const title = String(input.title ?? '').trim();
  const prompt = String(input.prompt ?? '');
  if (!title || !prompt) throw new Error('title and prompt are required');
  const repo = getRepo(String(input.repoId ?? ''));
  if (!repo) throw new Error('Unknown repo');

  const task: Task = {
    id: id(),
    title,
    prompt,
    repoId: repo.id,
    repoName: repo.name,
    repoPath: repo.path,
    addons: addons.sanitize(input.addons),
    personas: personas.sanitize(input.personas),
    attachments: [],
    useWorktree: !!input.useWorktree,
    worktreePath: null,
    branchName: input.branchName ? String(input.branchName).trim() : null,
    baseBranch: input.baseBranch ? String(input.baseBranch).trim() : null,
    branch: null,
    model: (input.model as string) || 'default',
    permissionMode: (input.permissionMode as string) || 'acceptEdits',
    allowedTools: runner.normalizeAllowedTools(input.allowedTools),
    // Ask the user to approve otherwise-denied tools instead of silently finishing
    // without running them. Defaults on; opt out for fully-unattended runs.
    promptPermissions: 'promptPermissions' in input ? !!input.promptPermissions : true,
    status: input.status === 'ready' ? 'ready' : 'backlog',
    sessionId: null,
    resolvedModel: null,
    costUsd: 0,
    numTurns: null,
    durationMs: null,
    modelUsage: {},
    runCount: 0,
    activeSubagents: 0,
    lastOutcome: null,
    lastError: null,
    resolvingConflicts: false,
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  db.tasks.push(task);
  save();
  broadcast({ type: 'task', task });
  return task;
}

// Materialize the task's worktree lazily (on first dispatch) then spawn the run.
// A `message` on a task that already has a session resumes it as a follow-up
// (`claude --resume`); otherwise the framed task prompt runs fresh. The runner
// flips the task to `running` and streams the session.
export async function dispatchTask(task: Task, message?: string | null): Promise<void> {
  if (task.useWorktree && !task.worktreePath) {
    const { wtPath, branch } = await git.addWorktree(
      task.repoPath,
      task.id,
      framing.slugify(task.title),
      task.branchName,
      task.baseBranch,
    );
    task.worktreePath = wtPath;
    task.branch = branch;
    save();
  } else if (!task.useWorktree && task.baseBranch) {
    // Direct run: put the repo on the chosen branch first, but only when it
    // isn't already there — git errors loudly (dirty tree, branch busy in
    // another worktree) rather than clobbering anything.
    const current = await git.currentBranch(task.repoPath);
    if (current !== task.baseBranch) await git.checkoutBranch(task.repoPath, task.baseBranch);
  }
  const followUp = message ? String(message) : null;
  if (followUp && task.sessionId) {
    runner.dispatch(task, followUp, { resume: true });
  } else {
    // Fresh run of the task prompt — framed (personas + prompt + add-ons +
    // attachments) the same way the autonomous engine frames it.
    runner.dispatch(task, framing.framePrompt(task), { resume: false });
  }
}
